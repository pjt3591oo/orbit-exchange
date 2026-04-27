# ADR-0004 — DLQ 토폴로지와 Replay 절차

- **Status**: Proposed
- **Date**: 2026-04-27
- **Deciders**: 본 프로젝트 owner
- **Related**: F-WORK-3, F-WORK-4, F-OBS-1

## Context

`packages/shared/src/constants.ts:13` 에 `DLQ: 'orbit.dlq.v1'` 토픽이 정의돼 있지만:
- 어디서도 발행하지 않음 (orphan producer)
- 어디서도 소비하지 않음 (orphan consumer)
- 메트릭 / 알림 없음

결과적으로 **poison message** 가 발생하면 다음 중 하나가 일어난다:

1. Notification worker: SNS publish 실패 → throw → kafkajs 재consume → 다시 throw → … 무한 루프, lag 폭증
2. Market-data-fanout: Redis publish 실패 → 동일
3. Audit-logger: S3 PutObject 실패 → catch (silent log) → 그러나 batch 가 이미 메모리에서 제거됨 → 영구 손실
4. Candle-aggregator: Postgres upsert 실패 → catch → dirty set 에 다시 추가 → 무한 retry 가능

각 worker 가 *서로 다른 실패 정책* 을 갖는 것 자체가 문제다. 통일된 정책 없음 = 통일된 알림 없음 = silent corruption.

## Decision

### D1. DLQ 발행 정책 — 3-tier retry

모든 worker 는 다음 retry 전략을 따른다.

```
1. 인-flight retry (kafkajs 재consume): 2회
   - 1차: 즉시
   - 2차: 1초 backoff
2. Tier-2 retry (지연 토픽): 1회
   - orbit.retry.30s.v1 으로 republish
   - 30초 후 retry consumer 가 처리
3. DLQ:
   - 위 모두 실패 시 orbit.dlq.v1 으로 republish + 메인 토픽 offset commit
```

