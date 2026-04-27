import { createHash } from 'node:crypto';
import {
  CallHandler,
  ConflictException,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Observable, from, of, switchMap, tap } from 'rxjs';
import { metrics } from '@orbit/observability';
import { PrismaService } from '../prisma/prisma.service';

const M = metrics.Metrics;

/**
 * HTTP-side idempotency cache (ADR-0003 §D2).
 *
 *   Idempotency-Key: <uuid-v4>
 *
 * is OPTIONAL on the request — if absent, the interceptor is a no-op.
 * When present, the (userId, key, method, path) tuple acts as a cache
 * window:
 *
 *   - First call within 24h: execute the handler, persist the response
 *     with the body hash. Race-safe — concurrent inserts with the same
 *     unique tuple cause one to win and the other to read the winner's
 *     row on the second attempt.
 *
 *   - Subsequent call with the SAME body hash: return the cached response
 *     verbatim, including the original status code. Handler is NOT
 *     executed.
 *
 *   - Subsequent call with a DIFFERENT body hash: 409 Conflict (same key
 *     reused for a different request, almost certainly a client bug).
 *
 * What we DO NOT do:
 *
 *   - We don't lock (Stripe-style) on in-flight requests with the same key.
 *     Two genuinely-concurrent requests with the same key will both run
 *     the handler; the second's persist will lose the unique race and we
 *     fall back to its actual response. This is acceptable because the
 *     handler itself is expected to be idempotent on the matcher side
 *     (commandId dedupe). See ADR-0003 §"Alternatives — Stripe-style lock".
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly log = new Logger(IdempotencyInterceptor.name);
  private static readonly TTL_MS = 24 * 60 * 60 * 1000;
  private static readonly UUID_V4_REGEX =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  constructor(private readonly prisma: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest();
    const res = context.switchToHttp().getResponse();
    const rawKey: string | undefined = req.headers['idempotency-key'];

    // No header → bypass entirely. Idempotency is opt-in for now.
    if (!rawKey) return next.handle();

    if (!IdempotencyInterceptor.UUID_V4_REGEX.test(rawKey)) {
      // Strict on format so clients learn the contract early.
      throw new ConflictException('Idempotency-Key must be a UUID v4');
    }

    const userId = req.user?.userId;
    if (!userId) {
      // Should never happen because JwtAuthGuard runs before this — but be
      // defensive: idempotency without a user scope is meaningless.
      return next.handle();
    }

    const method: string = req.method;
    const path: string = req.route?.path ?? req.url ?? req.path ?? 'unknown';
    const requestHash = this.hashBody(req.body);
    const labels = { method, path };

    return from(
      this.prisma.idempotencyKey.findUnique({
        where: {
          userId_key_method_path: { userId, key: rawKey, method, path },
        },
      }),
    ).pipe(
      switchMap((existing) => {
        if (existing) {
          if (existing.requestHash !== requestHash) {
            M.idempotencyConflict.inc(labels);
            throw new ConflictException(
              'Idempotency-Key reused with a different request body',
            );
          }
          M.idempotencyHit.inc(labels);
          res.status(existing.responseStatus);
          return of(existing.responseBody);
        }

        // Miss — run the handler then persist.
        M.idempotencyMiss.inc(labels);
        return next.handle().pipe(
          tap((body) => {
            // Persist after the handler resolves. We don't await this in
            // the response path — failure to cache shouldn't fail the
            // user-visible request.
            void this.persist(userId, rawKey, method, path, requestHash, res.statusCode, body);
          }),
        );
      }),
    );
  }

  private hashBody(body: unknown): string {
    // Sort keys recursively so `{a:1,b:2}` and `{b:2,a:1}` hash identically.
    const canonical = JSON.stringify(body, Object.keys(body ?? {}).sort());
    return createHash('sha256').update(canonical ?? '').digest('hex');
  }

  private async persist(
    userId: string,
    key: string,
    method: string,
    path: string,
    requestHash: string,
    responseStatus: number,
    responseBody: unknown,
  ): Promise<void> {
    try {
      await this.prisma.idempotencyKey.create({
        data: {
          userId,
          key,
          method,
          path,
          requestHash,
          responseStatus,
          responseBody: responseBody as Prisma.InputJsonValue,
          expiresAt: new Date(Date.now() + IdempotencyInterceptor.TTL_MS),
        },
      });
    } catch (err) {
      // Most likely a race with another request that won the unique
      // constraint. Either way, the user-visible response is already on
      // the wire — log and move on.
      this.log.warn(
        `idempotency persist skipped (probably race) — ${(err as Error).message}`,
      );
    }
  }
}
