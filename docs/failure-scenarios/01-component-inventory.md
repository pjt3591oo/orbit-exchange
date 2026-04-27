# 컴포넌트별 잠재 장애 목록

본 문서는 ORBIT Exchange 의 각 컴포넌트가 *이론적으로* 가질 수 있는 장애를 망라한다. 코드의 실제 처리 여부는 다루지 않는다 — 그건 [`02-current-state-audit.md`](02-current-state-audit.md) 의 몫이다.

각 항목은 다음 형식이다.

> **F-XYZ-N** — 한 줄 요약
> - **Trigger**: 어떤 조건에서 발생하는가
> - **Blast radius**: 영향 범위
> - **Recovery requirement**: 회복하려면 무엇이 필요한가

코드 파일 인용은 의도적으로 최소화했다. 본 문서는 *이론* 카탈로그이고, 실측 결과는 다음 문서에서 매핑한다.

---

## 1. apps/api (HTTP 게이트웨이)

> 책임: 인증 / DTO 검증 / DB 트랜잭션 / Kafka command publish.
> 핵심 경로: `POST /api/v1/orders` (submit), `DELETE /api/v1/orders/:id` (cancel).

### F-API-1. DB insert 성공 / Kafka publish 실패

- **Trigger**: 트랜잭션 커밋 후 `kafkaProducer.send()` 호출 직전·중에 브로커 단절, 컨테이너 OOM, ECS task 종료 등.
- **Blast radius**: Order 가 DB 에 OPEN 상태로 존재하지만 matcher 가 영원히 모름 → 사용자 자금 영구 lock.
- **Recovery requirement**: 외부 메커니즘(outbox / CDC) 으로 publish 누락을 감지하고 재발행하거나, 운영자가 수동 보정.

### F-API-2. DB rollback / Kafka publish 성공

- **Trigger**: 매우 드물지만, publish 가 트랜잭션 커밋 *전* 에 일어나면 발생 (현재는 아님).
- **Blast radius**: Phantom command — matcher 가 존재하지 않는 Order 를 처리하려다 실패.
- **Recovery requirement**: 코드 구조상 publish 는 commit *후* 여야 함을 보장.

### F-API-3. 같은 요청의 중복 처리 (네트워크 retry)

- **Trigger**: 클라이언트가 timeout 후 재요청. 서버 입장에서는 두 번의 합법적 POST.
- **Blast radius**: 같은 의도의 주문이 두 건 생성, 양쪽 모두 잔고 lock.
- **Recovery requirement**: `Idempotency-Key` 헤더 + 서버 측 dedupe 저장소.

### F-API-4. 트랜잭션 timeout 중 Kafka publish 시작

- **Trigger**: DB lock 경합으로 트랜잭션이 timeout (현재 10s) 직전에 commit 됨. 이후 publish 도 실패.
- **Blast radius**: F-API-1 과 동일.
- **Recovery requirement**: 동일.

### F-API-5. Producer 가 idempotent 모드에서 producerId fence 됨

- **Trigger**: Kafka 의 transactional producer 가 다른 인스턴스에 의해 fence 됐을 때.
- **Blast radius**: send 실패 → catch 분기.
- **Recovery requirement**: producer 재초기화 + 재시도 로직.

### F-API-6. Cancel 명령 발행 중 매처가 이미 fill 처리

- **Trigger**: 사용자가 cancel 누른 시점에 matcher 가 부분/전체 체결을 동시 처리.
- **Blast radius**: Cancel command 가 후행 도착 → matcher 는 멱등 분기 (이미 FILLED 면 no-op) 로 처리해야 함.
- **Recovery requirement**: matcher 의 멱등 분기 로직 (status 가 terminal 이면 무시).

---

## 2. apps/matcher (매칭엔진)

> 책임: command consume → in-memory orderbook 갱신 → DB 정산 트랜잭션 → 후속 event publish.
> 핵심: 마켓별 in-memory `Orderbook` (단일 owner). 단일 프로세스, 단일 이벤트 루프.

### F-MATCH-1. 프로세스 크래시 → 인메모리 orderbook 손실

