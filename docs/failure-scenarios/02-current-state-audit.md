# 코드 실측 — 현재 어떻게 처리되는가

본 문서는 [`01-component-inventory.md`](01-component-inventory.md) 가 나열한 잠재 장애 항목 각각에 대해 **현재 코드가 어떻게 처리하는지** 를 file:line 인용으로 검증한다.

각 항목은 다음 형식이다.

> **F-XYZ-N** — 1과 동일한 식별자
> - **현재 처리**: 코드에서 무엇을 하고 있는가 (있으면 인용, 없으면 "None")
> - **검증**: 그 처리가 의도한 보장을 *실제로* 충족하는가
> - **판정**: ✅ OK / ⚠️ Partial / ❌ Missing

판정의 의미:
- ✅ 처리되어 있고 빈틈도 없음
- ⚠️ 부분 처리. 의도는 있지만 boundary 가 새거나 corner case 가 빠짐
- ❌ 처리 자체가 없음

---

## 1. apps/api 영역

### F-API-1. DB insert 성공 / Kafka publish 실패

**현재 처리** — `apps/api/src/order/order.service.ts:99–135`:

```ts
const order = await this.prisma.$transaction(
  async (tx) => {
    await this.lockReservation(tx, userId, market, dto, quantity, limitPrice);
    return tx.order.create({ ... });
  },
  { isolationLevel: 'ReadCommitted', timeout: 10_000 },
);

this.kafka
  .send<OrderSubmitCommand>(KAFKA_TOPICS.ORDER_COMMANDS, dto.market, cmd)
  .catch((err) => this.log.error(`publish SUBMIT failed: ${err.message}`));
```

- 트랜잭션 commit 후 publish, 그리고 publish 의 실패는 **로그만 남기고 fire-and-forget**.
- Producer 자체는 idempotent + 8회 retry (`apps/api/src/kafka/kafka-producer.service.ts:21-26`).

**검증**:
- 8회 retry 가 모두 실패하면? → `.catch()` 는 silently 로그.
- HTTP 응답은 이미 200 으로 나간 뒤. 사용자는 주문이 정상 접수된 줄 앎.
- 자금은 DB 에 lock 된 채로 영구히 남음. 운영자 수동 보정 외에 자동 회복 경로 없음.
- 코드 주석 `// TODO outbox` 가 line 120 에 존재 — 의도 자체는 인지 중.

**판정**: ❌ **Missing**. Producer retry 는 일시적 단절에 도움 되지만, retry 모두 실패 케이스의 회복이 없음.

---

### F-API-2. DB rollback / Kafka publish 성공

**현재 처리** — 같은 파일 구조상, publish 는 항상 트랜잭션 *밖* 에서 일어남.

**검증**: 코드 흐름상 commit 이 성공해야만 publish 도달. 따라서 DB rollback + Kafka publish 성공은 발생 불가.

**판정**: ✅ **OK**. (단, outbox 도입 시 이 보장이 깨지지 않게 주의.)

---

### F-API-3. 같은 요청의 중복 처리 (네트워크 retry)

**현재 처리** — `apps/api/src/order/order.controller.ts`, `dto.ts:1–23` 어디에도 `Idempotency-Key` 헤더 처리 없음. Postgres schema 에 `IdempotencyKey` 테이블 없음.

**검증**: 클라이언트가 timeout 후 재요청하면 같은 의도의 Order 가 두 건 생성됨.

**판정**: ❌ **Missing**. → ADR-0003.

---

### F-API-4. 트랜잭션 timeout 중 publish 시작

**현재 처리**: timeout 옵션 `10_000` ms 설정. 트랜잭션이 timeout 되면 `prisma.$transaction()` 이 throw → publish 실행 안 됨.

**검증**: timeout 케이스는 publish 를 막아주므로 데이터 정합성은 OK. 단 사용자에게는 5xx.

**판정**: ✅ **OK** (정합성 측면).

---

### F-API-5. Producer fence / 재초기화

**현재 처리** — `apps/api/src/kafka/kafka-producer.service.ts`: kafkajs 의 `idempotent: true` + `maxInFlightRequests: 5` + `retries: 8`. Producer fence 시 자동 재초기화 로직은 없음.

