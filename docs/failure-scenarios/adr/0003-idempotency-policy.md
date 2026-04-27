# ADR-0003 — Idempotency 정책 통합

- **Status**: Proposed
- **Date**: 2026-04-27
- **Deciders**: 본 프로젝트 owner
- **Related**: F-API-3, F-MATCH-4, F-WORK-5, F-OBS-5

## Context

ORBIT 의 멱등성 처리는 현재 *부분적이고 서로 다른 패턴* 으로 흩어져 있다.

| 위치 | 현재 처리 | 결함 |
|---|---|---|
| API `/orders` POST | 없음 | 같은 요청 두 번 → Order 두 개 |
| Matcher SUBMIT command | order status terminal-check (FILLED/CANCELLED 면 no-op) | immediate-fill 후 재consume 케이스 불명확 |
| Matcher CANCEL command | 동일 | OK |
| Settler trade row | autoincrement id, unique 제약 없음 | 같은 trade 두 번 → row 두 개 |
| Workers (notification) | 없음 | 같은 trade event → 알림 두 번 |
| Workers (market-data-fanout) | 없음 | 같은 trade event → WS 클라이언트에 중복 tick |
| Workers (candle-aggregator) | `(market, interval, openTime)` unique upsert | OK |
| Workers (audit-logger) | S3 key = `<topic>-<firstOffset>` overwrite | OK (단, F-WORK-2 는 별개 문제) |

이 패치워크는 **idempotency 의 정책이 없다는 것** 을 보여준다. 어떤 boundary 에서 dedupe 할지, 어떤 키로 할지, 어디에 저장할지 통일된 답이 없다.

ADR-0002 의 outbox 가 at-least-once 를 강제하므로, **모든 consumer 는 idempotent 여야 한다**. 따라서 정책을 먼저 결정해야 다른 ADR 들이 자기 자리를 잡는다.

## Decision

### D1. 멱등성을 보장해야 하는 boundary 3종

| Boundary | 키 | 저장소 | TTL |
|---|---|---|---|
| **B1. HTTP 사용자 요청** (POST /orders, DELETE /orders/:id) | `Idempotency-Key` 헤더 (UUID v4 권장) | Postgres `IdempotencyKey` 테이블 | 24h |
| **B2. Kafka command consumer** (matcher) | `commandId` (UUID v4, API 가 생성) | Postgres `Order.commandId` unique 인덱스 | 영구 |
| **B3. Kafka event consumer** (workers) | `eventId` (UUID v4, matcher 가 생성) | Redis SET NX | 1h |

세 boundary 가 서로 다른 저장소를 쓰는 이유는 *접근 패턴* 이 다르기 때문이다.

- **B1**: 사용자 응답에 직접 영향 (HTTP body 재현 필요) → response cache 까지 같이 저장. Postgres 가 적합.
- **B2**: 자금 정합성 영향 → 영구 보존. Order 테이블의 컬럼으로 추가하면 별도 dedupe 저장소 불필요.
- **B3**: 단순 "이 event 처리한 적 있나?" → 짧은 TTL 로 충분. Redis SETNX 의 비용/속도가 적합.

### D2. Idempotency-Key 테이블 (B1)

`apps/api/prisma/schema.prisma`:

```prisma
model IdempotencyKey {
  id           BigInt   @id @default(autoincrement())
  userId       String
  key          String   // 클라이언트가 보낸 헤더 값
  method       String   // POST / DELETE
  path         String   // /api/v1/orders
  requestHash  String   // body sha256 (요청 본문이 다르면 다른 결과 반환)
  responseStatus Int
  responseBody Json
  createdAt    DateTime @default(now())
  expiresAt    DateTime  // createdAt + 24h

  @@unique([userId, key, method, path])
  @@index([expiresAt])  // cleanup 용
}
```

처리 흐름 (NestJS interceptor):