- **Trigger**: OOM, unhandled exception, kill -9, 컨테이너 재기동.
- **Blast radius**: 모든 마켓의 호가창이 사라짐. 부팅 후 책 재구성 필요.
- **Recovery requirement**:
  1. DB 의 OPEN/PARTIAL 주문 replay
  2. 또는 주기적 snapshot + delta replay
  3. 또는 standby + leader election

### F-MATCH-2. Replay 중 신규 command 도착

- **Trigger**: matcher 가 부팅 직후 `replayOpenOrders()` 실행 중인데, Kafka consumer 도 동시에 신규 command 처리 시작.
- **Blast radius**: replay 가 끝나기 전에 추가된 주문이 책에서 누락되거나, 같은 주문이 두 번 add 됨.
- **Recovery requirement**: replay 완료 *까지는* consumer 가 시작되지 않도록 ordering 강제.

### F-MATCH-3. Kafka offset commit 후 후속 publish 실패

- **Trigger**: command 처리 → DB 정산 commit → 그 후의 trade event publish 실패.
- **Blast radius**: 매칭 결과가 DB 에는 있지만 downstream consumer (candle, fanout, notification, audit) 가 못 봄. WS 클라이언트도 trade 못 받음.
- **Recovery requirement**: outbox-style 발행 또는 commit 경계를 publish 후로 옮김.

### F-MATCH-4. 같은 command 중복 consume (rebalance, replay)

- **Trigger**: consumer rebalance, broker 재기동, partition reassignment.
- **Blast radius**: 같은 SUBMIT 이 두 번 처리되면 같은 Order 가 두 번 add 시도. 같은 CANCEL 이 두 번 처리되면 두 번째는 멱등 분기로 흡수.
- **Recovery requirement**: 처리 결과의 status terminal-check (현재 부분 구현) 또는 commandId dedupe 저장소.

### F-MATCH-5. 한 마켓의 hot path 가 다른 마켓을 차단

- **Trigger**: 한 심볼이 초당 수천 건의 SUBMIT/CANCEL 을 받으면 전체 이벤트 루프가 그 처리에 묶임.
- **Blast radius**: 다른 마켓 latency 폭증.
- **Recovery requirement**: 마켓 단위 워커 분리, 또는 코어별 worker thread, 또는 매처 인스턴스 샤딩.

### F-MATCH-6. DB transaction timeout 중 fill

- **Trigger**: 정산 트랜잭션이 lock 경합으로 10s timeout. 이미 in-memory 책은 fill 된 상태.
- **Blast radius**: in-memory book 과 DB 가 불일치. 사용자에게 "체결됨" 으로 보였다가 사라질 수 있음.
- **Recovery requirement**: 트랜잭션 실패 시 in-memory rollback (engine 차원의 undo) 또는 reconciliation.

### F-MATCH-7. Snapshot TTL 만료 + 매처 부팅

- **Trigger**: matcher 가 24시간 이상 down. Redis snapshot 만료. 부팅 시 Redis 에서 책을 복원하려 했는데 비어있음.
- **Blast radius**: 부팅 후 책이 텅 빈 상태로 시작 (단, 현재는 DB replay 가 fallback).
- **Recovery requirement**: snapshot 의 역할을 명시 (latency 최적화 vs 무결성). 무결성은 DB replay 가 담당.

### F-MATCH-8. Health 가 readiness 와 동일하게 처리됨

- **Trigger**: 부팅 직후, replay 중인데 k8s/loadbalancer 가 healthy 로 판단해 트래픽 라우팅.
- **Blast radius**: 책이 텅 빈 매처로 명령이 들어감.
- **Recovery requirement**: liveness ↔ readiness 분리 + readiness 는 replay 완료 후 true.

---

## 3. apps/workers (4종 컨슈머)

> 책임 (4개): market-data-fanout (Kafka → Redis pub/sub), candle-aggregator (trades → OHLCV), notification (→ SNS), audit-logger (→ S3 JSONL).
> 현재: **단일 Node 프로세스, 단일 이벤트 루프, 4개 consumer group**.

### F-WORK-1. 한 워커의 unhandled exception 이 전체 프로세스 종료

