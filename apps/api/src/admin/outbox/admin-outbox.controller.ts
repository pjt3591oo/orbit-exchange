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
import { AdminOutboxService } from './admin-outbox.service';
import type { KeycloakClaims } from '../keycloak/keycloak-claims';

/**
 * /api/v1/admin/outbox — operational surface over OutboxEvent (ADR-0002).
 *
 * Read access: SUPPORT_READ + MARKET_OPS + WALLET_ADJUST.
 * Mutating actions (retry / skip): MARKET_OPS only — they affect
 * downstream consumers (a wrongly-skipped order command means the
 * matcher never sees it). All mutations write to AdminAuditLog via
 * @AdminAction.
 */
@Controller({ path: 'admin/outbox', version: '1' })
@UseGuards(KeycloakAuthGuard, KeycloakRolesGuard)
@UseInterceptors(AdminAuditInterceptor)
export class AdminOutboxController {
  constructor(private readonly outbox: AdminOutboxService) {}

  @Get('stats')
  @Roles('SUPPORT_READ', 'MARKET_OPS', 'WALLET_ADJUST')
  stats() {
    return this.outbox.stats();
  }

  @Get()
  @Roles('SUPPORT_READ', 'MARKET_OPS', 'WALLET_ADJUST')
  list(
    @Query('status') status?: 'pending' | 'processed' | 'failed' | 'all',
    @Query('topic') topic?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.outbox.list({ status, topic, cursor });
  }

  @Get(':id')
  @Roles('SUPPORT_READ', 'MARKET_OPS', 'WALLET_ADJUST')
  detail(@Param('id') id: string) {
    return this.outbox.detail(id);
  }

  /**
   * Re-arm a failed row (clear attempts + lastError). The relay re-tries
   * automatically on its next poll.
   */
  @Post(':id/retry')
  @Roles('MARKET_OPS')
  @AdminAction('outbox.retry', { targetType: 'OutboxEvent', reasonRequired: true })
  retry(
    @Param('id') id: string,
    @Req() req: { admin: KeycloakClaims },
    @Body() _body: { reason: string },
  ) {
    return this.outbox.retry(id, req.admin.sub);
  }

  /**
   * Mark as processed without publishing. Emergency-only, permanent data
   * drop. The reason text becomes the audit-log explanation.
   */
  @Post(':id/skip')
  @Roles('MARKET_OPS')
  @AdminAction('outbox.skip', { targetType: 'OutboxEvent', reasonRequired: true })
  skip(
    @Param('id') id: string,
    @Req() req: { admin: KeycloakClaims },
    @Body() _body: { reason: string },
  ) {
    return this.outbox.skip(id, req.admin.sub);
  }
}
