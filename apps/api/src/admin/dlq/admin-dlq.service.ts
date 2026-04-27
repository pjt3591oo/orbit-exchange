import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CompressionTypes } from 'kafkajs';
import { PrismaService } from '../../prisma/prisma.service';
import { KafkaProducerService } from '../../kafka/kafka-producer.service';

/**
 * ADR-0004 §D6 — DLQ admin operations.
 *
 *   list({ resolved, worker, ... })   — paginated table for the SPA
 *   detail(id)                        — full payload (decoded as utf-8 if possible)
 *   replay(id, adminSub)              — republish original payload to original topic + mark resolved
 *   dismiss(id, adminSub)             — mark resolved without replay
 *
 * The audit interceptor captures the @AdminAction on the controller so we
 * don't need to write to AdminAuditLog ourselves — controller decorator
 * does it after the method returns.
 */
@Injectable()
export class AdminDlqService {
  private readonly log = new Logger(AdminDlqService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly kafka: KafkaProducerService,
  ) {}

  async list(opts: {
    /**
     * 4-way filter mirroring the row status the SPA renders.
     *   pending          → resolvedAt IS NULL
     *   replayed-success → resolution='replayed' AND no descendant DlqEvent
     *   replayed-failed  → resolution='replayed' AND descendant exists
     *                      (the replay landed back in DLQ via dlq-monitor)
     *   dismissed        → resolution='dismissed'
     *   all              → no status filter
     *
     * Default is `pending` because that's the only state that needs an
     * operator decision.
     */
    status?: 'pending' | 'replayed-success' | 'replayed-failed' | 'dismissed' | 'all';
    worker?: string;
    originalTopic?: string;
    take?: number;
    cursor?: string;
  }) {
    const where: Prisma.DlqEventWhereInput = {};
    const status = opts.status ?? 'pending';

    // The simple buckets translate to a plain Prisma `where`. The two
    // replayed-* buckets need an EXISTS / NOT EXISTS subquery on the
    // self-table — we fold that in at the SQL layer below for those
    // buckets only.
    if (status === 'pending') where.resolvedAt = null;
    else if (status === 'dismissed') where.resolution = 'dismissed';
    else if (status === 'replayed-success' || status === 'replayed-failed') {
      where.resolution = 'replayed';
    }
    // status === 'all' → no filter on resolution / resolvedAt
    if (opts.worker) where.worker = opts.worker;
    if (opts.originalTopic) where.originalTopic = opts.originalTopic;

    const take = Math.min(opts.take ?? 50, 200);

    let rows = await this.prisma.dlqEvent.findMany({
      where,
      orderBy: { id: 'desc' },
      take: take + 1,
      ...(opts.cursor && { cursor: { id: BigInt(opts.cursor) }, skip: 1 }),
    });

    // For the replayed-success / replayed-failed split we filter
    // post-query using the descendant-existence map we'd compute anyway
    // for `replayChainNextId`. This keeps the Prisma query simple and
    // re-uses the same indexed subquery we already do downstream.
    if (status === 'replayed-success' || status === 'replayed-failed') {
      const ids = rows.map((r) => r.id);
      type ChainRow = { replayedFromId: bigint };
      const chains: ChainRow[] = ids.length
        ? await this.prisma.$queryRaw<ChainRow[]>`
            SELECT DISTINCT "replayedFromId"
            FROM "DlqEvent"
            WHERE "replayedFromId" IN (${Prisma.join(ids)})
          `
        : [];
      const hasDescendant = new Set(chains.map((c) => c.replayedFromId.toString()));
      rows = rows.filter((r) =>
        status === 'replayed-failed'
          ? hasDescendant.has(r.id.toString())
          : !hasDescendant.has(r.id.toString()),
      );
    }

    const hasMore = rows.length > take;
    const items = hasMore ? rows.slice(0, take) : rows;

    // Compute the replay-chain badge for each row in one shot:
    //   "did anyone create a NEW DlqEvent whose replayedFromId == this id?"
    // This avoids N+1 queries while keeping the index `(replayedFromId)`
    // happy. We only care about it for resolution='replayed' rows but
    // querying for all is cheap and uniform.
    const ids = items.map((r) => r.id);
    type ChainRow = { replayedFromId: bigint; descendantId: bigint };
    const chains: ChainRow[] = ids.length
      ? await this.prisma.$queryRaw<ChainRow[]>`
          SELECT DISTINCT ON ("replayedFromId")
            "replayedFromId", id AS "descendantId"
          FROM "DlqEvent"
          WHERE "replayedFromId" IN (${Prisma.join(ids)})
          ORDER BY "replayedFromId", id ASC
        `
      : [];
    const chainMap = new Map<string, string>();
    for (const c of chains) {
      chainMap.set(c.replayedFromId.toString(), c.descendantId.toString());
    }

    return {
      items: items.map((r) =>
        this.presentSummary(r, chainMap.get(r.id.toString()) ?? null),
      ),
      nextCursor: hasMore ? items[items.length - 1].id.toString() : null,
    };
  }

