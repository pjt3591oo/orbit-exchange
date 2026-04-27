import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { KeycloakAuthGuard } from '../keycloak/keycloak-auth.guard';
import { KeycloakRolesGuard } from '../keycloak/keycloak-roles.guard';
import { Roles } from '../keycloak/roles.decorator';
import { AdminAction } from '../audit/admin-action.decorator';
import { AdminAuditInterceptor } from '../audit/admin-audit.interceptor';
import { AdminAssetsService, type AssetInput } from './admin-assets.service';

@Controller({ path: 'admin/assets', version: '1' })
@UseGuards(KeycloakAuthGuard, KeycloakRolesGuard)
@UseInterceptors(AdminAuditInterceptor)
export class AdminAssetsController {
  constructor(private readonly assets: AdminAssetsService) {}

  @Get()
  @Roles('SUPPORT_READ', 'MARKET_OPS')
  list() {
    return this.assets.list();
  }

  @Post()
  @Roles('MARKET_OPS')
  @AdminAction('asset.create', { targetType: 'Asset', targetIdParam: 'symbol' })
  create(@Body() body: AssetInput & { reason?: string }) {
    return this.assets.create(body);
  }

  @Patch(':symbol')
  @Roles('MARKET_OPS')
  @AdminAction('asset.update', { targetType: 'Asset', targetIdParam: 'symbol' })
  update(
    @Param('symbol') symbol: string,
    @Body() body: Partial<Omit<AssetInput, 'symbol'>> & { reason?: string },
  ) {
    return this.assets.update(symbol, body);
  }

  @Delete(':symbol')
  @Roles('MARKET_OPS')
  @AdminAction('asset.delete', { targetType: 'Asset', targetIdParam: 'symbol', reasonRequired: true })
  remove(@Param('symbol') symbol: string) {
    return this.assets.remove(symbol);
  }
}