- **Trigger**: 외부 의존(Redis/SNS/S3) 단절 → publish throw → kafkajs eachMessage 가 reject → 처리 안 된 Promise rejection.
- **Blast radius**: 4개 워커 모두 죽음.
- **Recovery requirement**: 프로세스 분리 또는 워커별 supervisor.

### F-WORK-2. Audit logger — offset commit 과 S3 flush 의 분리

- **Trigger**: 999 건 메모리에 쌓이고 Kafka offset commit 됨 → 프로세스 죽음 → 999 건 S3 도달 못 함.
- **Blast radius**: 감사 로그 최대 999 건 (또는 FLUSH_MS 윈도우 내 모든 건) 영구 유실.
- **Recovery requirement**: `eachBatch` + manual commit, 또는 flush 성공 후에만 commit.

### F-WORK-3. 외부 의존 down 시 무한 재시도 루프

- **Trigger**: SNS 가 5분간 down. notification worker 가 SNS publish 실패 → throw → kafkajs 가 같은 메시지 재consume → 다시 throw …
- **Blast radius**: 그 토픽의 consumer lag 폭증, 다른 정상 메시지도 처리 안 됨.
- **Recovery requirement**: backoff + retry 한도 + DLQ 분기.

### F-WORK-4. DLQ 토픽이 정의됐지만 컨슈머 없음

- **Trigger**: F-WORK-3 처럼 DLQ 로 보낼 만한 메시지가 발생하더라도, 현재 코드는 DLQ 로 발행하지 않음. 발행한다 해도 받는 쪽이 없음.
- **Blast radius**: 영구 처리 불가 메시지가 쌓일 곳이 없음.
- **Recovery requirement**: DLQ producer 로직 + DLQ consumer (운영자 replay UI 또는 자동 retry).

### F-WORK-5. 중복 알림 / 중복 ticker

- **Trigger**: rebalance 직후 같은 trade event 가 다시 consume.
- **Blast radius**:
  - notification: 사용자에게 같은 알림 두 번
  - market-data-fanout: 클라이언트에 같은 trade tick 두 번 (UI 상 중복 행)
- **Recovery requirement**: consumer 단 idempotency (eventId 기반 dedup).

### F-WORK-6. Candle aggregator 의 in-memory 윈도우 손실

- **Trigger**: trade 가 메모리 bucket 에 쌓이고, `setInterval(flush, 1s)` 이 실행되기 전에 프로세스 종료.
- **Blast radius**: 마지막 1초 분량의 candle update 가 DB 에 안 들어감.
- **Recovery requirement**: Kafka 에서 같은 trade 를 다시 consume (offset 미commit 였다면) — 즉 commit 시점이 중요.

### F-WORK-7. Late-arriving trade

- **Trigger**: trade event 가 매우 늦게(> 분 단위) 도착. 해당 1m candle 윈도우가 이미 닫혀있음.
- **Blast radius**: 캔들 미반영 또는 잘못된 reopen.
- **Recovery requirement**: watermark 정책 + 늦은 이벤트 처리 룰 명시.

---

## 4. apps/realtime (WebSocket 게이트웨이)

> 책임: 클라이언트 WS 연결 수락 → Redis psubscribe → 방별 emit.

### F-RT-1. Redis pub/sub 단절

- **Trigger**: Redis 재기동 / 네트워크 단절.
- **Blast radius**: WS 클라이언트는 연결돼 있지만 데이터가 안 옴 (silent failure).
- **Recovery requirement**: ioredis 자동 reconnect (현재 있음) + reconnect 시 사용자에게 snapshot 재전달.

### F-RT-2. Redis 단절 중 누락된 메시지

- **Trigger**: Redis 가 1분간 끊겼다가 복구. 그 사이 발행된 trade tick 은 모두 유실 (Redis pub/sub 은 store-and-forward 가 아님).
- **Blast radius**: 클라이언트의 호가창/체결 화면이 일시적으로 거짓 상태.
- **Recovery requirement**: 재연결 시 Kafka 에서 backfill 또는 snapshot resync.

### F-RT-3. 다중 노드에서의 동일 메시지 중복 emit

