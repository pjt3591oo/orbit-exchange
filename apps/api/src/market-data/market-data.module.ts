import { Module } from '@nestjs/common';
import { MatchingModule } from '../matching/matching.module';
import { MarketDataGateway } from './market-data.gateway';

@Module({
  imports: [MatchingModule],
  providers: [MarketDataGateway],
})
export class MarketDataModule {}
