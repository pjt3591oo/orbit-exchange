import { Module } from '@nestjs/common';
import { MatchingEngineService } from './matching-engine.service';

@Module({
  providers: [MatchingEngineService],
  exports: [MatchingEngineService],
})
export class MatchingModule {}