- **Trigger**: 게이트웨이 노드가 N개일 때, 모든 노드가 같은 Redis 채널을 psubscribe → 같은 클라이언트가 한 노드에 붙어있어도 정상 (자기 노드만 emit). 단 sticky 가 깨지면 양쪽이 emit.
- **Blast radius**: UI 중복.
- **Recovery requirement**: WS 클라이언트는 한 노드에만 붙어야 함을 LB 차원에서 보장.

### F-RT-4. 한 클라이언트가 너무 많은 방을 구독

- **Trigger**: 봇이 1000개 방 구독.
- **Blast radius**: 해당 노드 메모리 / fanout 비용 증가.
- **Recovery requirement**: per-conn 방 수 제한.

### F-RT-5. Backpressure 부재

- **Trigger**: Redis 가 매우 빠르게 메시지를 발행, 게이트웨이 노드의 emit 큐가 적체.
- **Blast radius**: 노드 OOM 또는 GC 폭주.
- **Recovery requirement**: per-conn drop policy (오래된 tick 은 버리기) + queue 길이 메트릭.

---

## 5. PostgreSQL

### F-PG-1. Connection pool 고갈

- **Trigger**: 한 트랜잭션이 lock 잡고 안 끝남. pool 의 모든 연결이 wait.
- **Blast radius**: 모든 신규 요청이 timeout. API/matcher 둘 다 영향.
- **Recovery requirement**: statement timeout, lock timeout, pool 모니터링.

### F-PG-2. Replica lag

- **Trigger**: 현재는 단일 인스턴스라 해당 없음. 향후 read replica 도입 시.
- **Blast radius**: read-after-write inconsistency.
- **Recovery requirement**: 쓰기 직후 read 는 primary 로 라우팅.

### F-PG-3. Lost update under ReadCommitted

- **Trigger**: 두 트랜잭션이 동시에 같은 wallet 을 increment/decrement. ReadCommitted 는 phantom 차단 못 함.
- **Blast radius**: 잔고 계산 오차.
- **Recovery requirement**: `SELECT FOR UPDATE` 또는 `@@version` 컬럼.

### F-PG-4. Long migration during deploy

- **Trigger**: prisma migration 중 ALTER TABLE 이 long lock.
- **Blast radius**: 배포 중 잔여 트래픽 차단.
- **Recovery requirement**: zero-downtime migration 패턴 (expand-contract).

---

## 6. Kafka

### F-KAFKA-1. 브로커 down

- **Trigger**: docker compose down 또는 운영 시 broker crash.
- **Blast radius**: 모든 producer 가 send 실패. consumer 는 lag 정지.
- **Recovery requirement**: 클라이언트 자동 retry (kafkajs 기본) + producer 측 outbox 로 buffering.

### F-KAFKA-2. Partition rebalance 중 상태 일시 중단

- **Trigger**: consumer 추가/이탈, broker 재기동.
- **Blast radius**: 수 초간 처리 정지.
- **Recovery requirement**: at-least-once + idempotent consumer.

### F-KAFKA-3. 메시지 schema 호환성 깨짐

- **Trigger**: producer 가 필드 추가/제거된 메시지 발행. consumer 가 deserialize 실패.
- **Blast radius**: 해당 토픽 전체 처리 중단.
- **Recovery requirement**: schema 패키지화 (zod/protobuf) + 변경 시 migration 룰.

### F-KAFKA-4. Topic retention 만료

- **Trigger**: replay 가 필요할 때 메시지가 이미 retention 초과.
- **Blast radius**: matcher event-replay 기반 복구 불가능.
- **Recovery requirement**: critical 토픽은 retention 길게 + DB 가 source of truth.

---

## 7. Redis

### F-REDIS-1. Snapshot key 만료 후 cold-start

- **Trigger**: 24시간 이상 트래픽 없는 마켓의 `ob:snapshot:*` 키 만료.
- **Blast radius**: 신규 WS 연결의 초기 호가창 표시 실패.
- **Recovery requirement**: matcher 부팅 시 snapshot 재발행 + WS 노드는 fallback 으로 빈 책 표시.

### F-REDIS-2. pub/sub 메시지 손실

