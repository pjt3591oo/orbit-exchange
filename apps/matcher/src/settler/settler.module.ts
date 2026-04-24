import { Module } from '@nestjs/common';
import { MatchingModule } from '../matching/matching.module';
import { SettlerService } from './settler.service';

@Module({
  imports: [MatchingModule],
  providers: [SettlerService],
  exports: [SettlerService],
})
export class SettlerModule {}
