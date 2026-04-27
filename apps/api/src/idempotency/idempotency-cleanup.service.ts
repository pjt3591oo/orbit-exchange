import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Reaps expired IdempotencyKey rows (ADR-0003 §D2). The cache window is
 * 24h; we sweep every 5 minutes so the table never grows unboundedly.
 *
 * Cleanup uses a fixed batch size to avoid a single multi-million-row
 * DELETE. If a sweep doesn't fully drain the backlog, the next tick picks
 * up where it left off.
 */
@Injectable()
export class IdempotencyCleanupService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(IdempotencyCleanupService.name);
  private static readonly INTERVAL_MS = 5 * 60 * 1000;
  private static readonly BATCH_SIZE = 1_000;
  private timer?: NodeJS.Timeout;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    // First run after the interval — no need to spam DB on every restart.
    this.timer = setInterval(() => {
      void this.sweep();
    }, IdempotencyCleanupService.INTERVAL_MS);
    this.timer.unref();
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Exposed for tests. */
  async sweep(): Promise<number> {
    try {
      // Postgres doesn't accept LIMIT on DELETE directly; use the IN-subquery
      // pattern. ctid keeps it index-free fast on the (expiresAt) index.
      const result = await this.prisma.$executeRaw`
        DELETE FROM "IdempotencyKey"
        WHERE id IN (
          SELECT id FROM "IdempotencyKey"
          WHERE "expiresAt" < NOW()
          LIMIT ${IdempotencyCleanupService.BATCH_SIZE}
        )
      `;
      if (result > 0) {
        this.log.debug(`cleaned ${result} expired idempotency keys`);
      }
      return result;
    } catch (err) {
      this.log.error(`cleanup failed: ${(err as Error).message}`);
      return 0;
    }
  }
}