**검증**: kafkajs 가 일부 케이스를 자동으로 처리하긴 하나, transactional producer 는 아니라 fence 시나리오 자체가 흔하진 않음.

**판정**: ⚠️ **Partial**. 운영 시 모니터링 필요.

---

### F-API-6. Cancel 명령 발행 중 매처가 fill

**현재 처리** — `apps/matcher/src/settler/settler.service.ts:128–184`:

```ts
const order = await tx.order.findUnique({ where: { id } });
if (order.status === 'FILLED' || order.status === 'CANCELLED') {
  return { ok: true, reason: 'already-terminal' };
}
```

**검증**: 후행 도착한 cancel 은 status 가 FILLED 면 no-op. 의도대로 작동.

**판정**: ✅ **OK**.

---

## 2. apps/matcher 영역

### F-MATCH-1. 프로세스 크래시 → 인메모리 orderbook 손실

**현재 처리** — `apps/matcher/src/matching/matching-engine.service.ts:78–93`:

```ts
async replayOpenOrders() {
  const orders = await this.prisma.order.findMany({
    where: { status: { in: ['OPEN', 'PARTIAL'] }, type: 'LIMIT' },
    orderBy: [{ market: 'asc' }, { createdAt: 'asc' }],
  });
  for (const o of orders) engine.add(o);
}
```

부팅 시 `OnModuleInit` 가 호출.

**검증**:
- LIMIT 주문은 DB 에서 복원 — ✓
- MARKET 주문은 inflight 상태로 처리 중이었으면 손실 — DB 에 status 로 남기 전 크래시 시 처리 안 됨
- 가격-시간 우선순위가 `createdAt asc` 로 보장됨 — ✓ (단 microsecond 동률 시 비결정적)

**판정**: ⚠️ **Partial**. DB 기반 replay 자체는 정공법이지만, in-flight MARKET 주문 / 이미 매칭됐지만 정산 안 끝난 trade 의 처리가 불명확. → ADR-0001.

---

### F-MATCH-2. Replay 중 신규 command 도착

**현재 처리** — NestJS 의 `OnModuleInit` 라이프사이클은 모든 모듈의 `onModuleInit` 이 끝난 후에야 `app.listen()` / consumer.run() 이 시작됨. `replayOpenOrders` 는 `MatchingEngineService.onModuleInit` 안에서 await.

**검증**: 라이프사이클상 replay 완료 → consumer 시작이 보장됨. 단, 이는 *컨벤션* 이며 향후 `onApplicationBootstrap` 등으로 옮기면 깨질 수 있음.

**판정**: ✅ **OK** (현재 시점). 단 명시적 readiness flag 가 없어 fragile.

---

### F-MATCH-3. Kafka offset commit 후 후속 publish 실패

**현재 처리** — `apps/matcher/src/consumer/command-consumer.service.ts:57–142`:

```ts
await this.matching.run(cmd.symbol, async () => {
  // 1. settle in $transaction (DB)
  // 2. publishSubmitEvents() → trade / orderbook / user-events publish
});
// eachMessage 가 return 하면 kafkajs 가 offset auto-commit
```

`publishSubmitEvents` 의 실패는 line 128–134 에서 catch.

```ts
} catch (err) {
  result = 'error';
  this.log.error(`command failed type=${cmd.type}...`);
}
```

**검증**:
- DB transaction commit 후 publish 실패 → 에러 로그 → eachMessage 정상 return → **offset commit**
- 다음 부팅 시 같은 command 가 다시 안 옴 → trade event 가 영구히 publish 안 됨
- DB 에는 trade row 가 있음, downstream consumer 는 모름

**판정**: ❌ **Missing**. **CRITICAL** — 자금 정합성 영향. → ADR-0002.

---

### F-MATCH-4. 같은 command 중복 consume

**현재 처리**:
- SUBMIT: order id 가 이미 책에 있으면 engine 이 add 거부 (orderbook-match-engine 동작에 의존)
- 정산: status terminal-check (`F-API-6` 처리와 동일)
- commandId 별도 dedupe 저장소: 없음

