# Gap Analysis — 우선순위와 로드맵

본 문서는 [`02-current-state-audit.md`](02-current-state-audit.md) 의 판정 결과를 **severity × likelihood 매트릭스** 로 재배치하고, 무엇을 어떤 순서로 메울지 결정한다.

분석은 여기서 끝난다. 이후 모든 "어떻게 해결할 것인가" 는 `adr/` 의 6개 문서가 답한다.

---

## 1. Likelihood (발생 가능성) 산정 기준

학습 프로젝트 컨텍스트를 반영한다.

| 등급 | 의미 | 예시 |
|---|---|---|
| **High** | 정상 운영 중에도 자주 발생 | rebalance, 사용자 네트워크 retry |
| **Medium** | 분기/월 단위로 발생 | 컨테이너 재기동, deploy 중 단절 |
| **Low** | 연 단위 또는 인프라 사고급 | broker 장기 down, DB 데이터 손실 |

본 프로젝트는 docker compose 기반이라 *컨테이너 재기동* 이 매우 흔하다. 학습/개발 환경에서는 사실상 daily event. 따라서 컨테이너 재기동에 직접 영향받는 항목은 모두 High 로 분류한다.

---

## 2. Severity × Likelihood 매트릭스

| | High Likelihood | Medium Likelihood | Low Likelihood |
|---|---|---|---|
| **🔴 CRITICAL** | F-MATCH-3 (commit 후 publish 실패), F-WORK-2 (audit 손실) | F-API-1 (dual-write), F-MATCH-1 (in-memory 손실), F-MATCH-6 (timeout 중 fill) | — |
| **🟠 HIGH** | F-API-3 (idempotency 부재), F-WORK-1 (워커 동거), F-WORK-4 (DLQ 고아), F-MATCH-8 (readiness) | F-WORK-3 (재시도 루프), F-WORK-6 (candle 손실), F-EXT-1 (S3 flush), F-OBS-3 (drift) | F-MATCH-4 (중복 consume) |
| **🟡 MEDIUM** | F-WORK-5 (중복 알림) | F-RT-2 (Redis 누락), F-MATCH-5 (마켓 간 격리), F-PG-3 (lost update), F-KAFKA-3 (schema) | F-API-5 (producer fence) |
| **🟢 LOW** | — | F-WORK-7 (late trade), F-RT-4/5 (방 수/backpressure) | F-MATCH-7 (snapshot TTL) |

**왼쪽 위 4개** 가 가장 시급하다. 그 다음은 좌측 열 (CRITICAL/HIGH × Medium) 의 4개. 나머지는 follow-up.

---

## 3. ADR 매핑 — 무엇이 어떤 의사결정으로 묶이는가

6개의 ADR 이 위 매트릭스의 어느 항목들을 해결하는지 보여준다.

| ADR | 대상 항목 | 해결 도메인 |
|---|---|---|
| **0001 — Matcher 복구 전략** | F-MATCH-1, F-MATCH-2, F-MATCH-6, F-MATCH-7, F-MATCH-8 | A |
| **0002 — Outbox 패턴** | F-API-1, F-MATCH-3, F-OBS-2 | B |
| **0003 — Idempotency 정책** | F-API-3, F-MATCH-4, F-WORK-5, F-OBS-5 | B, C |
| **0004 — DLQ 토폴로지** | F-WORK-3, F-WORK-4, F-OBS-1 | B, F |
| **0005 — Worker bulkhead** | F-WORK-1 | D |
| **0006 — Audit at-least-once** | F-WORK-2, F-WORK-6, F-EXT-1 | B, F |

ADR 6개로 매트릭스 좌측 열 + High Likelihood 의 거의 전부를 커버한다.

**커버되지 않는 항목** — follow-up 으로 별도 트래킹:
- F-MATCH-5 마켓 간 bulkhead (매처 샤딩 — 큰 작업)
- F-PG-3 lost update / 데드락
- F-RT-2 Redis 단절 후 backfill
- F-KAFKA-3 schema 호환성 강제
- F-OBS-3 reconciliation drift 잡

이들은 본 시리즈의 6개 ADR 가 끝난 *후* 별도 시리즈로 다룬다. 의식적 미루기.

---

## 4. ADR 간 의존 관계

ADR 끼리도 적용 순서가 있다. 잘못된 순서로 작업하면 두 번 일하게 된다.

```
                  ┌────────────────────┐
                  │ 0003 idempotency   │
                  │  (정책 선언)        │
                  └────────┬───────────┘
                           │ 모든 producer/consumer 가 의존
            ┌──────────────┼──────────────┐
            ▼              ▼              ▼
   ┌────────────┐  ┌─────────────┐  ┌──────────────┐
   │ 0002 outbox│  │ 0006 audit   │  │ 0004 DLQ     │
   │            │  │   at-least-  │  │              │
   │            │  │   once       │  │              │
   └─────┬──────┘  └──────┬───────┘  └──────┬───────┘
         │                │                  │
         └────────────────┼──────────────────┘
                          ▼
                ┌─────────────────────┐
                │ 0005 worker         │
                │   bulkhead          │
                │ (적용 순서 무관)    │
                └─────────────────────┘

         ┌─────────────────────┐
         │ 0001 matcher        │  (독립 — 다른 ADR 와 병렬 가능)
         │   recovery          │
         └─────────────────────┘
```

### 권장 작업 순서

