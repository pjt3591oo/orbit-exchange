import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * /api/v1/admin/outbox/* — operator surface for the OutboxEvent table
 * (ADR-0002). Supports inspection of pending / failed / processed rows
 * and two manual interventions:
 *
 *   retry(id)  — clear attempts + lastError so the relay picks it up
 *                cleanly on the next tick. Use when the original failure
 *                is fixed (broker recovered, schema migrated, etc).
 *
 *   skip(id)   — flag a row as processedAt=NOW WITHOUT publishing.
 *                Permanent decision: the message will never reach Kafka,
 *                downstream consumers won't see it. Emergency-only —
 *                e.g. when the row's payload is corrupt and would poison
 *                whoever receives it.
 *
 * Stats tab feeds the dashboard top-of-page summary.
 */
@Injectable()
export class AdminOutboxService {
  private readonly log = new Logger(AdminOutboxService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * List with filters. Default: unprocessed rows (most operationally
   * relevant) ordered by createdAt asc — oldest first, matching the
   * relay's own polling order.
   */
  async list(opts: {
    status?: 'pending' | 'processed' | 'failed' | 'all';
    topic?: string;
    take?: number;
    cursor?: string;
  }) {
    const where: Prisma.OutboxEventWhereInput = {};
    const status = opts.status ?? 'pending';
    if (status === 'pending') where.processedAt = null;
    else if (status === 'processed') where.processedAt = { not: null };
    else if (status === 'failed') {
      where.processedAt = null;
      where.attempts = { gt: 0 };
    }
    if (opts.topic) where.topic = opts.topic;

    const take = Math.min(opts.take ?? 50, 200);
    const orderBy: Prisma.OutboxEventOrderByWithRelationInput =
      status === 'processed' ? { id: 'desc' } : { id: 'asc' };

    const rows = await this.prisma.outboxEvent.findMany({
      where,
      orderBy,
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
    const row = await this.prisma.outboxEvent.findUnique({
      where: { id: BigInt(id) },
    });
    if (!row) throw new NotFoundException('outbox event not found');
    return this.presentDetail(row);
  }

  /**
   * Aggregates the same numbers the Grafana panels show, but on demand
   * for the SPA top-of-page summary. We use a single SQL CTE so we don't
   * round-trip the DB three times.
   */
  async stats() {
    type Row = {
      pending_total: bigint;
      pending_failed: bigint;
      oldest_seconds: number | null;
      processed_24h: bigint;
    };
    const [row] = await this.prisma.$queryRaw<Row[]>`
      SELECT
        COUNT(*) FILTER (WHERE "processedAt" IS NULL)::bigint AS pending_total,
        COUNT(*) FILTER (WHERE "processedAt" IS NULL AND "attempts" > 0)::bigint AS pending_failed,
        EXTRACT(EPOCH FROM (NOW() - MIN("createdAt") FILTER (WHERE "processedAt" IS NULL)))::float8 AS oldest_seconds,
        COUNT(*) FILTER (WHERE "processedAt" >= NOW() - INTERVAL '24 hours')::bigint AS processed_24h
      FROM "OutboxEvent"
    `;

    // Per-topic pending breakdown — useful for "which producer is stuck?"
    type TopicRow = { topic: string; pending: bigint; oldest_seconds: number | null };
    const perTopic = await this.prisma.$queryRaw<TopicRow[]>`
      SELECT
        topic,
        COUNT(*)::bigint AS pending,
        EXTRACT(EPOCH FROM (NOW() - MIN("createdAt")))::float8 AS oldest_seconds
      FROM "OutboxEvent"
      WHERE "processedAt" IS NULL
      GROUP BY topic
      ORDER BY oldest_seconds DESC NULLS LAST
    `;

    return {
      pendingTotal: Number(row?.pending_total ?? 0),
      pendingFailed: Number(row?.pending_failed ?? 0),
      oldestPendingAgeSec: row?.oldest_seconds ?? 0,
      processedLast24h: Number(row?.processed_24h ?? 0),
      perTopic: perTopic.map((t) => ({
        topic: t.topic,
        pending: Number(t.pending),
        oldestAgeSec: t.oldest_seconds ?? 0,
      })),
    };
  }

  /**
   * Reset attempts + lastError on a stuck row so the relay treats it as
   * fresh on the next poll. We do NOT change processedAt — the row stays
   * pending (NULL) and will be re-attempted normally.
   *
   * Refusing to retry a row that's already processed (processedAt set)
   * — that would re-publish a message that downstream consumers already
   * saw, breaking the at-most-once side of effectively-once.
   */
  async retry(id: string, _adminSub: string) {
    const row = await this.prisma.outboxEvent.findUnique({
      where: { id: BigInt(id) },
    });
    if (!row) throw new NotFoundException('outbox event not found');
    if (row.processedAt) {
      throw new BadRequestException(
        `row already processed at ${row.processedAt.toISOString()} — replay would double-deliver`,
      );
    }
    const updated = await this.prisma.outboxEvent.update({
      where: { id: row.id },
      data: { attempts: 0, lastError: null },
    });
    this.log.log(
      `outbox retry — id=${id} topic=${row.topic} previous attempts=${row.attempts}`,
    );
    return {
      id: updated.id.toString(),
      action: 'retry-armed' as const,
      previousAttempts: row.attempts,
      previousLastError: row.lastError,
    };
  }

  /**
   * Force-mark as processed without publishing. Permanent data drop —
   * the SUBMIT command / TRADE event / etc. carried by this row will
   * never reach the matcher / consumers. Use only when:
   *   - The row's payload is genuinely corrupt and would poison consumers
   *   - The downstream effect has been manually reconciled
   *   - The data is otherwise non-actionable (e.g. a test row)
   *
   * Required: reason from the admin (validated by AdminAuditInterceptor's
   * reasonRequired:true).
   */
  async skip(id: string, _adminSub: string) {
    const row = await this.prisma.outboxEvent.findUnique({
      where: { id: BigInt(id) },
    });
    if (!row) throw new NotFoundException('outbox event not found');
    if (row.processedAt) {
      throw new BadRequestException(
        `row already processed at ${row.processedAt.toISOString()}`,
      );
    }
    const updated = await this.prisma.outboxEvent.update({
      where: { id: row.id },
      data: {
        processedAt: new Date(),
        // Mark the lastError so the audit trail shows it was a forced skip,
        // not a successful publish (the relay would never set lastError).
        lastError: 'SKIPPED BY ADMIN — see AdminAuditLog for reason',
      },
    });
    this.log.warn(
      `outbox FORCE-SKIP — id=${id} topic=${row.topic} key=${row.key} attempts=${row.attempts}`,
    );
    return {
      id: updated.id.toString(),
      action: 'skipped' as const,
      topic: row.topic,
      key: row.key,
    };
  }

  /* ───────────────── presenters ───────────────── */

  private presentSummary(r: {
    id: bigint;
    topic: string;
    key: string;
    createdAt: Date;
    processedAt: Date | null;
    attempts: number;
    lastError: string | null;
  }) {
    return {
      id: r.id.toString(),
      topic: r.topic,
      key: r.key,
      createdAt: r.createdAt.toISOString(),
      processedAt: r.processedAt?.toISOString() ?? null,
      attempts: r.attempts,
      lastError: r.lastError,
      ageSec: Math.floor((Date.now() - r.createdAt.getTime()) / 1000),
    };
  }

  private presentDetail(r: {
    id: bigint;
    topic: string;
    key: string;
    payload: unknown;
    headers: unknown;
    createdAt: Date;
    processedAt: Date | null;
    attempts: number;
    lastError: string | null;
  }) {
    return {
      ...this.presentSummary(r),
      payload: r.payload,
      headers: r.headers,
    };
  }
}
