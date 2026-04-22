import { Module } from '@nestjs/common';
import { MatchingModule } from '../matching/matching.module';
import { OrderController } from './order.controller';
import { OrderService } from './order.service';

@Module({
  imports: [MatchingModule],
  controllers: [OrderController],
  providers: [OrderService],
})
export class OrderModule {}
