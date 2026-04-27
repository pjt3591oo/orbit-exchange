import { Module } from '@nestjs/common';
import { AdminDlqController } from './admin-dlq.controller';
import { AdminDlqService } from './admin-dlq.service';

@Module({
  controllers: [AdminDlqController],
  providers: [AdminDlqService],
})
export class AdminDlqModule {}
