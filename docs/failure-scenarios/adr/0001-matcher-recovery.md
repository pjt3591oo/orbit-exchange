# ADR-0001 — Matcher 상태 복구 전략

- **Status**: Proposed
- **Date**: 2026-04-27
- **Deciders**: 본 프로젝트 owner
- **Related**: F-MATCH-1, F-MATCH-2, F-MATCH-6, F-MATCH-7, F-MATCH-8

## Context

매처는 in-memory `Orderbook` 인스턴스를 유일한 소유자로 갖는다. 프로세스가 죽으면 그 상태는 사라진다. 현재 코드는 `replayOpenOrders()` 로 DB 의 OPEN/PARTIAL LIMIT 주문을 부팅 시 복원한다. 이는 *대체로* 작동하지만 다음 corner case 가 비어있다.

1. **F-MATCH-1**: replay 자체는 있으나 in-flight MARKET 주문, 그리고 정산이 진행 중이던 trade 의 처리가 불명확.
2. **F-MATCH-2**: replay 가 끝나기 전에 consumer 가 실수로 일찍 시작될 가능성. 현재는 NestJS lifecycle 에 의존하는 *컨벤션* 일 뿐, 명시적 readiness flag 가 없음.
3. **F-MATCH-6**: 정산 트랜잭션 timeout 시 in-memory engine 상태와 DB 가 불일치. 현재 in-memory rollback 로직 없음.
4. **F-MATCH-7**: Redis snapshot 의 *역할* 이 명문화 안 됨. 책 복원용인지 read-side cache 인지 모호.
5. **F-MATCH-8**: `/health` 가 정적 응답이라 cold start 직후 readiness 와 구분 안 됨.

이번 ADR 은 이 다섯을 묶어 **"matcher 의 라이프사이클" 에 대한 단일 의사결정** 으로 정리한다.

## Decision

### D1. Snapshot 의 역할은 read-side cache 로 한정

Redis 의 `ob:snapshot:*` 는 **WS 클라이언트의 초기 호가창 표시 전용 cache** 로 명문화한다.
- TTL 24h 그대로 유지.
- **책 복원의 source of truth 는 항상 DB** (OPEN/PARTIAL Order rows).
- snapshot key 가 만료/누락된 경우 매처가 책을 *재계산해서* Redis 에 다시 write. 책 자체는 영향 없음.

이 결정으로 F-MATCH-7 은 closed.

### D2. Replay 절차의 명시적 readiness flag

`MatchingEngineService` 에 `ready: boolean` 상태를 추가한다. 부팅 절차:

```
1. onModuleInit:
   - DB 에서 OPEN/PARTIAL LIMIT 주문 SELECT
   - 마켓별 Orderbook 인스턴스 생성 + engine.add 로 모든 주문 add
   - this.ready = true 설정
2. CommandConsumer.onApplicationBootstrap:
   - this.matching.ready 확인 후에만 consumer.run() 호출
   - 만약 false 면 1초 polling 으로 대기
```

이로써 F-MATCH-2 의 *암묵적 ordering 의존* 을 *명시적 flag* 로 바꿈.

### D3. Readiness 엔드포인트 분리

`packages/observability/src/nest.ts` 의 `startOpsServer` 에 `/ready` 추가:

```ts
app.get('/health', staticOk);              // liveness — 프로세스가 살아있는가
app.get('/ready', dynamicReadinessCheck);  // readiness — 트래픽 받을 준비 됐는가
```

`/ready` 는 다음 모두 true 일 때만 200:

| 서비스 | `/ready` 조건 |
|---|---|
| **api** | DB ping OK + Kafka producer ready |
| **matcher** | `MatchingEngineService.ready === true` + Kafka consumer subscribed + DB ping OK |
| **realtime** | Redis ping OK + Socket.IO accepting |
| **workers** | 활성화된 모든 컨슈머가 group join 완료 |

k8s/loadbalancer 가 트래픽 라우팅 결정 시 `/ready` 사용. `/health` 는 liveness probe (재기동 트리거) 용도.

### D4. Transaction timeout 중 fill — engine-level rollback

`SettlerService` 의 핵심 패턴 변경:

**현재 (취약)**:
```ts
const matchResult = engine.match(order);  // in-memory 책 변경됨
await prisma.$transaction(async (tx) => {  // DB 작업
  // trade 생성, wallet update, order status update
});
// 만약 transaction 이 throw 하면 in-memory 는 이미 변경, DB 는 rollback
```

**제안 (rollback 가능)**:
```ts
// 1. dry-run match — in-memory 책 변경 안 함
const matchResult = engine.peek(order);  // 같은 결과 시뮬레이션, 책 미변경

// 2. DB 작업
await prisma.$transaction(async (tx) => {
  // trade 생성, wallet update, order status update
});

// 3. DB 성공 시에만 in-memory commit
engine.commit(matchResult);
```