```ts
// IdempotencyInterceptor
async intercept(context, next) {
  const req = context.switchToHttp().getRequest();
  const key = req.headers['idempotency-key'];
  if (!key || !isValidUUID(key)) return next.handle();  // optional

  const userId = req.user.id;
  const requestHash = sha256(JSON.stringify(req.body));

  // 1. 기존 키 조회
  const existing = await prisma.idempotencyKey.findUnique({
    where: { userId_key_method_path: { userId, key, method: req.method, path: req.path } },
  });
  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new ConflictException('Idempotency-Key reused with different body');
    }
    // 캐시된 응답 반환
    return of(existing.responseBody).pipe(map((body) => {
      context.switchToHttp().getResponse().status(existing.responseStatus);
      return body;
    }));
  }

  // 2. 신규 처리 — 핸들러 실행 후 응답 저장
  return next.handle().pipe(
    tap(async (body) => {
      await prisma.idempotencyKey.create({
        data: {
          userId, key, method: req.method, path: req.path,
          requestHash,
          responseStatus: res.statusCode,
          responseBody: body,
          expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
        },
      }).catch(/* unique violation = 동시 요청, 재조회로 fallback */);
    }),
  );
}
```

**중요**: `Idempotency-Key` 는 *optional* 이지만 클라이언트(SDK 포함)가 강력 권장. 운영 단계에서는 mutating 엔드포인트에 *required* 로 승격.

**같은 키 + 다른 body**: 409 Conflict 반환. 클라이언트의 버그 / 키 재사용을 방지.

### D3. Order.commandId (B2)

`apps/api/prisma/schema.prisma`:

```prisma
model Order {
  // 기존 필드 ...
  commandId String @unique  // API 가 publish 시 생성한 UUID, matcher 가 dedupe 용
}
```

API 측:
```ts
const cmd: OrderSubmitCommand = {
  commandId: randomUUID(),  // 신규
  orderId: order.id,
  market: order.market,
  // ...
};
await tx.outboxEvent.create({ ... });
```

Matcher 측 (`SettlerService` 내):
```ts
const order = await tx.order.findUnique({ where: { id: cmd.orderId } });
if (order.commandId !== cmd.commandId) {
  // commandId 불일치 — 이미 다른 command 가 처리됨 (불가능한 케이스)
  throw new Error('commandId mismatch');
}
if (order.status === 'FILLED' || order.status === 'CANCELLED') {
  return null;  // 멱등 분기
}
// 정상 처리
```

immediate-fill 후 재consume 케이스 (F-MATCH-4):
- 첫 처리 후 `order.status = FILLED`
- 재consume 시 status 분기로 no-op
- ✅ 멱등 성립

CANCEL 의 경우도 동일.

### D4. Worker dedupe via Redis SETNX (B3)

```ts
// packages/observability/src/idempotency.ts (신규)
export async function withDedupe<T>(
  redis: Redis,
  eventId: string,
  worker: string,
  ttlSec: number,
  fn: () => Promise<T>,
): Promise<T | null> {
  const key = `dedupe:${worker}:${eventId}`;
  const acquired = await redis.set(key, '1', 'EX', ttlSec, 'NX');
  if (acquired !== 'OK') {
    metrics.dedupeHit.inc({ worker });
    return null;  // 이미 처리됨
  }
  metrics.dedupeMiss.inc({ worker });
  try {
    return await fn();
  } catch (err) {
    // 처리 실패 시 dedupe key 삭제 (재시도 허용)
    await redis.del(key);
    throw err;
  }
}
```

Worker 사용 예 (notification):
```ts
await consumer.run({
  eachMessage: ({ message }) =>
    withKafkaContext({ ... }, async () => {
      const ev = JSON.parse(message.value!.toString());
      await withDedupe(redis, ev.eventId, 'notification', 3600, async () => {
        await sns.publish({ TopicArn, Message: JSON.stringify(ev) });
      });
    }),
});
```

핵심 설계:
- **TTL 1h**: rebalance / replay 로 인한 중복은 보통 분 단위라 1h 면 충분.
- **실패 시 키 삭제**: 외부 API 실패 시 재시도 가능하게.
- **Worker 별 prefix**: 같은 eventId 라도 worker 가 다르면 dedupe 충돌 안 함.

### D5. Trade row 멱등성 — DB 제약으로 강제

`apps/api/prisma/schema.prisma`:

```prisma
model Trade {
  // 기존 필드 ...
  matchId String @unique  // matcher 가 생성한 매칭 ID
}
```

settler.service.ts:
```ts
// engine.match() 가 반환하는 각 매칭에 대해 unique matchId 생성
const matchId = `${makerOrderId}-${takerOrderId}-${seq}`;
await tx.trade.create({
  data: { matchId, makerOrderId, takerOrderId, ... }
});
// unique violation 시 catch → 이미 처리됨 → no-op
```

