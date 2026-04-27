# ADR-0002 — DB ↔ Kafka Dual-Write: Transactional Outbox 채택

- **Status**: Proposed
- **Date**: 2026-04-27
- **Deciders**: 본 프로젝트 owner
- **Related**: F-API-1, F-MATCH-3, F-OBS-2

## Context

ORBIT 의 두 hot path 모두 dual-write 문제를 가진다.

### Path 1 — apps/api: Order INSERT + Kafka SUBMIT command

```ts
// apps/api/src/order/order.service.ts:99–135
const order = await this.prisma.$transaction(async (tx) => {
  await this.lockReservation(...);
  return tx.order.create({ ... });
});

this.kafka.send<OrderSubmitCommand>(KAFKA_TOPICS.ORDER_COMMANDS, dto.market, cmd)
  .catch((err) => this.log.error(...));
```

DB commit 후 Kafka publish. publish 실패는 silent log + fire-and-forget. **funds 영구 lock**.

### Path 2 — apps/matcher: Trade row INSERT + 후속 events publish

```ts
// apps/matcher/src/consumer/command-consumer.service.ts:107
await this.matching.run(cmd.symbol, async () => {
  await this.settler.settle(...);  // DB transaction
  await this.publishSubmitEvents(...);  // Kafka publish
});
// eachMessage return → kafkajs auto-commit offset
```

DB 정산 commit 후 trade event publish. publish 실패 시 catch 블록은 단순 로그. **trade 가 DB 에는 있지만 downstream 에는 없음** — candle 누락, 사용자 WS 알림 없음, audit 누락.

두 경로 모두 동일한 패턴이다: **두 외부 시스템 (DB + Kafka) 에 atomic 하게 쓸 수 없다**.

## Decision

**Transactional Outbox 패턴 채택**. 단, 두 path 의 사용 형태는 약간 다르다.

### D1. Outbox 테이블 도입

`apps/api/prisma/schema.prisma`:

```prisma
model OutboxEvent {
  id         BigInt   @id @default(autoincrement())
  topic      String   // Kafka topic
  key        String?  // partition key (e.g. market symbol)
  payload    Json     // 원본 메시지
  headers    Json?    // 선택적 헤더 (traceparent 등)

  createdAt  DateTime @default(now())
  processedAt DateTime?     // null = 아직 publish 안 됨
  attempts   Int      @default(0)
  lastError  String?

  @@index([processedAt, createdAt])  // relay polling 용
  @@index([topic, createdAt])         // 운영자 조회용
}
```

핵심 설계 결정:
- `processedAt` 으로 미발행 식별. NULL = 미처리.
- `attempts` + `lastError` 로 운영자 가시성 확보.
- 인덱스 `(processedAt, createdAt)` — 미처리 행만 빠르게 스캔.

### D2. Producer 사이드 — outbox INSERT 를 트랜잭션에 포함

**Path 1 (api/order)**:

```ts
const order = await this.prisma.$transaction(async (tx) => {
  await this.lockReservation(tx, ...);
  const created = await tx.order.create({ ... });
  await tx.outboxEvent.create({
    data: {
      topic: KAFKA_TOPICS.ORDER_COMMANDS,
      key: dto.market,
      payload: cmd,
      headers: { traceparent: getCurrentTraceparent() },
    },
  });
  return created;
}, { isolationLevel: 'ReadCommitted', timeout: 10_000 });
// kafka.send 는 더 이상 호출하지 않음
```

**Path 2 (matcher/settler)**:

```ts
await prisma.$transaction(async (tx) => {
  // 기존 trade / wallet / order update
  for (const event of [tradeEvent, orderbookEvent, userEvent]) {
    await tx.outboxEvent.create({
      data: { topic: event.topic, key: event.key, payload: event.payload },
    });
  }
});
// publishSubmitEvents 직접 호출 제거
```

이로써 DB commit 과 outbox row 생성이 같은 트랜잭션. 둘 다 성공하거나 둘 다 실패.

### D3. Outbox Relay 워커

`apps/workers/src/outbox-relay/index.ts` 신규.

```ts
export async function runOutboxRelay() {
  const POLL_MS = 100;  // 핫패스라 짧게
  const BATCH = 200;

  while (running) {
    const events = await prisma.outboxEvent.findMany({
      where: { processedAt: null },
      orderBy: { createdAt: 'asc' },
      take: BATCH,
    });
    if (events.length === 0) {
      await sleep(POLL_MS);
      continue;
    }

    for (const ev of events) {
      try {
        await producer.send({ topic: ev.topic, messages: [{ key: ev.key, value: JSON.stringify(ev.payload), headers: ev.headers }] });
        await prisma.outboxEvent.update({
          where: { id: ev.id },
          data: { processedAt: new Date() },
        });
      } catch (err) {
        await prisma.outboxEvent.update({
          where: { id: ev.id },
          data: { attempts: { increment: 1 }, lastError: String(err) },
        });
        // 재시도는 다음 polling 에서. 단, attempts > 5 이면 alert.
      }
    }
  }
}
```

핵심 설계 결정:
- **순서 보장은 partition key 단위** — 같은 key 의 메시지가 createdAt 순으로 publish 되도록 정렬. 다른 key 끼리는 순서 무관.
- **at-least-once** — relay 가 send 후 update 사이에서 죽으면 같은 메시지 재발행. 따라서 consumer 는 idempotent (ADR-0003).
- **Polling 간격 100ms** — 사용자가 주문 후 WS 알림까지의 latency 영향. 너무 길면 사용자 인식 가능.