**검증**:
- 같은 SUBMIT 이 두 번 처리되면 첫 처리는 정상, 두 번째는 add 시점에 거부 가능성 있음 (단, 이미 fill 됐으면 status 가 FILLED 라 no-op)
- 같은 CANCEL 두 번도 두 번째는 status check 로 흡수
- **단**: SUBMIT 후 immediate fill 까지 다 끝난 상태에서 같은 SUBMIT 재consume 되면? → DB 에는 FILLED 로 있음 → `engine.add` 호출 시점에 status 확인 안 함 → 책에 또 add 시도 → 두 번째 fill?

**판정**: ⚠️ **Partial**. SUBMIT 의 immediate-fill 후 재consume 케이스가 검증 안 됐음. → ADR-0003.

---

### F-MATCH-5. 마켓 간 bulkhead

**현재 처리**: per-market p-queue (concurrency=1) 이지만, 모든 큐가 같은 Node 이벤트 루프에서 돈다.

**검증**: 같은 마켓 안의 순서는 보장. 마켓 간 격리는 없음. 한 마켓이 CPU 100% 쓰면 다른 마켓의 latency 도 함께 영향.

**판정**: ❌ **Missing**. → 향후 ADR (이번 6개에는 미포함, follow-up 으로 표시).

---

### F-MATCH-6. DB transaction timeout 중 fill

**현재 처리** — settler.service.ts: `prisma.$transaction(..., { timeout: 10_000 })`. timeout 시 throw.

**검증**: 트랜잭션이 throw 되면 in-memory engine 의 `match()` 결과는 어떻게 됨?
- engine.match 는 이미 in-memory 상태를 변경했음 (책에서 quantity 차감)
- DB transaction 이 throw 됐으니 trade row / wallet update 는 rollback
- in-memory engine 상태는 그대로 → 책 ↔ DB 불일치

코드상 in-memory rollback 로직 없음.

**판정**: ❌ **Missing**. **CRITICAL** corner case. 발생 빈도는 낮지만 정합성 깨짐. → ADR-0001 의 sub-decision.

---

### F-MATCH-7. Snapshot TTL 만료 + 매처 부팅

**현재 처리** — `apps/matcher/src/snapshot/snapshot.service.ts:69–88`: Redis SET with 24h TTL. 부팅 시 snapshot 으로부터 책 복원하는 코드는 보이지 않음 (책 복원은 DB replay 가 담당).

**검증**: snapshot 의 역할이 사실상 "WS 클라이언트에 초기 호가창 전달용 cache" 이지 책 복원용이 아님. 따라서 TTL 만료해도 정합성 영향 없음.

**판정**: ✅ **OK**. 단 README/SYSTEM_DESIGN 에 "snapshot 의 역할은 read-side cache" 임을 명시할 필요. → ADR-0001 에 명문화.

---

### F-MATCH-8. Health vs readiness 미분리

**현재 처리** — `packages/observability/src/nest.ts:66–75`:

```ts
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));
```

정적 응답. consumer 상태 / replay 완료 여부 / DB 연결 미확인.

**검증**: 부팅 직후 replay 중에도 200 OK. k8s readiness probe 가 이걸 쓰면 책이 비어있는데 트래픽 받음.

**판정**: ❌ **Missing**. → ADR-0001 에 readiness 로직 포함.

---

## 3. apps/workers 영역

### F-WORK-1. 워커 단일 프로세스 동거

**현재 처리** — `apps/workers/src/main.ts:12–30`:

```ts
const tasks: Array<Promise<void>> = [];
if (enabled.includes('candle')) tasks.push(runCandleAggregator());
if (enabled.includes('fanout')) tasks.push(runMarketDataFanout());
if (enabled.includes('notification')) tasks.push(runNotification());
if (enabled.includes('audit')) tasks.push(runAuditLogger());
await Promise.all(tasks);
```

env var `WORKERS_ENABLED` 로 분기 가능 — 다행히 같은 이미지를 다른 deployment 로 띄울 수 있는 구조.

**검증**: 단, **현재 운영 default 는 4개 다 같이 도는 것**. 한 워커의 unhandled exception 이 `Promise.all` 의 reject 로 전파 → 프로세스 종료 → 4개 다 죽음.

