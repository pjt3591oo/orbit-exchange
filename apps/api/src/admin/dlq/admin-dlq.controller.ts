import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { KeycloakAuthGuard } from '../keycloak/keycloak-auth.guard';
import { KeycloakRolesGuard } from '../keycloak/keycloak-roles.guard';
import { Roles } from '../keycloak/roles.decorator';
import { AdminAction } from '../audit/admin-action.decorator';
import { AdminAuditInterceptor } from '../audit/admin-audit.interceptor';
import { AdminDlqService } from './admin-dlq.service';
import type { KeycloakClaims } from '../keycloak/keycloak-claims';

/**
 * /api/v1/admin/dlq/* — DLQ inspection and replay (ADR-0004 §D6).
 *
 * Read endpoints: SUPPORT_READ + MARKET_OPS + WALLET_ADJUST.
 * Mutating endpoints (replay/dismiss): MARKET_OPS only — these are
 * operationally significant (replaying a CANCEL command can change state).
 * All mutations write to AdminAuditLog via @AdminAction.
 */
@Controller({ path: 'admin/dlq', version: '1' })
@UseGuards(KeycloakAuthGuard, KeycloakRolesGuard)
@UseInterceptors(AdminAuditInterceptor)
export class AdminDlqController {
  constructor(private readonly dlq: AdminDlqService) {}

  @Get()
  @Roles('SUPPORT_READ', 'MARKET_OPS', 'WALLET_ADJUST')
  list(
    @Query('status')
    status?: 'pending' | 'replayed-success' | 'replayed-failed' | 'dismissed' | 'all',
    @Query('worker') worker?: string,
    @Query('originalTopic') originalTopic?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.dlq.list({ status, worker, originalTopic, cursor });
  }

  @Get(':id')
  @Roles('SUPPORT_READ', 'MARKET_OPS', 'WALLET_ADJUST')
  detail(@Param('id') id: string) {
    return this.dlq.detail(id);
  }

  @Post(':id/replay')
  @Roles('MARKET_OPS')
  @AdminAction('dlq.replay', { targetType: 'DlqEvent', reasonRequired: true })
  replay(@Param('id') id: string, @Req() req: { admin: KeycloakClaims }, @Body() _body: { reason: string }) {
    return this.dlq.replay(id, req.admin.sub);
  }

  @Post(':id/dismiss')
  @Roles('MARKET_OPS')
  @AdminAction('dlq.dismiss', { targetType: 'DlqEvent', reasonRequired: true })
  dismiss(@Param('id') id: string, @Req() req: { admin: KeycloakClaims }, @Body() _body: { reason: string }) {
    return this.dlq.dismiss(id, req.admin.sub);
  }
}
