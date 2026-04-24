import { Module } from '@nestjs/common';
import { MatchingModule } from '../matching/matching.module';
import { SnapshotService } from './snapshot.service';

@Module({
  imports: [MatchingModule],
  providers: [SnapshotService],
  exports: [SnapshotService],
})
export class SnapshotModule {}
