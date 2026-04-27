import { Global, Module } from '@nestjs/common';
import { KeycloakAuthGuard } from './keycloak-auth.guard';
import { KeycloakRolesGuard } from './keycloak-roles.guard';

/**
 * Provides Keycloak-based auth/role guards. Marked @Global so admin sub-modules
 * can `@UseGuards(KeycloakAuthGuard, KeycloakRolesGuard)` without re-importing.
 */
@Global()
@Module({
  providers: [KeycloakAuthGuard, KeycloakRolesGuard],
  exports: [KeycloakAuthGuard, KeycloakRolesGuard],
})
export class KeycloakModule {}
