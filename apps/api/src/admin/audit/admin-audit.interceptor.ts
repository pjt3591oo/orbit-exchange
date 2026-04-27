import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, tap } from 'rxjs';
import {
  ADMIN_ACTION_KEY,
  type AdminActionOptions,
} from './admin-action.decorator';
import { AdminAuditService } from './admin-audit.service';
import type { KeycloakClaims } from '../keycloak/keycloak-claims';

/**
 * Records an AdminAuditLog row whenever a method decorated with @AdminAction
 * runs successfully.
 *
 * The interceptor records:
 *   - actor (from req.admin)
 *   - action + targetType (from decorator metadata)
 *   - targetId (from req.params[targetIdParam])
 *   - reason (from req.body.reason; required if reasonRequired:true)
 *   - after = the value the controller method returned (best-effort serialised)
 *   - ip, ua
 *
 * NOT captured automatically:
 *   - `before` snapshot — services that want diffability should pass before
 *     into the response or write the log explicitly via AdminAuditService.
 *
 * Failures (thrown exceptions) are NOT logged — by design. Only successful
 * mutations end up in the audit trail. Failed attempts go to access logs.
 */
@Injectable()
export class AdminAuditInterceptor implements NestInterceptor {
  private readonly log = new Logger(AdminAuditInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AdminAuditService,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const meta = this.reflector.getAllAndOverride<AdminActionOptions | undefined>(
      ADMIN_ACTION_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (!meta) return next.handle();

    const req = ctx.switchToHttp().getRequest();
    const admin = req.admin as KeycloakClaims | undefined;
    if (!admin) {
      // Should never happen — KeycloakAuthGuard runs first.
      throw new Error('AdminAuditInterceptor: req.admin missing');
    }

    const targetIdParam = meta.targetIdParam ?? 'id';
    const targetId = String(req.params?.[targetIdParam] ?? req.body?.[targetIdParam] ?? '');

    const reason: string | undefined = req.body?.reason;
    if (meta.reasonRequired && (!reason || !reason.trim())) {
      throw new BadRequestException('reason required for this action');
    }

    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
      ?? req.ip
      ?? req.socket?.remoteAddress;
    const ua = req.headers['user-agent'];

    return next.handle().pipe(
      tap((response) => {
        // Record the audit row on success. Errors swallowed here — we never want
        // an audit-write failure to mask a successful mutation.
        const after = this.safeJson(response);
        this.audit
          .write({
            admin,
            action: meta.action,
            targetType: meta.targetType,
            targetId,
            after,
            reason,
            ip,
            ua,
          })
          .catch((err) =>
            this.log.error(
              `audit write failed for ${meta.action} target=${targetId}: ${(err as Error).message}`,
            ),
          );
      }),
    );
  }

  /** JSON-clone the response so Decimal/BigInt are serialised; drop on circular refs. */
  private safeJson(value: unknown): unknown {
    try {
      return JSON.parse(
        JSON.stringify(value, (_k, v) =>
          typeof v === 'bigint' ? v.toString() : v,
        ),
      );
    } catch {
      return null;
    }
  }
}