**판정**: ⚠️ **Partial**. 분리할 수 있는 *가능성* 은 있지만 default 가 위험. → ADR-0005.

---

### F-WORK-2. Audit logger — offset commit / S3 flush 분리

**현재 처리** — `apps/workers/src/audit-logger/index.ts:60–71`:

```ts
await consumer.run({
  eachMessage: ({ topic, partition, message }) =>
    withKafkaContext({ ... }, async () => {
      // ... batch.lines.push(message.value.toString());
      if (batch.lines.length >= 1000) await flushBatch(topic);
    }),
});
```

`setInterval(flushBatch, FLUSH_MS)` 는 별도 타이머 (line 56–58).

**검증**:
- `eachMessage` 가 return → kafkajs auto-commit
- batch.lines 가 999 일 때 commit 됨 → 프로세스 죽음 → 999 라인 영구 손실
- setInterval flush 와 commit 이 *완전히 분리*되어 있어 at-least-once 가 깨짐

**판정**: ❌ **Missing**. **CRITICAL** for compliance. → ADR-0006.

---

### F-WORK-3. 외부 의존 down 시 무한 재시도

**현재 처리**: notification / market-data-fanout 는 throw → kafkajs 가 재consume → 다시 throw.
backoff 없음, 재시도 한도 없음, DLQ 분기 없음.

**검증**: SNS / Redis 가 5분 down 이면 그동안 같은 메시지를 5분 동안 처리 시도. 다른 메시지 적체.

**판정**: ❌ **Missing**. → ADR-0004.

---

### F-WORK-4. DLQ 토픽 정의됐으나 컨슈머 없음

**현재 처리** — `packages/shared/src/constants.ts:13`:

```ts
DLQ: 'orbit.dlq.v1',
```

이 토픽으로 *발행* 하는 코드 없음. *소비* 하는 consumer group 도 없음.

**검증**: 고아 토픽. 정의만 있고 사용 없음.

**판정**: ❌ **Missing**. → ADR-0004.

---

### F-WORK-5. 중복 알림 / 중복 ticker

**현재 처리**: notification / market-data-fanout 어느 곳도 eventId dedupe 안 함.

**검증**: rebalance 직후 같은 trade event 가 다시 consume → 사용자가 같은 알림 두 번 받음, WS 클라이언트 UI 에 같은 행 두 번.

**판정**: ❌ **Missing**. → ADR-0003.

---

### F-WORK-6. Candle aggregator in-memory 윈도우 손실

**현재 처리** — `apps/workers/src/candle-aggregator/index.ts`: 메모리 `Map<BucketKey, bucket>` + `setInterval(flush, 1s)`.

Upsert 는 `(market, interval, openTime)` unique index 로 멱등.

**검증**:
- 메시지 → 버킷에 누적 → eachMessage return → offset commit → flush 전 크래시
- → 다음 부팅 시 그 trade 는 이미 commit 돼서 재consume 안 됨
- → candle 영구 누락

판정 핵심: offset commit 시점이 flush 전이라 at-least-once 가 깨짐 (F-WORK-2 와 동일 본질).

**판정**: ❌ **Missing**. → ADR-0006 의 동일 패턴 적용.

---

### F-WORK-7. Late-arriving trade

**현재 처리**: 코드상 timestamp 검사 없음. trade 가 어느 시점이든 도착하면 그 (market, M1, openTime) bucket 에 upsert.

**검증**: 같은 openTime 의 candle 이 이미 close 된 후 늦게 trade 가 도착하면 그 candle 이 다시 갱신됨 → 차트가 사후 변경됨.

**판정**: ⚠️ **Partial**. 동작은 하지만 정책이 명시되지 않음. (Severity: LOW — 학습 프로젝트에서는 수용 가능.)

---

## 4. apps/realtime 영역

### F-RT-1. Redis 단절 / 재연결

**현재 처리** — ioredis 기본값 자동 reconnect (exponential backoff up to 10s). 단 reconnect 시 사용자에게 snapshot 재전달 로직 없음.

**판정**: ⚠️ **Partial**. 재연결 자체는 됨. 클라이언트 측 resync 정책이 없음.

---

