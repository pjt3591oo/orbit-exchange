import { SetMetadata } from '@nestjs/common';

/**
 * Required Keycloak realm role(s) for a route. The user needs ANY ONE of the
 * listed roles. KeycloakRolesGuard reads this metadata.
 *
 * Composite roles are flattened by Keycloak into the token's `realm_access.roles`
 * already, so a user with `WRAPPER_ROLE` that includes `INNER_ROLE` will have
 * both in the claim — no need to special-case here.
 */
export const ROLES_KEY = 'admin:roles';
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);
