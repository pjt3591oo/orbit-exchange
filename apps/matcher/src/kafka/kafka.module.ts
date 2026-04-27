import { Global, Module } from '@nestjs/common';
import { KafkaProducerService } from './kafka-producer.service';
import { OutboxPublisherService } from './outbox-publisher.service';

@Global()
@Module({
  providers: [KafkaProducerService, OutboxPublisherService],
  exports: [KafkaProducerService, OutboxPublisherService],
})
export class KafkaModule {}
