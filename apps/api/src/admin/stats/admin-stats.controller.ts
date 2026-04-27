import { Controller, Get, UseGuards } from '@nestjs/common';
import { KeycloakAuthGuard } from '../keycloak/keycloak-auth.guard';
import { KeycloakRolesGuard } from '../keycloak/keycloak-roles.guard';
import { Roles } from '../keycloak/roles.decorator';
import { AdminStatsService } from './admin-stats.service';

/**
 * /api/v1/admin/stats — single-pull dashboard summary.
 * Cheap counts only; nothing here should issue per-row scans.
 */
@Controller({ path: 'admin/stats', version: '1' })
@UseGuards(KeycloakAuthGuard, KeycloakRolesGuard)
@Roles('SUPPORT_READ', 'MARKET_OPS', 'WALLET_ADJUST', 'AUDITOR')
export class AdminStatsController {
  constructor(private readonly stats: AdminStatsService) {}

  @Get()
  get() {
    return this.stats.dashboard();
  }
}