이 패턴은 [Uber 의 retry topology](https://www.uber.com/blog/reliable-reprocessing/) 를 단순화한 형태.

**왜 retry 토픽이 따로 필요한가?**
- 단순 in-flight retry 는 외부 의존(SNS) 이 30초 정도 down 됐을 때 그 동안 다른 메시지 처리도 막음
- retry 토픽으로 옮기면 메인 컨슈머는 진행, retry 컨슈머는 별도 lag 으로 격리
- 30s/5m/1h 등 여러 tier 로 늘릴 수 있지만, 학습 프로젝트 단계에서는 1-tier 로 시작

### D2. 토픽 정의

`packages/shared/src/constants.ts`:

```ts
export const KAFKA_TOPICS = {
  // 기존 ...
  RETRY_30S: 'orbit.retry.30s.v1',
  DLQ: 'orbit.dlq.v1',
} as const;

export const CONSUMER_GROUPS = {
  // 기존 ...
  RETRY_30S: 'orbit.retry-30s',
  DLQ_MONITOR: 'orbit.dlq-monitor',
} as const;
```

### D3. 헤더 설계

DLQ / retry 토픽의 메시지는 **원본 메시지 + 메타데이터 헤더** 로 구성.

| 헤더 | 의미 |
|---|---|
| `x-orbit-original-topic` | 원본 토픽 |
| `x-orbit-original-partition` | 원본 파티션 |
| `x-orbit-original-offset` | 원본 offset |
| `x-orbit-attempt` | 누적 시도 횟수 |
| `x-orbit-first-failure-at` | 최초 실패 timestamp |
| `x-orbit-last-error` | 마지막 에러 메시지 (truncate to 1000 chars) |
| `x-orbit-worker` | 마지막으로 실패시킨 worker 이름 |
| `x-orbit-retry-after` | retry 토픽일 때만 — 처리 가능한 timestamp |

원본 payload 는 그대로. 운영자가 replay 할 때 원본 토픽으로 그대로 republish 가능해야 함.

### D4. 공용 retry helper

`packages/observability/src/retry-policy.ts` 신규:

```ts
export interface RetryConfig {
  worker: string;
  inFlightAttempts: number;  // default 2
  retryTopic?: string;       // default RETRY_30S
  dlqTopic?: string;         // default DLQ
  producer: Producer;        // kafkajs
}

export async function withRetryPolicy<T>(
  cfg: RetryConfig,
  ctx: { topic: string; partition: number; message: KafkaMessage },
  fn: () => Promise<T>,
): Promise<T | null> {
  const attempt = parseAttempt(ctx.message);
  try {
    return await fn();
  } catch (err) {
    if (attempt < cfg.inFlightAttempts) {
      // kafkajs 가 재consume 하도록 throw
      throw err;
    }

    // tier-2 / DLQ 결정
    const targetTopic = cfg.retryTopic && attempt === cfg.inFlightAttempts
      ? cfg.retryTopic
      : cfg.dlqTopic ?? KAFKA_TOPICS.DLQ;

    await cfg.producer.send({
      topic: targetTopic,
      messages: [{
        key: ctx.message.key,
        value: ctx.message.value,
        headers: {
          ...ctx.message.headers,
          'x-orbit-original-topic': ctx.topic,
          'x-orbit-original-partition': String(ctx.partition),
          'x-orbit-original-offset': ctx.message.offset,
          'x-orbit-attempt': String(attempt + 1),
          'x-orbit-last-error': String(err).slice(0, 1000),
          'x-orbit-worker': cfg.worker,
          'x-orbit-retry-after': targetTopic === cfg.retryTopic
            ? String(Date.now() + 30_000)
            : undefined,
        },
      }],
    });

    metrics.workerDlqEnqueued.inc({ worker: cfg.worker, target: targetTopic });
    return null;  // 메인 토픽 처리는 진행 (offset commit)
  }
}
```

Worker 적용 예 (notification):
```ts
await consumer.run({
  eachMessage: ({ topic, partition, message }) =>
    withKafkaContext({ ... }, async () => {
      await withRetryPolicy({ worker: 'notification', producer }, { topic, partition, message }, async () => {
        const ev = JSON.parse(message.value!.toString());
        await withDedupe(redis, ev.eventId, 'notification', 3600, async () => {
          await sns.publish({ ... });
        });
      });
    }),
});
```

### D5. Retry consumer

`apps/workers/src/retry-30s/index.ts` 신규.

```ts
export async function runRetry30s() {
  const consumer = kafka.consumer({ groupId: CONSUMER_GROUPS.RETRY_30S });
  await consumer.subscribe({ topic: KAFKA_TOPICS.RETRY_30S });

  await consumer.run({
    eachMessage: async ({ message }) => {
      const retryAfter = Number(message.headers?.['x-orbit-retry-after']?.toString());
      const wait = retryAfter - Date.now();
      if (wait > 0) await sleep(wait);

      const originalTopic = message.headers!['x-orbit-original-topic']!.toString();
      // 원본 토픽으로 republish — 메인 컨슈머가 다시 시도
      await producer.send({
        topic: originalTopic,
        messages: [{ key: message.key, value: message.value, headers: message.headers }],
      });
    },
  });
}
```

핵심: retry 컨슈머는 **delay 후 원본 토픽으로 republish** 만 한다. 실제 처리 로직은 메인 컨슈머에 그대로 둔다.

### D6. DLQ Monitor consumer + Admin Replay UI

`apps/workers/src/dlq-monitor/index.ts`:

```ts
// DLQ 토픽을 consume 해서 DB 의 dlq_events 테이블에 저장 (운영자 조회용)
```

`apps/api/prisma/schema.prisma`:

```prisma
model DlqEvent {
  id              BigInt   @id @default(autoincrement())
  originalTopic   String
  originalPartition Int
  originalOffset  String
  payload         Bytes    // 원본 message.value
  headers         Json
  worker          String
  lastError       String   @db.Text
  attempt         Int
  firstFailureAt  DateTime
  enqueuedAt      DateTime @default(now())
  resolvedAt      DateTime?     // 운영자가 replay/dismiss 한 시점
  resolution      String?       // 'replayed' | 'dismissed'
  resolvedBy      String?       // 관리자 email

  @@index([resolvedAt, enqueuedAt])
  @@index([originalTopic, enqueuedAt])
}
```

Admin UI (apps/admin/src/pages/Dlq.tsx 신규):
- 미해결 DLQ 메시지 목록 (그룹: worker × originalTopic)
- 각 행: payload preview, lastError, attempt count, age
- 액션 2개:
  1. **Replay** — DLQ 메시지를 원본 토픽으로 republish + `resolvedAt = now`, `resolution = 'replayed'`
  2. **Dismiss** — 처리 불가능으로 마킹 + `resolution = 'dismissed'`

모든 액션은 `AdminAuditLog` 에 자동 기록 (이미 있는 `@AdminAction` 데코레이터 활용).

### D7. 메트릭 & 알림

```
orbit_worker_retry_enqueued_total{worker, target="retry-30s|dlq"}
orbit_worker_retry_processed_total{worker, success="true|false"}
orbit_dlq_pending_count                # 미해결 DLQ 행 수
orbit_dlq_oldest_age_seconds           # 가장 오래된 미해결 행 나이
```

알림 룰:
- `orbit_worker_retry_enqueued_total{target="dlq"}` 가 5분 평균 > 10/min → WARN
- `orbit_dlq_pending_count > 100` → CRITICAL
- `orbit_dlq_oldest_age_seconds > 86400` (1일) → WARN

이로써 F-OBS-1 closed.

### D8. 어떤 메시지가 DLQ 로 가야 하는가 — 판정 기준

retry 후에도 실패하는 케이스를 **장기 vs 단기 장애** 로 구분:

- **장기 장애 (DLQ 적합)**: schema 가 깨진 메시지, 비즈니스 invariant 위반, 외부 API 의 영구 거부 (4xx)
- **단기 장애 (retry 토픽 적합)**: 외부 API 의 5xx/timeout, broker 단절 직후, 네트워크 unreachable

판정은 **에러 타입** 으로 한다.

```ts
function classifyError(err: Error): 'transient' | 'permanent' {
  if (err.name === 'KafkaJSError') return 'transient';
  if (err.message.includes('429')) return 'transient';  // rate limit
  if (err.message.includes('5')) return 'transient';     // 5xx
  if (err.message.includes('4')) return 'permanent';     // 4xx
  if (err instanceof ZodError) return 'permanent';       // schema
  return 'transient';  // default safe
}
```

`withRetryPolicy` 내부에서 분류 → permanent 면 retry 토픽 건너뛰고 즉시 DLQ.

## Consequences

### Positive

- F-WORK-3, F-WORK-4 closed.
- 외부 API 가 30분 down 되어도 메인 토픽 처리 안 막힘.
- Poison message 가 silent corruption 일으키지 않음 — 운영자가 알아챔.
- 같은 retry helper 를 모든 worker 가 공유 — DRY.
- 운영자 friendly: admin UI 에서 직접 replay/dismiss.

### Negative

- 신규 토픽 2개 + 신규 컨슈머 그룹 2개 + 신규 워커 2개 (retry, dlq-monitor) + 신규 admin 페이지 1개. 적은 작업은 아님.
- DLQ 가 채워지는 속도가 운영자가 처리하는 속도보다 빠르면 결국 같은 lag 문제. 알림 + per-worker 한도 설계 중요.
- retry 토픽 도입으로 메시지 순서 보장이 깨짐 (retry 된 메시지는 원본보다 늦게 도착). order-relevant 한 토픽 (예: order-commands) 에는 retry 토픽 우회 — 직접 DLQ 로 보냄.

### Neutral

- 학습 단계에서는 retry-30s 1-tier 만. 운영 단계에서 5m, 1h 추가 가능.

## Implementation notes

영향 파일:
- `packages/shared/src/constants.ts` — RETRY_30S 추가
- `packages/observability/src/retry-policy.ts` — 신규
- `apps/workers/src/{notification,market-data-fanout,candle-aggregator}/index.ts` — `withRetryPolicy` 적용
- `apps/workers/src/retry-30s/index.ts` — 신규
- `apps/workers/src/dlq-monitor/index.ts` — 신규
- `apps/workers/src/main.ts` — 신규 워커 등록
- `apps/api/prisma/schema.prisma` — `DlqEvent` 모델
- `apps/api/src/admin/dlq/` — DLQ 관련 admin API
- `apps/admin/src/pages/Dlq.tsx` — 신규
- `apps/admin/src/router.tsx` — 라우트 추가
- `infra/grafana/dashboards/orbit-kafka-workers.json` — DLQ 패널 추가

순서 보장이 중요한 토픽 (`orbit.order-commands.v1`):
- matcher 의 retry 정책: in-flight 2회 → 즉시 DLQ (retry 토픽 건너뜀)
- DLQ 의 order command 는 운영자가 *수동 대응* (replay 시 다른 SUBMIT 사이에 끼어들면 가격-시간 우선순위 깨짐)

테스트 케이스:
1. notification worker 에 SNS 가짜 throw 주입 → 2회 inflight → retry 토픽 → 30초 후 재시도 → 성공
2. permanent error (zod fail) 주입 → retry 토픽 건너뛰고 즉시 DLQ
3. admin UI 에서 DLQ replay 버튼 → 원본 토픽으로 republish + audit log 기록
4. retry 토픽 컨슈머가 죽었다 살아남 → 미처리 메시지 catch up

## Alternatives considered

### Alt A. 모든 처리 실패를 메인 토픽에서 무한 in-flight retry

**Rejected**: 외부 API 1분 down → 그 동안의 모든 메시지가 한 메시지 retry 에 막힘. 학습 단계에도 명백히 부적절.

### Alt B. 외부 라이브러리 (BullMQ 등) 도입

**Rejected**: Redis 기반 별도 큐 시스템 추가. Kafka 만 쓰는 현 토폴로지 유지가 단순.

### Alt C. retry 토픽 multi-tier (30s, 5m, 1h)

**Considered but deferred**: 학습 단계에서는 1-tier 로 충분. 외부 의존 down 시간이 30초 이상으로 길어지면 추가.

### Alt D. retry 정책을 ConfigMap 으로 외부화

**Considered but deferred**: 운영 단계에서 의미. 학습 단계에서는 코드 상수로.

## Follow-ups

- Multi-tier retry (30s / 5m / 1h)
- Retry 정책의 동적 변경 (ConfigMap / DB-backed)
- 자동 replay (특정 에러는 운영자 개입 없이 N분 후 재시도)
- Admin UI 의 bulk replay (같은 worker 의 여러 DLQ 한 번에)