### F-RT-2. Redis 단절 중 누락된 메시지

**현재 처리**: 누락 자체는 발생. 클라이언트는 주기적 snapshot resync 도 하지 않음.

**판정**: ❌ **Missing**. (Severity: MEDIUM — UI 만 영향, 정합성은 결국 DB 가 source of truth.)

---

### F-RT-3. 다중 노드 중복 emit

**현재 처리**: 클라이언트는 한 노드에만 connect (LB sticky 가정). 코드 기본은 in-memory adapter 라 cross-node broadcast 없음.

**검증**: 현재 단일 노드 운영이라 영향 없음. 향후 다중 노드 시 sticky session 정책 필요.

**판정**: ✅ **OK** (현재). 향후 작업 시 ADR 별도.

---

### F-RT-4 / F-RT-5. 방 수 제한 / backpressure

**현재 처리**: 둘 다 없음.

**판정**: ❌ **Missing**. (Severity: LOW — 봇 트래픽 시 문제, 일반 사용자 환경에서는 영향 거의 없음.)

---

## 5. PostgreSQL

### F-PG-1. Connection pool 고갈

**현재 처리**: Prisma 기본 pool 크기. statement timeout / lock timeout 명시 안 됨.

**판정**: ⚠️ **Partial**. → 향후 운영 작업.

---

### F-PG-3. Lost update under ReadCommitted

**현재 처리** — settler / lockReservation 모두 `ReadCommitted` + `increment` / `decrement` 사용. `SELECT FOR UPDATE` 없음. `@version` 컬럼 없음.

**검증**: Prisma `increment` / `decrement` 는 SQL `UPDATE ... SET balance = balance + N` 으로 컴파일됨 → 행 단위 lock 으로 사실상 atomic.

```sql
UPDATE wallets SET balance = balance + 100, locked = locked - 100
WHERE userId = ? AND asset = ?;
```

이 한 statement 는 row lock 을 건다. 단:
- 하나의 settle 트랜잭션에서 maker wallet 과 taker wallet 둘을 update → 데드락 가능 (account ordering 안 함)
- 잔고가 음수가 되는지의 *의미적* 검증은 응용 코드에서 (CHECK constraint 없음)

**판정**: ⚠️ **Partial**. 단순 increment/decrement 는 OK. 데드락 회피와 잔고 음수 방지는 별도 작업. → 향후 작업.

---

## 6. Kafka

### F-KAFKA-1. 브로커 down

**현재 처리**: producer 측 retry 8회. consumer 측 kafkajs 자동 reconnect.

**판정**: ✅ **OK** (단기 단절). 장기 단절 시 retry 소진 후 데이터 유실 (F-API-1 / F-MATCH-3).

---

### F-KAFKA-3. Schema 호환성

**현재 처리** — `packages/shared/src/types/`: zod schema 가 일부 정의돼 있음 (`OrderCommand`, `TradeEvent` 등). 하지만 producer / consumer 가 강제로 사용하지 않음.

**검증**:
- producer 측: `kafka.send<OrderSubmitCommand>(...)` — TS 제네릭만 강제, 런타임 검증 안 함
- consumer 측: `JSON.parse(message.value.toString())` 후 `as OrderCommand` 캐스팅. 실제 zod parse 없음.

**판정**: ⚠️ **Partial**. 타입 의도는 있으나 런타임 검증 없음. (이번 6개 ADR 미포함, follow-up.)

---

### F-KAFKA-4. Topic retention

**현재 처리**: docker-compose 의 redpanda 기본값 사용. 명시적 retention 설정 없음.

**판정**: ⚠️ **Partial**. → 향후 운영 작업.

---

## 7. Redis

### F-REDIS-1 / F-REDIS-2 / F-REDIS-3

**현재 처리**: snapshot TTL 24h. evict policy 명시 안 됨. backfill 정책 없음.

**판정**: ⚠️ **Partial** (영향 범위가 UI 에 한정).

---

## 8. 외부 SaaS

### F-EXT-1. S3 (LocalStack) 단절

**현재 처리** — `apps/workers/src/audit-logger/index.ts:51–53`:

```ts
} catch (err) {
  log.error({ err, key }, 'audit flush failed');
}
```

