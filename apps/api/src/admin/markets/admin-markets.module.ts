import { Module } from '@nestjs/common';
import { AdminMarketsController } from './admin-markets.controller';
import { AdminMarketsService } from './admin-markets.service';

@Module({
  controllers: [AdminMarketsController],
  providers: [AdminMarketsService],
})
export class AdminMarketsModule {}