이로써 outbox relay 가 같은 settle command 를 두 번 deliver 해도 trade row 는 1개만.

### D6. 메트릭

```
orbit_idempotency_hit_total{boundary="http|command|event", worker="..."}
orbit_idempotency_miss_total{boundary="...", worker="..."}
orbit_idempotency_conflict_total{boundary="http"}  # body 불일치
```

대시보드: `orbit-idempotency-overview.json` (신규).

이로써 F-OBS-5 closed.

## Consequences

### Positive

- F-API-3, F-MATCH-4, F-WORK-5 closed.
- ADR-0002 의 outbox 가 at-least-once 를 강제하더라도 사용자 체감 effect 는 exactly-once.
- 운영자가 dedupe hit/miss 메트릭으로 *얼마나 자주 중복이 발생하는지* 가시적.
- 새로운 worker 추가 시 같은 패턴 (`withDedupe`) 으로 재사용 가능.

### Negative

- 모든 mutating 엔드포인트에 `Idempotency-Key` 처리 추가 — interceptor 적용으로 단순화하지만 schema migration 필요.
- Redis dedupe 가 Redis 가용성에 의존 — Redis 단절 시 worker 가 중복 처리 가능. 학습 단계 수용. 운영 단계에서는 fallback 으로 PostgreSQL dedup table 도 옵션.
- IdempotencyKey 테이블 cleanup 잡 필요 (cron `DELETE WHERE expiresAt < now()`).

### Neutral

- B1/B2/B3 의 *서로 다른 저장소* 가 처음에는 비대칭으로 보일 수 있으나, 각 boundary 의 접근 패턴에 맞춘 의식적 결정.

## Implementation notes

영향 파일:
- `apps/api/prisma/schema.prisma` — `IdempotencyKey`, `Order.commandId`, `Trade.matchId`
- `apps/api/src/idempotency/idempotency.interceptor.ts` — 신규
- `apps/api/src/idempotency/cleanup.cron.ts` — 신규 (5분마다 expired 삭제)
- `apps/api/src/order/order.controller.ts` — interceptor 적용
- `apps/matcher/src/settler/settler.service.ts` — commandId 검증 + matchId 부여
- `packages/observability/src/idempotency.ts` — `withDedupe` helper
- `apps/workers/src/notification/index.ts`, `market-data-fanout/index.ts` — `withDedupe` 적용
- `packages/shared/src/types/` — `OrderSubmitCommand` 등에 `commandId` 추가, `TradeEvent` 에 `eventId`
- `infra/grafana/dashboards/orbit-idempotency-overview.json` — 신규
- README §SDK 섹션에 `Idempotency-Key` 사용 가이드 추가

테스트 케이스:
1. 같은 키 + 같은 body → 같은 응답
2. 같은 키 + 다른 body → 409 Conflict
3. 24h 후 같은 키 → 신규 처리
4. matcher 가 같은 commandId 두 번 처리 → 두 번째는 no-op
5. notification worker 가 같은 eventId 두 번 → 알림 1번만
6. Redis 단절 중 worker 의 동작 (fallback 정책 검증)

## Alternatives considered

### Alt A. Idempotency-Key 를 Redis 에만 저장

- 장점: 빠름
- **Rejected**: response body 캐싱이 필요한데 Redis value 크기 제약 + 24h TTL 이라 Postgres 가 더 적합

### Alt B. consumer dedupe 도 Postgres unique 로

- **Rejected**: Trade 의 matchId 처럼 *영구 데이터* 와 결합된 케이스만 unique 로. 알림/fanout 같은 단순 처리는 Redis SETNX 가 비용/속도 모두 우월.

### Alt C. Idempotency-Key 를 모든 GET 에도 적용

- **Rejected**: GET 은 본질적으로 idempotent. Idempotency-Key 는 *non-idempotent* 동사 (POST/PUT/DELETE/PATCH) 에만.

### Alt D. Stripe-style: key 충돌 시 first-write-wins lock

Stripe 는 *진행 중* 인 동일 key 요청을 lock 으로 직렬화.

- **Considered but deferred**: 학습 단계에서는 단순 unique 로 충분. 운영 진입 시 동시 요청의 race 처리를 추가.

## Follow-ups

- Stripe-style request lock (동시 요청의 동일 key 직렬화)
- B3 의 Postgres fallback (Redis 단절 시)
- ADR-0002 의 outbox 와 통합된 통합 테스트 시나리오
