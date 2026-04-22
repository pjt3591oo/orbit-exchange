import { Module } from '@nestjs/common';
import { MatchingModule } from '../matching/matching.module';
import { MarketController } from './market.controller';

@Module({
  imports: [MatchingModule],
  controllers: [MarketController],
})
export class MarketModule {}
