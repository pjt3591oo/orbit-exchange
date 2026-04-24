import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';

/**
 * Matcher process bootstrap. No HTTP, no WS — just an
 * `ApplicationContext` that wires DI, runs the in-memory matching engine,
 * consumes order commands from Kafka, and publishes resulting events.
 */
async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  // eslint-disable-next-line no-console
  console.log('[matcher] running (no HTTP/WS, kafka-driven)');
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[matcher] bootstrap failed', err);
  process.exit(1);
});