### D4. Consumer side 는 그대로 — 단, ADR-0003 의 idempotency 적용

outbox 가 at-least-once 라 consumer 는 같은 메시지를 두 번 받을 수 있다. 이는 ADR-0003 의 dedupe 로 흡수.

### D5. 모니터링

신규 메트릭:
```
outbox_pending_count{topic="..."}      # processedAt IS NULL 행 수
outbox_oldest_age_seconds{topic="..."} # 가장 오래된 미처리 행의 나이
outbox_publish_failures_total          # attempts > 0 누적
outbox_publish_duration_ms             # producer.send 레이턴시
```

알림 룰:
- `outbox_oldest_age_seconds > 30` for 1m → WARN
- `outbox_oldest_age_seconds > 300` for 1m → CRITICAL
- `outbox_pending_count > 10000` → CRITICAL

이로써 F-OBS-2 closed.

## Consequences

### Positive

- F-API-1, F-MATCH-3 closed — dual-write 의 publish 실패가 retry 가능한 상태로 보존.
- 자금 정합성 영향 받는 path 가 모두 transactional 보호.
- 운영자가 outbox 테이블을 직접 조회 가능 — debug 친화적.
- Kafka broker 가 5분 down 되어도 데이터 유실 없음. relay 가 broker 복구 후 catch up.

### Negative

- DB 쓰기 부하 증가 — 모든 producer 가 outbox row 1개씩 추가 INSERT.
- relay polling 비용 (PG load + latency 추가). 100ms polling 으로 사용자 인식 latency p99 +100ms 정도.
- Outbox 테이블 유지보수 — `processedAt` 이 오래된 행은 주기적으로 archive (예: 7일 이상). cron 잡 필요.
- 메시지 순서가 *partition key 단위* 로만 보장. 다른 key 사이 순서는 outbox 수집 순서와 다를 수 있음.

### Neutral

- relay 워커가 SPOF 처럼 보이지만, 실제로는 죽어도 data 안전 (DB 에 남아있음). 재기동 후 catch up.

## Implementation notes

영향 파일 (예상):
- `apps/api/prisma/schema.prisma` — `OutboxEvent` 모델 추가
- `apps/api/prisma/migrations/` — migration 1건
- `apps/api/src/kafka/outbox-publisher.service.ts` — 신규 (`tx.outboxEvent.create` wrapper)
- `apps/api/src/order/order.service.ts` — `kafka.send` → outbox INSERT
- `apps/matcher/src/settler/settler.service.ts` — 동일
- `apps/matcher/src/consumer/command-consumer.service.ts` — `publishSubmitEvents` 제거
- `apps/workers/src/outbox-relay/index.ts` — 신규
- `apps/workers/src/main.ts` — outbox-relay 활성화
- `packages/observability/src/metric-names.ts` — outbox_* 메트릭 추가
- `infra/grafana/dashboards/orbit-order-pipeline.json` — outbox lag 패널 추가

테스트 케이스:
1. DB commit 후 Kafka 단절 시뮬레이션 → outbox 에 미처리 행 누적 → broker 복구 후 모두 publish
2. relay 가 send 후 update 전에 죽음 → 같은 메시지 재발행 (consumer dedupe 로 흡수)
3. `outbox_oldest_age_seconds` 가 alert threshold 도달 시 알람

## Alternatives considered

### Alt A. Change Data Capture (Debezium)

Postgres logical replication 을 Debezium 이 읽어서 Kafka 로 publish.

**Rejected**: 
- 운영 복잡도 ↑ (Debezium connector 추가 컴포넌트)
- 학습 프로젝트에 비해 과한 인프라
- outbox 패턴이 docker-compose 환경에 더 적합
- 단, 운영 단계에서는 재검토 가치 있음

### Alt B. Idempotent producer + sync send

`kafka.send()` 를 await 하고 실패 시 transaction 롤백.

**Rejected**:
- DB transaction 안에서 외부 I/O 호출 → lock 점유 시간 증가
- broker 가 5초 응답 안 하면 transaction 도 5초 hang
- broker 단기 단절을 transaction 단위로 흡수 못 함

### Alt C. 그냥 retry queue (DB 안에)

publish 실패한 메시지만 DB 에 저장 후 재시도.

**Rejected**:
- 정상 케이스 (95%) 는 outbox 안 거치므로 다른 *코드 경로* 가 됨 → 복잡
- DB commit 과 publish 의 atomic 보장이 없음 — 결국 dual-write 문제 미해결

### Alt D. Kafka transactional producer (exactly-once)

`producer.transactional` + `consumer.read_committed`.

**Rejected**:
- DB transaction 과 Kafka transaction 의 결합 (XA-like) 은 직접 지원 안 됨
- Kafka 단일 transaction 만으로는 DB 의 정합성 못 보장
- 본질이 다른 문제

## Follow-ups

- Outbox archive 잡 (7일 이상 processedAt non-null 행 압축) — 운영 진입 시
- Multi-tenant 환경에서 outbox 샤딩 — 학습 단계 미적용
- ADR-0003 의 idempotency 와 함께 적용해야 의미 있음 (consumer side dedupe)