batch 는 이미 `batches.delete(topic)` 로 메모리에서 제거됨 (line 38). flush 실패 시 batch 자체가 유실.

**판정**: ❌ **Missing**. F-WORK-2 와 결합돼 더 심각. → ADR-0006.

---

### F-EXT-2. SNS

**현재 처리**: notification worker 가 throw. F-WORK-3 와 동일.

**판정**: ❌ **Missing**.

---

### F-EXT-3. Keycloak

**현재 처리**: 관리자 페이지의 OIDC 토큰 검증이 Keycloak JWKS 의존. Keycloak down 시 모든 admin API 가 401.

**판정**: ⚠️ **Partial**. 사용자 거래에는 영향 없으므로 우선순위 낮음. break-glass 우회는 의식적 trade-off.

---

## 9. 운영 가시성

### F-OBS-1. DLQ 메트릭

**현재 처리**: DLQ 토픽 자체가 unused 라 메트릭도 없음.

**판정**: ❌ **Missing**. → ADR-0004.

### F-OBS-2. Outbox lag

**현재 처리**: Outbox 자체가 없음.

**판정**: ❌ **Missing**. → ADR-0002.

### F-OBS-3. Reconciliation drift

**현재 처리**: 코드 / 잡 / dashboard 모두 없음.

**판정**: ❌ **Missing**. (Severity: HIGH — silent corruption 감지 못 함.)

### F-OBS-4. Health vs readiness

**판정**: F-MATCH-8 와 동일. ❌ **Missing**.

### F-OBS-5. Dedupe hit/miss 메트릭

**현재 처리**: dedupe 자체가 없으니 메트릭도 없음.

**판정**: ❌ **Missing**. → ADR-0003.

---

## 요약 테이블

| ID | Severity | 판정 | ADR |
|---|---|---|---|
| F-API-1 dual-write 실패 | 🔴 CRITICAL | ❌ | 0002 |
| F-API-3 idempotency-key 부재 | 🟠 HIGH | ❌ | 0003 |
| F-API-5 producer fence | 🟡 MEDIUM | ⚠️ | — |
| F-MATCH-1 in-memory 손실 | 🔴 CRITICAL | ⚠️ | 0001 |
| F-MATCH-3 commit 후 publish 실패 | 🔴 CRITICAL | ❌ | 0002 |
| F-MATCH-4 중복 consume | 🟠 HIGH | ⚠️ | 0003 |
| F-MATCH-5 마켓 간 bulkhead | 🟡 MEDIUM | ❌ | follow-up |
| F-MATCH-6 transaction timeout 중 fill | 🔴 CRITICAL | ❌ | 0001 |
| F-MATCH-7 snapshot TTL | 🟢 LOW | ✅ | 0001 (명문화) |
| F-MATCH-8 health vs readiness | 🟠 HIGH | ❌ | 0001 |
| F-WORK-1 워커 동거 | 🟠 HIGH | ⚠️ | 0005 |
| F-WORK-2 audit at-least-once | 🔴 CRITICAL | ❌ | 0006 |
| F-WORK-3 외부 의존 무한 재시도 | 🟠 HIGH | ❌ | 0004 |
| F-WORK-4 DLQ 고아 토픽 | 🟠 HIGH | ❌ | 0004 |
| F-WORK-5 중복 알림 / ticker | 🟡 MEDIUM | ❌ | 0003 |
| F-WORK-6 candle 윈도우 손실 | 🟠 HIGH | ❌ | 0006 |
| F-RT-1/2 Redis 재연결 후 backfill | 🟡 MEDIUM | ⚠️ | follow-up |
| F-PG-3 lost update | 🟡 MEDIUM | ⚠️ | follow-up |
| F-KAFKA-3 schema 호환성 | 🟡 MEDIUM | ⚠️ | follow-up |
| F-EXT-1 S3 flush 실패 | 🟠 HIGH | ❌ | 0006 |
| F-OBS-3 reconciliation drift | 🟠 HIGH | ❌ | follow-up |

이 표는 다음 문서 [`03-gap-analysis.md`](03-gap-analysis.md) 의 prioritization matrix 입력이 된다.
