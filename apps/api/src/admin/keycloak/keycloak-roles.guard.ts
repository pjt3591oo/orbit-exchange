import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from './roles.decorator';
import type { KeycloakClaims } from './keycloak-claims';

/**
 * Checks that the verified admin token carries at least one of the realm
 * roles declared by the route's @Roles(...) decorator.
 *
 * Composite roles are flattened by Keycloak into the token's
 * realm_access.roles, so a `SuperAdmin` user holding `WALLET_ADJUST` will
 * naturally satisfy a route that requires `WALLET_ADJUST`.
 *
 * Must run AFTER KeycloakAuthGuard (which attaches req.admin).
 */
@Injectable()
export class KeycloakRolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[] | undefined>(
      ROLES_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (!required || required.length === 0) return true;

    const admin = ctx.switchToHttp().getRequest().admin as
      | KeycloakClaims
      | undefined;
    const have = admin?.realm_access?.roles ?? [];
    if (required.some((r) => have.includes(r))) return true;

    throw new ForbiddenException(
      `requires one of: ${required.join(', ')}; have: ${have.join(', ') || '(none)'}`,
    );
  }
}
