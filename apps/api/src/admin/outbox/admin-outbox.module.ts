import { Module } from '@nestjs/common';
import { AdminOutboxController } from './admin-outbox.controller';
import { AdminOutboxService } from './admin-outbox.service';

@Module({
  controllers: [AdminOutboxController],
  providers: [AdminOutboxService],
})
export class AdminOutboxModule {}