- **Trigger**: F-RT-2 와 동일 본질. Redis 자체가 store-and-forward 가 아님.
- **Blast radius**: 짧은 시간 fanout 누락.
- **Recovery requirement**: WS 클라이언트의 주기적 snapshot resync.

### F-REDIS-3. Redis 메모리 한도 초과

- **Trigger**: 너무 많은 snapshot 키 + 너무 긴 TTL.
- **Blast radius**: maxmemory-policy 에 따라 키 evict 또는 OOM.
- **Recovery requirement**: TTL 정책 + 메트릭.

---

## 8. 외부 SaaS (S3, SNS, SMTP, Keycloak)

### F-EXT-1. S3 (LocalStack) 단절 → audit flush 실패

- **Trigger**: LocalStack 컨테이너 down.
- **Blast radius**: audit 배치가 메모리에서 안 빠짐 → 메모리 누수.
- **Recovery requirement**: flush 실패 시 재시도 + 한도 + DLQ.

### F-EXT-2. SNS rate limit / down

- **Trigger**: notification worker 가 SNS publish 시 throttle.
- **Blast radius**: F-WORK-3 와 동일.
- **Recovery requirement**: backoff + DLQ.

### F-EXT-3. Keycloak down (관리자 로그인 불가)

- **Trigger**: Keycloak 컨테이너 / DB 단절.
- **Blast radius**: 관리자가 운영 도구를 못 씀. 사용자 거래는 영향 없음.
- **Recovery requirement**: Keycloak HA + 운영자용 break-glass 우회 (보안 trade-off).

---

## 9. 운영 가시성 (Observability)

### F-OBS-1. DLQ 메트릭 부재

- **Trigger**: DLQ 토픽이 비어있는지 적체됐는지 알 길 없음.
- **Blast radius**: 사일런트 데이터 손실.
- **Recovery requirement**: `kafka_consumergroup_lag{group="orbit.dlq"}` alert.

### F-OBS-2. Outbox lag 메트릭 부재

- **Trigger**: outbox 도입 후, relay 가 밀리고 있는지 모름.
- **Blast radius**: 매칭은 되지만 사용자 화면이 stale.
- **Recovery requirement**: `outbox_pending_count` + `outbox_oldest_age_seconds` 메트릭 + alert.

### F-OBS-3. Reconciliation drift 미감지

- **Trigger**: in-memory book 과 DB OPEN orders 가 어느 순간 불일치인데 모름.
- **Blast radius**: 매칭 결과가 천천히 어긋남.
- **Recovery requirement**: 주기적 reconcile 잡 + drift alert.

### F-OBS-4. Health vs readiness 미분리

- **Trigger**: F-MATCH-8 과 동일.
- **Blast radius**: cold start 직후 트래픽 받음.
- **Recovery requirement**: liveness / readiness 분리.

### F-OBS-5. 중복 처리 알림 부재

- **Trigger**: F-WORK-5 의 중복 처리가 있어도 운영자가 모름.
- **Blast radius**: 자금 무결성 silent corruption.
- **Recovery requirement**: dedupe hit/miss 메트릭.

---

## 10. 도메인별 인덱스

문서를 빨리 훑기 위한 cross-reference. 각 항목의 *현재 처리 여부* 는 [`02-current-state-audit.md`](02-current-state-audit.md) 참조.

| 도메인 | 항목 |
|---|---|
| A. State Recovery | F-MATCH-1, F-MATCH-2, F-MATCH-7, F-WORK-6, F-REDIS-1, F-KAFKA-4 |
| B. Message Delivery | F-API-1, F-API-2, F-API-4, F-MATCH-3, F-MATCH-4, F-WORK-2, F-WORK-3 |
| C. Concurrency & Integrity | F-API-3, F-API-6, F-MATCH-4, F-MATCH-6, F-WORK-5, F-PG-3 |
| D. Isolation / Bulkhead | F-MATCH-5, F-WORK-1 |
| E. External Dependencies | F-RT-1, F-RT-2, F-PG-1, F-KAFKA-1, F-KAFKA-2, F-EXT-1, F-EXT-2, F-EXT-3 |
| F. Observability of Failures | F-WORK-4, F-MATCH-8, F-OBS-* |
