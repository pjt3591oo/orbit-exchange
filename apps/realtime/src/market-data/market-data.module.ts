import { Module } from '@nestjs/common';
import { MarketDataGateway } from './market-data.gateway';
import { SnapshotCacheService } from './snapshot-cache.service';

@Module({
  providers: [MarketDataGateway, SnapshotCacheService],
})
export class MarketDataModule {}
