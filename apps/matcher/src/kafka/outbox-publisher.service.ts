import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { metrics } from '@orbit/observability';

/**
 * Mirror of apps/api's OutboxPublisherService. The matcher's settler writes
 * trade / order / orderbook / user-event payloads via this service inside
 * the same prisma.$transaction that persists the trade rows + balance
 * updates. The outbox-relay worker (apps/workers/src/outbox-relay) actually
 * publishes them to Kafka.
 *
 * See ADR-0002 §D2 for the rationale.
 */
@Injectable()
export class OutboxPublisherService {
  async publish<T>(
    tx: Prisma.TransactionClient,
    args: {
      topic: string;
      key: string;
      payload: T;
      headers?: Record<string, string>;
    },
  ): Promise<void> {
    await tx.outboxEvent.create({
      data: {
        topic: args.topic,
        key: args.key,
        payload: args.payload as Prisma.InputJsonValue,
        headers: (args.headers as Prisma.InputJsonValue | undefined) ?? Prisma.JsonNull,
      },
    });
    metrics.Metrics.outboxAppended.inc({ topic: args.topic });
  }
}
