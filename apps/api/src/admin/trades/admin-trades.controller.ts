import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { KeycloakAuthGuard } from '../keycloak/keycloak-auth.guard';
import { KeycloakRolesGuard } from '../keycloak/keycloak-roles.guard';
import { Roles } from '../keycloak/roles.decorator';
import { AdminTradesService } from './admin-trades.service';

@Controller({ path: 'admin/trades', version: '1' })
@UseGuards(KeycloakAuthGuard, KeycloakRolesGuard)
export class AdminTradesController {
  constructor(private readonly trades: AdminTradesService) {}

  @Get()
  @Roles('SUPPORT_READ', 'MARKET_OPS', 'WALLET_ADJUST')
  list(
    @Query('market') market?: string,
    @Query('userId') userId?: string,
    @Query('since') since?: string,
    @Query('until') until?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.trades.list({ market, userId, since, until, cursor });
  }
}