`orderbook-match-engine` v2 가 `peek()` API 를 제공하지 않으면 v3 에서 추가. 또는 wrapper 로 다음을 구현:

```ts
const snapshot = engine.snapshot(symbol);  // O(n)
try {
  const result = engine.match(order);
  await prisma.$transaction(...);
} catch (err) {
  engine.restore(symbol, snapshot);  // rollback
  throw err;
}
```

snapshot/restore 의 비용은 마켓 사이즈에 비례. 단순 lock 경합으로 인한 transaction timeout 은 흔치 않으므로 비용 수용 가능. 자주 발생하면 그 자체가 다른 문제 (DB 튜닝 필요).

이로써 F-MATCH-6 closed.

### D5. In-flight MARKET 주문의 처리

MARKET 주문은 LIMIT 과 달리 책에 남지 않으므로 `replayOpenOrders` 가 무용지물. 다음 보장:

- API 가 MARKET 주문 INSERT 시 status=`PENDING` (신규 enum 값) 으로 시작.
- matcher 가 fill 시작 시 status=`MATCHING`, fill 완료 시 `FILLED`.
- 부팅 시 status=`PENDING` 또는 `MATCHING` 인 MARKET 주문 발견하면 → outbox 에 의한 publish 누락 의심 → 운영자 수동 처리 (alert 발생).

자동 자가 회복은 위험하므로 의식적으로 manual 로 둔다. 운영 진입 후에는 별도 ADR 로 자동화.

## Consequences

### Positive

- 매처 라이프사이클이 명시적 — readiness flag, /ready endpoint, snapshot 역할 모두 코드와 문서로 일치.
- F-MATCH-1, 2, 6, 7, 8 closed.
- `/ready` 추가로 다른 서비스 (api / realtime / workers) 도 동일 패턴 적용 가능.

### Negative

- snapshot/restore 비용. 마켓 한 개에 10만 주문이면 약 10MB 메모리 복사. 발생 빈도가 낮아야 수용 가능.
- `peek` API 가 `orderbook-match-engine` v2 에 없으면 wrapper 가 필요. 라이브러리 owner 가 본인이라 추가 가능하지만, snapshot/restore 패턴이 임시 해결.
- MARKET 주문의 PENDING 상태 추가는 schema migration.

### Neutral

- Redis snapshot 역할 명문화는 이미 *사실상* 그렇게 동작하던 것을 문서화하는 것에 가까움.

## Implementation notes

영향 파일:
- `apps/matcher/src/matching/matching-engine.service.ts` — `ready` flag, `peek/commit` 또는 `snapshot/restore`
- `apps/matcher/src/consumer/command-consumer.service.ts` — readiness 대기
- `packages/observability/src/nest.ts` — `/ready` endpoint 추가, 동적 체커 등록 API
- `apps/api/prisma/schema.prisma` — `OrderStatus` 에 `PENDING` 추가
- `infra/grafana/dashboards/orbit-service-overview.json` — readiness 패널 추가

테스트 케이스:
1. matcher 부팅 후 ready=false 인 동안 consumer 는 message 안 받음
2. snapshot/restore 후 같은 주문을 다시 match 했을 때 결과 동일
3. transaction timeout 시 in-memory 책이 시작 상태로 복원됨
4. `/ready` 가 cold start 직후 503, replay 완료 후 200

## Alternatives considered

### Alt A. Event sourcing 기반 replay

매처가 Kafka `orbit.events.*` 의 처음부터 replay. DB 의존 없음.

**Rejected**: Kafka retention 의존 (현재 default 7일). 복구 시간이 토픽 크기에 비례하여 길어짐. 학습 프로젝트 단계에서 ROI 낮음.

### Alt B. Leader-follower 매처 + Raft

standby 인스턴스가 항상 같은 책 상태 유지. failover 시 즉시 takeover.

**Rejected**: 구현 복잡도 너무 큼. 단일 프로세스 매처의 SPOF 는 의식적 trade-off 로 현 단계에서는 수용. 운영 진입 시 별도 ADR.

### Alt C. Snapshot 이 책 복원의 source of truth

Redis snapshot 을 책 복원에 직접 사용. DB replay 안 함.

**Rejected**: snapshot 은 *경합 가능한 지점* 이라 source of truth 자격 없음. DB 가 transactional 이라 source 로 적합. snapshot 은 cache 로 한정.

## Follow-ups

- 매처 leader-follower 또는 샤딩 (F-MATCH-5) — 별도 ADR.
- MARKET 주문 PENDING 의 자동 회복 — 운영 진입 후.
- Reconciliation drift 잡 (F-OBS-3) — 별도 ADR.
