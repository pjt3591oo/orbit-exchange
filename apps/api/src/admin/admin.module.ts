import { Module } from '@nestjs/common';
import { KeycloakModule } from './keycloak/keycloak.module';
import { AdminAuditModule } from './audit/admin-audit.module';
import { AdminAuditController } from './audit/admin-audit.controller';
import { AdminStatsModule } from './stats/admin-stats.module';
import { AdminUsersModule } from './users/admin-users.module';
import { AdminWalletsModule } from './wallets/admin-wallets.module';
import { AdminMarketsModule } from './markets/admin-markets.module';
import { AdminAssetsModule } from './assets/admin-assets.module';
import { AdminOrdersModule } from './orders/admin-orders.module';
import { AdminTradesModule } from './trades/admin-trades.module';
import { AdminDlqModule } from './dlq/admin-dlq.module';
import { AdminOutboxModule } from './outbox/admin-outbox.module';

/**
 * Roll-up of all /api/v1/admin/* routes. Mounted from AppModule so the admin
 * surface lives inside apps/api but is logically separated by URL prefix and
 * by guard (KeycloakAuthGuard vs the customer JwtAuthGuard).
 *
 * Future: extracted to apps/admin-api as a sibling NestJS process if we need
 * separate scaling / IP allowlist / DB user. The module boundary here makes
 * that mostly a docker-compose change.
 */
@Module({
  imports: [
    KeycloakModule,
    AdminAuditModule,
    AdminStatsModule,
    AdminUsersModule,
    AdminWalletsModule,
    AdminMarketsModule,
    AdminAssetsModule,
    AdminOrdersModule,
    AdminTradesModule,
    AdminDlqModule,
    AdminOutboxModule,
  ],
  controllers: [AdminAuditController],
})
export class AdminModule {}
