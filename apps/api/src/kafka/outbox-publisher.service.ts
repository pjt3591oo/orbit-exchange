import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { metrics } from '@orbit/observability';

/**
 * Single point through which any code path that wants to publish to Kafka
 * should go. The actual `producer.send()` happens later in the
 * outbox-relay worker; we just write a row to the OutboxEvent table inside
 * the caller's transaction.
 *
 * Why a service vs a helper function:
 *   - DI lets us swap in a fake in tests
 *   - Centralised metric increment (`outbox_appended_total`)
 *   - Future hook for trace-context header injection (see ADR-0002 §D2 —
 *     storing traceparent so the relay's CONSUMER span links to the
 *     original API request span)
 *
 * Caller pattern (must be inside a prisma.$transaction):
 *
 *   await prisma.$transaction(async (tx) => {
 *     // ... your DB writes ...
 *     await outbox.publish(tx, {
 *       topic: KAFKA_TOPICS.ORDER_COMMANDS,
 *       key: dto.market,
 *       payload: cmd,
 *     });
 *   });
 */
@Injectable()
export class OutboxPublisherService {
  async publish<T>(
    tx: Prisma.TransactionClient,
    args: {
      topic: string;
      key: string;
      payload: T;
      /** Optional headers — typically just `{ traceparent: '...' }`. */
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
