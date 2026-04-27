import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { KeycloakClaims } from './keycloak-claims';

/**
 * Inject the verified Keycloak claims into a controller method.
 * Requires KeycloakAuthGuard upstream, which attaches `req.admin`.
 *
 *   @CurrentAdmin() admin: KeycloakClaims
 */
export const CurrentAdmin = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): KeycloakClaims => {
    const req = ctx.switchToHttp().getRequest();
    if (!req.admin) {
      throw new Error('CurrentAdmin used without KeycloakAuthGuard');
    }
    return req.admin as KeycloakClaims;
  },
);
