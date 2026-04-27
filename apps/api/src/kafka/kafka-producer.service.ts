import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { CompressionTypes, Kafka, Partitioners, Producer } from 'kafkajs';
import { metrics } from '@orbit/observability';

const M = metrics.Metrics;

@Injectable()
export class KafkaProducerService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(KafkaProducerService.name);
  private kafka!: Kafka;
  private producer!: Producer;
  private ready = false;

  async onModuleInit() {
    const brokers = (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(',');
    this.kafka = new Kafka({
      clientId: process.env.KAFKA_CLIENT_ID ?? 'orbit-api',
      brokers,
      retry: { retries: 8, initialRetryTime: 300 },
    });
    this.producer = this.kafka.producer({
      idempotent: true,
      maxInFlightRequests: 5,
      allowAutoTopicCreation: true,
      createPartitioner: Partitioners.DefaultPartitioner,
    });
    try {
      await this.producer.connect();
      this.ready = true;
      this.log.log(`Kafka connected → ${brokers.join(',')}`);
    } catch (e) {
      this.log.warn(`Kafka not available; producer will operate in best-effort mode: ${(e as Error).message}`);
    }
  }

  async onModuleDestroy() {
    if (this.ready) await this.producer.disconnect();
  }

  async send<T>(topic: string, key: string, value: T) {
    if (!this.ready) {
      this.log.debug(`skip send(${topic}) — kafka disconnected`);
      return;
    }
    const t0 = Date.now();
    try {
      await this.producer.send({
        topic,
        compression: CompressionTypes.GZIP,
        messages: [{ key, value: JSON.stringify(value) }],
      });
      M.kafkaPublishDuration.observe({ topic, result: 'ok' }, Date.now() - t0);
    } catch (err) {
      M.kafkaPublishDuration.observe({ topic, result: 'error' }, Date.now() - t0);
      this.log.error(`Kafka send failed topic=${topic}: ${(err as Error).message}`);
    }
  }

  /**
   * Escape hatch for callers that need to publish raw bytes (e.g. DLQ
   * replay — the payload is already a Buffer so we mustn't JSON.stringify
   * it again). Returns null if Kafka isn't connected; caller must handle.
   */
  getRawProducer(): Producer | null {
    return this.ready ? this.producer : null;
  }
}
