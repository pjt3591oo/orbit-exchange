# ADR-0006 — Audit Logger At-least-once 보장

- **Status**: Proposed
- **Date**: 2026-04-27
- **Deciders**: 본 프로젝트 owner
- **Related**: F-WORK-2, F-WORK-6, F-EXT-1

## Context

Audit logger 의 현재 구조는 *배치 효율* 과 *전달 신뢰성* 을 모두 잡으려다 둘 다 놓쳤다.

`apps/workers/src/audit-logger/index.ts:60–71`:

```ts
await consumer.run({
  eachMessage: ({ topic, partition, message }) =>
    withKafkaContext({ ... }, async () => {
      if (!message.value) return;
      let batch = batches.get(topic);
      if (!batch) batch = { lines: [], firstOffset: message.offset };
      batch.lines.push(message.value.toString());
      if (batch.lines.length >= 1000) await flushBatch(topic);
    }),
});
```

문제는 다음 sequence 다.

```
T0:   message 1 도착 → batch.lines = ["m1"]
T0+:  eachMessage return → kafkajs auto-commit offset=1
T1:   message 2 도착 → batch.lines = ["m1", "m2"]
T1+:  offset=2 commit
...
T999: message 999 도착 → batch.lines.length = 999 (아직 1000 미달)
T999+: offset=999 commit
T1000: 프로세스 SIGKILL
결과: 999개 메시지가 메모리에서 사라짐, offset 은 이미 999까지 commit
재기동: offset 999 부터 재시작 → 999개 메시지 영구 손실
```

이 패턴은 audit logger 만이 아니다. **candle-aggregator 도 동일** 문제 (F-WORK-6):

```ts
// apps/workers/src/candle-aggregator/index.ts
eachMessage: async ({ message }) => {
  const trade = JSON.parse(message.value.toString());
  // 메모리 bucket 에 누적
  upsertBucket(trade);
  // setInterval 로 1초마다 flush
};
// eachMessage return → offset commit
```

`setInterval` 이 실행되기 전에 프로세스 죽으면 마지막 1초 분량 trade 의 candle update 영구 누락.

또한 S3 PutObject 자체가 실패하면 (F-EXT-1) `flushBatch` 의 catch 블록이 silent log 만 남기고 batch 는 이미 `batches.delete(topic)` 으로 메모리에서 제거됨.

세 문제는 하나의 본질을 공유한다: **외부 시스템 (S3 / Postgres) 으로의 flush 가 Kafka offset commit 과 분리됨**.

## Decision

### D1. eachBatch + manual commit 패턴

`eachMessage` 의 auto-commit 을 버리고 `eachBatch` + `commitOffsetsIfNecessary` 패턴 채택. flush 가 *성공한 메시지* 의 offset 만 commit.

**Audit logger 신 형태**:

```ts
await consumer.run({
  autoCommit: false,
  eachBatch: async ({ batch, resolveOffset, heartbeat, commitOffsetsIfNecessary }) => {
    const lines: string[] = [];
    let firstOffset = batch.messages[0]?.offset;
    let lastResolved: string | undefined;

    for (const message of batch.messages) {
      if (!isRunning() || isStale()) break;
      if (message.value) lines.push(message.value.toString());
      lastResolved = message.offset;
      await heartbeat();  // long batch 대비
    }

    if (lines.length === 0) return;

    // S3 flush (성공해야만 offset commit)
    const key = `${formatPath(new Date())}/${batch.topic}-${firstOffset}.jsonl`;
    try {
      await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: lines.join('\n'),
        ContentType: 'application/x-ndjson',
      }));
    } catch (err) {
      log.error({ err, key }, 'S3 flush failed — offset 미commit, 다음 fetch 에서 같은 batch 재시도');
      throw err;  // commit 안 함, 재시도
    }

    // S3 성공 → offset 진행
    if (lastResolved) resolveOffset(lastResolved);
    await commitOffsetsIfNecessary();

    metrics.auditFlushBytes.inc({ topic: batch.topic }, lines.length);
  },
});
```

**핵심 변경**:
- `autoCommit: false` 로 명시적 offset 관리
- S3 PutObject 성공 후에만 `resolveOffset` + `commitOffsetsIfNecessary`
- 실패 시 throw → kafkajs 가 같은 batch 재시도 (rebalance / 재기동 후에도)
- S3 key 가 `<topic>-<firstOffset>` 이라 같은 batch 두 번 처리되어도 같은 객체 overwrite (idempotent)

