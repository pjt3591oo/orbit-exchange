import { SetMetadata } from '@nestjs/common';

/**
 * Marks a controller method as an auditable admin mutation.
 *
 * The AdminAuditInterceptor reads this metadata and writes one
 * AdminAuditLog row per successful invocation:
 *
 *   - actor: req.admin (Keycloak claims)
 *   - target: resolved by `targetType` + the route's `:id` param (override
 *     via `targetIdParam` if your param is named differently)
 *   - before/after: optional snapshots if you call AdminAuditService.snapshot()
 *     manually OR provide a `snapshot` resolver
 *   - reason: pulled from request body if `reasonRequired: true`. Throws 400
 *     when missing.
 *
 *   @AdminAction('user.freeze', { targetType: 'User', reasonRequired: true })
 *   @Patch(':id/freeze')
 *   freeze(@Param('id') id: string, @Body() body: { reason: string }) { ... }
 */
export const ADMIN_ACTION_KEY = 'admin:action';

export interface AdminActionOptions {
  /** dot-namespaced action name (e.g. "user.freeze") */
  action: string;
  /** target entity type — used to filter audit log queries */
  targetType: string;
  /** route param holding the target id; defaults to "id" */
  targetIdParam?: string;
  /** when true, body must contain a non-empty `reason` string */
  reasonRequired?: boolean;
}

export const AdminAction = (
  action: string,
  opts?: Omit<AdminActionOptions, 'action'>,
) =>
  SetMetadata(ADMIN_ACTION_KEY, {
    action,
    targetType: opts?.targetType ?? '',
    targetIdParam: opts?.targetIdParam ?? 'id',
    reasonRequired: opts?.reasonRequired ?? false,
  } satisfies AdminActionOptions);
