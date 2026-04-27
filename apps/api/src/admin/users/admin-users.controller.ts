import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { KeycloakAuthGuard } from '../keycloak/keycloak-auth.guard';
import { KeycloakRolesGuard } from '../keycloak/keycloak-roles.guard';
import { Roles } from '../keycloak/roles.decorator';
import { AdminAction } from '../audit/admin-action.decorator';
import { AdminAuditInterceptor } from '../audit/admin-audit.interceptor';
import { AdminUsersService } from './admin-users.service';
import { AdminWalletsService } from '../wallets/admin-wallets.service';

@Controller({ path: 'admin/users', version: '1' })
@UseGuards(KeycloakAuthGuard, KeycloakRolesGuard)
@UseInterceptors(AdminAuditInterceptor)
export class AdminUsersController {
  constructor(
    private readonly users: AdminUsersService,
    private readonly wallets: AdminWalletsService,
  ) {}

  @Get()
  @Roles('SUPPORT_READ', 'WALLET_ADJUST', 'MARKET_OPS')
  list(@Query('q') q?: string, @Query('cursor') cursor?: string) {
    return this.users.list({ q, cursor });
  }

  @Get(':id')
  @Roles('SUPPORT_READ', 'WALLET_ADJUST', 'MARKET_OPS')
  detail(@Param('id') id: string) {
    return this.users.detail(id);
  }

  /**
   * Toggle a user's frozen flag. Frozen users can't submit new orders
   * (OrderService checks this); existing OPEN orders aren't auto-cancelled.
   */
  @Patch(':id/freeze')
  @Roles('WALLET_ADJUST')
  @AdminAction('user.freeze', { targetType: 'User', reasonRequired: true })
  freeze(@Param('id') id: string, @Body() body: { frozen: boolean; reason: string }) {
    if (typeof body?.frozen !== 'boolean') {
      throw new BadRequestException('frozen (boolean) required');
    }
    return this.users.setFrozen(id, body.frozen);
  }

  @Get(':id/wallets')
  @Roles('SUPPORT_READ', 'WALLET_ADJUST')
  wallets_(@Param('id') id: string) {
    return this.wallets.listForUser(id);
  }
}
