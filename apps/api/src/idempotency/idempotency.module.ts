import { Global, Module } from '@nestjs/common';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import { IdempotencyCleanupService } from './idempotency-cleanup.service';

/**
 * Holds the IdempotencyInterceptor (per-request) and the cleanup background
 * task. Global so any controller can `@UseInterceptors(IdempotencyInterceptor)`
 * without re-importing.
 */
@Global()
@Module({
  providers: [IdempotencyInterceptor, IdempotencyCleanupService],
  exports: [IdempotencyInterceptor],
})
export class IdempotencyModule {}
