import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { KeycloakAuthGuard } from '../keycloak/keycloak-auth.guard';
import { KeycloakRolesGuard } from '../keycloak/keycloak-roles.guard';
import { Roles } from '../keycloak/roles.decorator';
import { AdminAuditService } from './admin-audit.service';

/**
 * Audit log read API. AUDITOR role is the canonical reader, but we allow any
 * admin role to view their own / system actions for transparency.
 */
@Controller({ path: 'admin/audit', version: '1' })
@UseGuards(KeycloakAuthGuard, KeycloakRolesGuard)
export class AdminAuditController {
  constructor(private readonly audit: AdminAuditService) {}

  @Get()
  @Roles('AUDITOR', 'SUPPORT_READ', 'WALLET_ADJUST', 'MARKET_OPS')
  list(
    @Query('actor') actor?: string,
    @Query('action') action?: string,
    @Query('targetType') targetType?: string,
    @Query('targetId') targetId?: string,
    @Query('since') since?: string,
    @Query('until') until?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.audit.list({
      actor,
      action,
      targetType,
      targetId,
      since: since ? new Date(since) : undefined,
      until: until ? new Date(until) : undefined,
      cursor,
    });
  }
}
