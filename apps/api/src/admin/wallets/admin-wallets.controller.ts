import {
  Body,
  Controller,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { KeycloakAuthGuard } from '../keycloak/keycloak-auth.guard';
import { KeycloakRolesGuard } from '../keycloak/keycloak-roles.guard';
import { Roles } from '../keycloak/roles.decorator';
import { CurrentAdmin } from '../keycloak/current-admin.decorator';
import type { KeycloakClaims } from '../keycloak/keycloak-claims';
import { AdminWalletsService, type AdjustInput } from './admin-wallets.service';

/**
 * Wallet adjust is THE most dangerous admin action — directly mutates user
 * balance/locked outside the matcher's settlement path. WALLET_ADJUST role,
 * required reason, and a manual audit write inside the service.
 */
@Controller({ path: 'admin/users/:userId/wallets', version: '1' })
@UseGuards(KeycloakAuthGuard, KeycloakRolesGuard)
export class AdminWalletsController {
  constructor(private readonly wallets: AdminWalletsService) {}

  @Post(':asset/adjust')
  @Roles('WALLET_ADJUST')
  adjust(
    @CurrentAdmin() admin: KeycloakClaims,
    @Req() req: Request,
    @Param('userId') userId: string,
    @Param('asset') asset: string,
    @Body() body: AdjustInput,
  ) {
    return this.wallets.adjust(admin, userId, asset, body, {
      ip: (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ?? req.ip,
      ua: req.headers['user-agent'] as string | undefined,
    });
  }
}
