import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { KeycloakAuthGuard } from '../keycloak/keycloak-auth.guard';
import { KeycloakRolesGuard } from '../keycloak/keycloak-roles.guard';
import { Roles } from '../keycloak/roles.decorator';
import { AdminAction } from '../audit/admin-action.decorator';
import { AdminAuditInterceptor } from '../audit/admin-audit.interceptor';
import {
  AdminMarketsService,
  type MarketUpdateInput,
} from './admin-markets.service';

@Controller({ path: 'admin/markets', version: '1' })
@UseGuards(KeycloakAuthGuard, KeycloakRolesGuard)
@UseInterceptors(AdminAuditInterceptor)
export class AdminMarketsController {
  constructor(private readonly markets: AdminMarketsService) {}

  @Get()
  @Roles('SUPPORT_READ', 'MARKET_OPS', 'WALLET_ADJUST')
  list() {
    return this.markets.list();
  }

  @Get(':symbol')
  @Roles('SUPPORT_READ', 'MARKET_OPS', 'WALLET_ADJUST')
  detail(@Param('symbol') symbol: string) {
    return this.markets.detail(symbol);
  }

  /**
   * Patch market config. enabled toggle, fee/tick/step changes, all in one
   * endpoint. Audit log captures both before + after via the response payload.
   */
  @Patch(':symbol')
  @Roles('MARKET_OPS')
  @AdminAction('market.update', {
    targetType: 'Market',
    targetIdParam: 'symbol',
    reasonRequired: true,
  })
  update(@Param('symbol') symbol: string, @Body() body: MarketUpdateInput & { reason: string }) {
    return this.markets.update(symbol, body);
  }
}
