import { Module } from '@nestjs/common';
import { MatchingModule } from '../matching/matching.module';
import { SettlerModule } from '../settler/settler.module';
import { SnapshotModule } from '../snapshot/snapshot.module';
import { CommandConsumerService } from './command-consumer.service';

@Module({
  imports: [MatchingModule, SettlerModule, SnapshotModule],
  providers: [CommandConsumerService],
})
export class ConsumerModule {}
