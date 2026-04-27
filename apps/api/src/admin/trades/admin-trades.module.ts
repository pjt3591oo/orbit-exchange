import { Module } from '@nestjs/common';
import { AdminTradesController } from './admin-trades.controller';
import { AdminTradesService } from './admin-trades.service';

@Module({
  controllers: [AdminTradesController],
  providers: [AdminTradesService],
})
export class AdminTradesModule {}