**FLUSH_MS 인터벌 / setInterval 제거**: kafkajs 가 자체 `maxWaitTimeInMs` (default 5초) 로 batch 형성. 별도 타이머 불필요.

```ts
const consumer = kafka.consumer({
  groupId: CONSUMER_GROUPS.AUDIT_LOGGER,
  maxWaitTimeInMs: 5000,        // 최대 5초 wait, 그 후 부분 batch 라도 fetch
  minBytes: 1,                   // 데이터 있으면 즉시 fetch
  maxBytes: 10 * 1024 * 1024,    // 10MB batch 한도
});
```

### D2. Candle aggregator — 동일 패턴

```ts
await consumer.run({
  autoCommit: false,
  eachBatch: async ({ batch, resolveOffset, commitOffsetsIfNecessary, heartbeat }) => {
    const buckets = new Map<BucketKey, Bucket>();
    let lastOffset: string | undefined;

    for (const message of batch.messages) {
      const trade = JSON.parse(message.value!.toString());
      mergeIntoBucket(buckets, trade);
      lastOffset = message.offset;
      await heartbeat();
    }

    if (buckets.size === 0) return;

    // Postgres upsert (성공해야만 offset commit)
    try {
      await prisma.$transaction(
        Array.from(buckets.values()).map((b) => prisma.candle.upsert({
          where: { market_interval_openTime: { ... } },
          create: { ... },
          update: { ... },
        })),
        { timeout: 30_000 },
      );
    } catch (err) {
      log.error({ err }, 'candle upsert failed — offset 미commit');
      throw err;
    }

    if (lastOffset) resolveOffset(lastOffset);
    await commitOffsetsIfNecessary();
  },
});
```

`(market, interval, openTime)` unique 가 idempotent 보장. 같은 batch 가 두 번 처리되어도 candle 결과 동일.

### D3. S3 batch 의 idempotent key 보장

현재 `<topic>-<firstOffset>.jsonl` 가 의도는 맞지만, `firstOffset` 이 *batch 의 첫 메시지 offset* 이라 batch 경계가 일관되지 않으면 같은 데이터가 다른 key 로 저장될 가능성.

**보강**:
- key 에 `partition` 도 포함: `<topic>-<partition>-<firstOffset>.jsonl`
- batch 의 메시지 수도 메타데이터로: `<topic>-<partition>-<firstOffset>-<count>.jsonl` 또는 `Metadata: { 'orbit-count': '999' }`

이로써 운영자가 S3 객체만 보고 "이 객체가 어떤 offset 범위를 담고 있는지" 즉시 파악.

### D4. Backpressure / batch 한도

`maxBytes: 10MB` + `maxWaitTimeInMs: 5000`. batch 한도 도달 시 부분 flush 됨.

실패 시 retry 가 같은 batch 를 다시 가져오므로 메모리 한도는 사실상 `maxBytes` 와 동일. 영구히 메모리에서 누적되지 않음.

### D5. 메트릭

```
orbit_audit_flush_total{topic, result="success|failure"}
orbit_audit_flush_bytes{topic}
orbit_audit_flush_duration_ms{topic}
orbit_audit_consumer_lag                   # ConsumerGroupOffsets vs latest

orbit_candle_upsert_total{result="success|failure"}
orbit_candle_upsert_duration_ms
orbit_candle_consumer_lag
```

알림:
- `orbit_audit_consumer_lag > 10000` for 5m → WARN
- `orbit_audit_flush_total{result="failure"}` 5분 누적 > 10 → WARN
- `orbit_candle_consumer_lag > 1000` for 5m → WARN

### D6. 호환성 — `withKafkaContext` 가 eachBatch 도 지원하도록

현재 `withKafkaContext` 는 `eachMessage` 의 단일 메시지를 가정한다.

```ts
// 현재: eachMessage 용
export async function withKafkaContext<T>(
  input: { worker, topic, partition, message },
  fn: () => Promise<T>,
): Promise<T> { ... }
```

**확장**:

```ts
// eachBatch 용 — batch 단위 span 으로 감쌈
export async function withKafkaBatchContext<T>(
  input: { worker, topic, partition, firstMessage: KafkaMessage, batchSize: number },
  fn: () => Promise<T>,
): Promise<T> {
  // firstMessage 의 traceparent 만 사용
  // span 이름: `<topic> process_batch`
  // attributes: messaging.batch.message_count
}
```

또는 단순화: per-message span 은 포기하고 batch 전체를 하나의 span 으로. trace 분해능은 떨어지지만 성능과 정합성은 안정.

**권장**: batch span 우선. 디버깅 시 message-level span 이 필요하면 그때 추가.