  async detail(id: string) {
    const row = await this.prisma.dlqEvent.findUnique({ where: { id: BigInt(id) } });
    if (!row) throw new NotFoundException('dlq event not found');
    // Detail view shows the same chain badge — find the first descendant
    // (a DlqEvent with replayedFromId = this.id) if any.
    const descendant = await this.prisma.dlqEvent.findFirst({
      where: { replayedFromId: row.id },
      orderBy: { id: 'asc' },
      select: { id: true },
    });
    return this.presentDetail(row, descendant?.id.toString() ?? null);
  }

  /**
   * Replay = republish the original payload to its original topic so the
   * normal consumer gets another chance. We strip withRetryPolicy headers
   * (so the attempt counter resets to 0) but preserve `traceparent` for
   * trace continuity.
   */
  async replay(id: string, adminSub: string) {
    const row = await this.prisma.dlqEvent.findUnique({ where: { id: BigInt(id) } });
    if (!row) throw new NotFoundException('dlq event not found');
    if (row.resolvedAt) {
      throw new BadRequestException(`already ${row.resolution} at ${row.resolvedAt.toISOString()}`);
    }

    const headers = (row.headers ?? {}) as Record<string, string>;
    const traceparent = headers['traceparent'];
    const cleanHeaders: Record<string, string> = {};
    if (traceparent) cleanHeaders['traceparent'] = traceparent;
    // Lineage marker — if this republished message ends up back in DLQ,
    // dlq-monitor reads this and stores `replayedFromId = row.id` on the
    // new DlqEvent. The admin UI uses that link to show "replay 성공"
    // vs "replay → 재실패" instead of just "replayed".
    cleanHeaders['x-orbit-replay-of'] = row.id.toString();

    // Use the producer directly — DLQ replay isn't a transactional outbox
    // case, the row is already committed durably; we just need it back on
    // its original topic. If publish fails, the DlqEvent stays unresolved
    // and the admin can retry.
    const producer = this.kafka.getRawProducer();
    if (!producer) throw new BadRequestException('kafka producer not ready');
    await producer.send({
      topic: row.originalTopic,
      compression: CompressionTypes.GZIP,
      messages: [
        {
          // We don't have the original key in the row (it was the partition
          // key, not stored separately). Fall back to the originalOffset —
          // not perfectly partition-stable but rare enough.
          key: headers['x-orbit-original-key'] ?? row.originalOffset,
          value: row.payload,
          headers: cleanHeaders,
        },
      ],
    });

    await this.prisma.dlqEvent.update({
      where: { id: row.id },
      data: {
        resolvedAt: new Date(),
        resolution: 'replayed',
        resolvedBy: adminSub,
      },
    });

    return {
      id: row.id.toString(),
      action: 'replayed' as const,
      republishedTo: row.originalTopic,
    };
  }

  async dismiss(id: string, adminSub: string) {
    const row = await this.prisma.dlqEvent.findUnique({ where: { id: BigInt(id) } });
    if (!row) throw new NotFoundException('dlq event not found');
    if (row.resolvedAt) {
      throw new BadRequestException(`already ${row.resolution} at ${row.resolvedAt.toISOString()}`);
    }
    await this.prisma.dlqEvent.update({
      where: { id: row.id },
      data: {
        resolvedAt: new Date(),
        resolution: 'dismissed',
        resolvedBy: adminSub,
      },
    });
    return { id: row.id.toString(), action: 'dismissed' as const };
  }

  /* ───────────────── presenters ───────────────── */

  private presentSummary(
    r: {
      id: bigint;
      originalTopic: string;
      originalPartition: number;
      originalOffset: string;
      worker: string;
      lastError: string;
      attempt: number;
      enqueuedAt: Date;
      resolvedAt: Date | null;
      resolution: string | null;
      resolvedBy: string | null;
      replayedFromId: bigint | null;
    },
    /** id of the FIRST DlqEvent that lists this row as `replayedFromId`,
     *  meaning a replay of this row failed and produced that new row.
     *  null = either not replayed yet, or replay succeeded. */
    replayChainNextId: string | null,
  ) {
    return {
      id: r.id.toString(),
      originalTopic: r.originalTopic,
      originalPartition: r.originalPartition,
      originalOffset: r.originalOffset,
      worker: r.worker,
      lastError: r.lastError,
      attempt: r.attempt,
      enqueuedAt: r.enqueuedAt.toISOString(),
      resolvedAt: r.resolvedAt?.toISOString() ?? null,
      resolution: r.resolution,
      resolvedBy: r.resolvedBy,
      replayedFromId: r.replayedFromId?.toString() ?? null,
      replayChainNextId,
    };
  }

  private presentDetail(
    r: {
      id: bigint;
      originalTopic: string;
      originalPartition: number;
      originalOffset: string;
      payload: Buffer;
      headers: unknown;
      worker: string;
      lastError: string;
      attempt: number;
      enqueuedAt: Date;
      resolvedAt: Date | null;
      resolution: string | null;
      resolvedBy: string | null;
      replayedFromId: bigint | null;
    },
    replayChainNextId: string | null,
  ) {
    let payloadText: string | null = null;
    let payloadJson: unknown = null;
    try {
      payloadText = r.payload.toString('utf-8');
      try {
        payloadJson = JSON.parse(payloadText);
      } catch {
        // not JSON — leave parsed null
      }
    } catch {
      payloadText = null;
    }
    return {
      ...this.presentSummary(r, replayChainNextId),
      payloadText,
      payloadJson,
      payloadBytes: r.payload.length,
      headers: r.headers,
    };
  }
}
