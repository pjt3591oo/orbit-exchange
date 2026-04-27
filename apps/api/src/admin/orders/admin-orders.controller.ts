import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { KeycloakAuthGuard } from '../keycloak/keycloak-auth.guard';
import { KeycloakRolesGuard } from '../keycloak/keycloak-roles.guard';
import { Roles } from '../keycloak/roles.decorator';
import { AdminAction } from '../audit/admin-action.decorator';
import { AdminAuditInterceptor } from '../audit/admin-audit.interceptor';
import { AdminOrdersService } from './admin-orders.service';

@Controller({ path: 'admin/orders', version: '1' })
@UseGuards(KeycloakAuthGuard, KeycloakRolesGuard)
@UseInterceptors(AdminAuditInterceptor)
export class AdminOrdersController {
  constructor(private readonly orders: AdminOrdersService) {}

  @Get()
  @Roles('SUPPORT_READ', 'MARKET_OPS', 'WALLET_ADJUST')
  list(
    @Query('userId') userId?: string,
    @Query('market') market?: string,
    @Query('status') status?: string,
    @Query('since') since?: string,
    @Query('until') until?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.orders.list({ userId, market, status, since, until, cursor });
  }

  @Get(':id')
  @Roles('SUPPORT_READ', 'MARKET_OPS', 'WALLET_ADJUST')
  detail(@Param('id') id: string) {
    return this.orders.detail(id);
  }

  /**
   * Publishes a CANCEL command to the matcher; status flips asynchronously.
   */
  @Post(':id/cancel')
  @Roles('MARKET_OPS')
  @AdminAction('order.force-cancel', { targetType: 'Order', reasonRequired: true })
  forceCancel(@Param('id') id: string, @Body() _body: { reason: string }) {
    return this.orders.forceCancel(id);
  }
}
