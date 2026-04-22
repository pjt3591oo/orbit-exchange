import { Kafka, logLevel } from 'kafkajs';

let kafka: Kafka | null = null;

export function getKafka(): Kafka {
  if (!kafka) {
    const brokers = (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(',');
    kafka = new Kafka({
      clientId: process.env.KAFKA_CLIENT_ID ?? 'orbit-workers',
      brokers,
      logLevel: logLevel.WARN,
    });
  }
  return kafka;
}