## Consequences

### Positive

- F-WORK-2, F-WORK-6, F-EXT-1 closed.
- audit / candle 모두 진정한 at-least-once. 외부 의존 (S3, Postgres) 단절 시 데이터 보존.
- 메시지 batch 처리로 throughput 향상 (S3 PutObject 호출 수 감소).
- offset commit 의 의미가 명확: "이 offset 까지의 메시지가 외부 sink 에 도달했다".

### Negative

- batch 처리는 *지연 비용* 발생. audit 의 경우 최대 5초 (maxWaitTimeInMs) + S3 latency. 운영 영향 미미하지만 SLO 명시 필요.
- batch 의 idempotency 가 sink 측 (S3 key, Postgres unique) 에 의존. 패턴이 깨지면 중복 발생.
- `eachBatch` 가 `eachMessage` 보다 코드 복잡도 ↑. heartbeat 호출 누락 시 rebalance 문제. 가이드 필요.

### Neutral

- ADR-0003 의 dedupe (B3) 와 결합 시 상호 보완: at-least-once × consumer dedupe = effectively-once.
- `setInterval` 기반 flush 가 사라지면서 코드 흐름이 *kafkajs 의 batch lifecycle 에 일치*. 더 단순.

## Implementation notes

영향 파일:
- `apps/workers/src/audit-logger/index.ts` — eachBatch 로 재작성
- `apps/workers/src/candle-aggregator/index.ts` — 동일
- `packages/observability/src/kafka-trace.ts` — `withKafkaBatchContext` 추가 (또는 기존 함수 시그니처 확장)
- `packages/observability/src/metric-names.ts` — audit/candle 메트릭 추가
- `infra/grafana/dashboards/orbit-kafka-workers.json` — flush rate / lag 패널

테스트 케이스:
1. 999 메시지 메모리에 누적 후 SIGKILL → 재기동 시 같은 999 메시지 재consume → S3 에 모두 저장
2. S3 PutObject 가짜 throw → 같은 batch 무한 retry 까지는 아니더라도 retry 가 됨 (kafkajs 기본 + ADR-0004 의 retry policy)
3. 같은 batch 가 rebalance 로 두 번 처리 → S3 객체는 동일 key 로 overwrite → 결과 동일
4. candle 의 `(market, interval, openTime)` unique 가 중복 처리 흡수
5. `maxBytes: 10MB` 한도 도달 시 부분 flush 후 다음 batch 로 진행

## Alternatives considered

### Alt A. eachMessage 유지 + Kafka transactional consumer

Kafka transactional API 로 offset commit 과 외부 publish 를 atomic 으로.

**Rejected**:
- S3 / Postgres 는 Kafka transaction 의 일부가 아니라 본질적으로 결합 불가
- 가능한 경우는 Kafka → Kafka 토폴로지 (Kafka Streams) 만

### Alt B. 메모리 batch 유지 + 별도 outbox

audit logger 가 메모리 → Postgres outbox → S3 relay.

**Rejected**:
- ADR-0002 의 outbox 와 의도가 다른 곳에 도입 → 복잡도
- audit 의 sink 가 *S3 단일* 이라 굳이 중간 단계 불필요

### Alt C. eachBatch + manual commit 을 모든 worker 에 적용

market-data-fanout, notification 도 batch 로.

**Considered but rejected (현재 ADR 범위 밖)**:
- fanout 은 *low-latency* 가 핵심이라 batch 지연 부적절
- notification 은 외부 API (SNS) 호출이 메시지당 1회라 batch 의미 없음
- 두 worker 의 idempotency 는 ADR-0003 (Redis dedupe) 로 충분

따라서 batch 패턴은 **sink 가 batch-friendly 한 worker (audit, candle)** 에만 적용.

### Alt D. Kafka Connect 로 audit 자동화

Confluent S3 Sink Connector 사용.

**Rejected**:
- Confluent Platform / Kafka Connect 도입은 학습 단계에 과한 인프라
- Connect 자체의 운영 부담이 audit logger 직접 구현보다 큼
- 운영 단계에서는 재검토 가치

## Follow-ups

- audit S3 객체의 lifecycle 정책 (1년 후 Glacier, 7년 후 삭제)
- candle 의 watermark 정책 (F-WORK-7 — late-arriving trade)
- ADR-0003 의 dedupe 와 상호작용 검증 (audit / candle 둘 다 dedupe 불필요한가?)
- Multi-sink: audit 을 S3 + Postgres 둘 다로 (조회 편의)
