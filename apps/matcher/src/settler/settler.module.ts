import { Module } from '@nestjs/common';
import { MatchingModule } from '../matching/matching.module';
import { SettlerService } from './settler.service';

/**
 * KafkaModule (which provides OutboxPublisherService) is @Global, so we
 * don't need to import it here — the SettlerService can inject it directly.
 */
@Module({
  imports: [MatchingModule],
  providers: [SettlerService],
  exports: [SettlerService],
})
export class SettlerModule {}