1. **ADR-0003 (idempotency 정책)** — 다른 모든 ADR 의 전제. eventId / commandId 의 형태와 저장소를 먼저 결정.
2. **ADR-0002 (outbox)** — F-MATCH-3 의 CRITICAL 결함. 가장 임팩트 큰 단일 변경.
3. **ADR-0006 (audit at-least-once)** — eachBatch + manual commit 패턴. Outbox 를 한 번 짜고 나면 비슷한 형태라 가성비 좋음.
4. **ADR-0001 (matcher recovery)** — readiness probe + transaction-timeout corner case 핸들링. ADR-0002 가 끝나야 in-flight publish 의미가 명확해짐.
5. **ADR-0004 (DLQ)** — backoff + retry 한도 + DLQ producer/consumer. 위 4개가 안정된 뒤 적용해야 의미 있음.
6. **ADR-0005 (worker bulkhead)** — 운영 변경. 코드 영향 적음. 마지막에.

**병렬화 가능**: ADR-0001 은 다른 작업과 큰 충돌 없이 별도 PR 로 진행 가능.

---

## 5. ADR 별 예상 작업량

학습 프로젝트의 일반적 측정 단위로 가늠한다.

| ADR | 영향받는 파일 수 | 예상 LOC | 신규 인프라 |
|---|---|---|---|
| 0001 matcher recovery | ~5 | ~250 | 없음 |
| 0002 outbox | ~12 | ~600 | `OutboxEvent` 테이블 + relay 워커 |
| 0003 idempotency | ~15 | ~400 | `IdempotencyKey` 테이블 + Redis SET 정책 |
| 0004 DLQ | ~8 | ~350 | `orbit.dlq.v1` consumer + admin replay UI |
| 0005 worker bulkhead | ~3 (config 위주) | ~50 | docker-compose 수정 |
| 0006 audit at-least-once | ~3 | ~200 | 없음 |

총합 ≈ 1850 LOC + 2개 신규 테이블 + 1개 신규 워커 + 1개 admin UI 페이지.

학습 프로젝트로서 적절한 양. 한 번에 다 하지 않고 순차 PR 로 6개 분할 권장.

---

## 6. 무엇이 *해결되지 않는* 것을 분명히 하기

ADR 6개가 모두 적용된 후에도 ORBIT Exchange 는 다음을 *보장하지 않는다*.

1. **단일 매처 인스턴스의 SPOF** — leader-follower 가 아니므로 그 매처가 죽으면 그 마켓은 정지. 회복은 빠르지만 (replay 후 재기동) zero-downtime 은 아님. → 별도 시리즈.
2. **마켓 간 hot-path bulkhead** — 한 마켓이 CPU 100% 쓰면 다른 마켓도 영향. → ADR-FOLLOWUP-X.
3. **다중 realtime 노드의 sticky session** — 단일 노드 가정 유지. → 트래픽 늘면 별도.
4. **Postgres HA / replica lag** — 단일 인스턴스. → 인프라 영역.
5. **Schema registry / 버전 호환성 강제** — 런타임 zod parse 미적용. → ADR-FOLLOWUP-Y.
6. **Reconciliation 잡** — in-memory book ↔ DB 정기 비교. → ADR-FOLLOWUP-Z.

이들은 **운영 진입 시점에 추가로 다룰 작업** 이며, 본 시리즈의 *학습용 design correctness* 목표 밖이다.

---

## 7. 성공 기준 — 이번 시리즈가 끝나면 무엇을 답할 수 있어야 하는가

ADR 6개가 모두 구현되면 다음 질문에 명확히 답할 수 있어야 한다.

> Q1. 매처가 정산 트랜잭션 commit 후 publish 실패하면 trade event 가 어떻게 살아남는가?
> A. (ADR-0002) `OutboxEvent` 테이블에 같은 트랜잭션으로 insert. relay 워커가 polling 으로 publish. publish 성공 시에만 `processed_at` 업데이트.

> Q2. 클라이언트가 같은 POST /orders 를 두 번 보내면 어떻게 되는가?
> A. (ADR-0003) `Idempotency-Key` 헤더 필수. Postgres unique 로 첫 요청만 통과. 두 번째는 cached response 반환.

> Q3. SNS 가 30분 down 이면 notification worker 는 어떻게 동작하는가?
> A. (ADR-0004) 5회 retry → 실패 시 `orbit.dlq.v1` 으로 발행. 메인 토픽 처리는 정상 진행. 운영자가 admin UI 에서 DLQ replay 가능.

> Q4. 매처가 OOM 으로 죽었다 살아나면 호가창은 언제부터 정확한가?
> A. (ADR-0001) `/ready` 가 200 을 반환하기 전까지는 LB 가 트래픽 라우팅 안 함. ready 시점은 (a) DB OPEN 주문 replay 완료 (b) Redis snapshot 재발행 완료 (c) Kafka consumer 가 lag=0 도달.

> Q5. Audit logger 가 죽으면 최대 몇 건의 감사 로그를 잃는가?
> A. (ADR-0006) 0건. eachBatch 로 받아 S3 PutObject 성공 후에만 commit. 단, 동일 batch 가 두 번 처리될 수는 있음 (S3 키가 동일 offset 기반이라 idempotent overwrite).

> Q6. 한 워커의 unhandled exception 이 다른 워커에 영향 주는가?
> A. (ADR-0005) 영향 없음. 4개 워커가 각자 별 컨테이너로 deploy.

이 6개 질문에 자신 있게 답할 수 있게 되는 것이 본 시리즈의 종착점이다.

---

## 8. 다음 단계

- 본 분석 단계 (`00`–`03`) 완료.
- ADR 6개 작성: `adr/0001`–`adr/0006`.
- 각 ADR 작성 후 PR 1건씩 나누어 구현.
- 구현 후 본 문서의 판정을 "✅ OK" 로 갱신하는 round-trip 도 빠뜨리지 않는다.
