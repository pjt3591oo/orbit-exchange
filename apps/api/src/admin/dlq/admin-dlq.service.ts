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
    resolved?: 'true' | 'false' | 'all';
    worker?: string;
    originalTopic?: string;
    take?: number;
    cursor?: string;
  }) {
    const where: Prisma.DlqEventWhereInput = {};
    if (opts.resolved === 'true') where.resolvedAt = { not: null };
    else if (!opts.resolved || opts.resolved === 'false') where.resolvedAt = null;
    if (opts.worker) where.worker = opts.worker;
    if (opts.originalTopic) where.originalTopic = opts.originalTopic;

    const take = Math.min(opts.take ?? 50, 200);
    const rows = await this.prisma.dlqEvent.findMany({
      where,
      orderBy: { id: 'desc' },
      take: take + 1,
      ...(opts.cursor && { cursor: { id: BigInt(opts.cursor) }, skip: 1 }),
    });
    const hasMore = rows.length > take;
    const items = hasMore ? rows.slice(0, take) : rows;
    return {
      items: items.map((r) => this.presentSummary(r)),
      nextCursor: hasMore ? items[items.length - 1].id.toString() : null,
    };
  }

  async detail(id: string) {
    const row = await this.prisma.dlqEvent.findUnique({ where: { id: BigInt(id) } });
    if (!row) throw new NotFoundException('dlq event not found');
    return this.presentDetail(row);
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

  private presentSummary(r: {
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
  }) {
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
    };
  }

  private presentDetail(r: {
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
  }) {
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
      ...this.presentSummary(r),
      payloadText,
      payloadJson,
      payloadBytes: r.payload.length,
      headers: r.headers,
    };
  }
}
