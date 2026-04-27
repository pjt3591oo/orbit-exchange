# 장애 시나리오 — Overview

## 0. 이 문서가 존재하는 이유

ORBIT Exchange 는 **설계 문서 (`SYSTEM_DESIGN.md`) 가 묘사하는 의도** 와 **실제 코드의 동작** 사이에 의미 있는 갭을 가지고 있다. 설계는 outbox / idempotency / DLQ / bulkhead 같은 패턴을 *언급* 하지만, 코드는 이를 *강제* 하지 않는 지점이 다수 있다.

이 갭은 학습 프로젝트로서는 정상이지만, "어떤 장애가 났을 때 시스템이 무엇을 보장하는가" 라는 질문에 답하려면 명시적으로 정리해 두어야 한다. 본 문서 시리즈는 그 정리 결과이며, 두 단계를 거친다.

1. **분석 (이 디렉토리)** — 잠재 장애 목록, 코드 실측, 갭 분석
2. **의사결정 (`adr/`)** — 분석으로 드러난 갭에 대해 어느 패턴으로 메울지 결정

본 문서는 시리즈의 표지 역할을 하며, 독자가 어디부터 읽어야 할지 안내한다.

## 1. 장애 도메인 맵

장애를 6개 도메인으로 분류한다. 각 도메인은 서로 다른 *해결 패턴* 을 요구하므로 분리해서 다룬다.

| 도메인 | 영문 | 핵심 질문 | 대표 패턴 |
|---|---|---|---|
| **A. State Recovery** | 상태 복구 | "프로세스가 죽었다 살아났을 때 무엇을 복원하는가?" | snapshot, event sourcing, leader election |
| **B. Message Delivery** | 메시지 전달 신뢰성 | "DB 와 Kafka 둘 다에 써야 하는 데이터가 한쪽에서만 성공하면?" | transactional outbox, CDC, at-least-once + idempotency |
| **C. Concurrency & Integrity** | 동시성 / 무결성 | "두 트랜잭션이 동시에 같은 잔고를 수정하면?" | optimistic locking (`@version`), pessimistic (`SELECT FOR UPDATE`), idempotency key |
| **D. Isolation / Bulkhead** | 격리 | "한 컴포넌트의 장애가 다른 컴포넌트로 전파되지 않게 하려면?" | 프로세스 분리, per-tenant queue, circuit breaker |
| **E. External Dependencies** | 외부 의존 | "DB / Kafka / Redis / 외부 API 가 일시적으로 죽으면?" | retry with backoff, circuit breaker, fallback, graceful degradation |
| **F. Observability of Failures** | 장애 가시성 | "장애가 났는지 어떻게 *사람이* 알아챌 수 있는가?" | DLQ replay UI, lag alert, reconciliation drift, runbook |

## 2. Severity 분류

각 장애 항목은 다음 기준으로 등급을 매긴다.

| Severity | 의미 | 예시 |
|---|---|---|
| **🔴 CRITICAL** | 사용자 자금이 실제로 잘못 계산되거나, 매칭 결과가 영구히 유실될 수 있음 | matcher commit 후 publish 실패 → trade 유실 |
| **🟠 HIGH** | 사용자 경험에 가시적 손상 (중복 알림, 락 영구 점유, 주문 사라짐) | dual-write 실패 시 funds 영구 lock |
| **🟡 MEDIUM** | 시스템 안정성 저하지만 데이터 무결성은 유지 | rebalance storm, 중복 push 알림 |
| **🟢 LOW** | 운영 편의 / 가시성 부족 | health check 가 실제 상태 미반영 |

자금 무결성에 영향이 있는 항목은 다른 모든 작업보다 우선한다.

## 3. 시스템에서 다루지 않는 것 (Out of Scope)

본 시리즈는 *설계* 관점의 장애만 다룬다. 다음은 의식적으로 제외했다.

- **컴플라이언스 / 커스터디 / KYC** — 거래소가 운영되려면 필수지만 코드 설계 영역이 아님
- **인프라 HA (RDS multi-AZ, MSK, …)** — 클라우드 컴포넌트 선택의 문제이며 현재 LocalStack/docker-compose 기반에서는 의미 없음
- **사용자 인증 / 세션 보안** — 별도 영역
- **DDoS / WAF** — 네트워크 레이어

이들은 운영 진입 시점에 별도 시리즈로 다룬다.

## 4. 읽는 순서

| 순서 | 문서 | 분량 | 역할 |
|---|---|---|---|
| 1 | `01-component-inventory.md` | 길다 | 컴포넌트별로 *이론적으로* 일어날 수 있는 장애 목록 |
| 2 | `02-current-state-audit.md` | 가장 길다 | 위 목록 각 항목이 *코드에서 실제로* 어떻게 처리되는지 (file:line 인용) |
| 3 | `03-gap-analysis.md` | 중간 | 1과 2의 차이를 severity × likelihood 매트릭스로 정리 |
| 4 | `adr/000N-*.md` | 각 중간 | 갭을 메울 의사결정 6개 |

먼저 `03-gap-analysis.md` 의 매트릭스만 봐도 전체 그림은 잡힌다. 디테일이 필요할 때 `01`/`02` 로 거슬러 올라가면 된다.

## 5. ADR 인덱스

분석 결과 도출된 6개 의사결정.

| ADR | 제목 | 다루는 도메인 |
|---|---|---|
| [0001](adr/0001-matcher-recovery.md) | Matcher 상태 복구 전략 | A |
| [0002](adr/0002-outbox-pattern.md) | DB ↔ Kafka dual-write — outbox 채택 | B |
| [0003](adr/0003-idempotency-policy.md) | Idempotency 정책 통합 | B, C |
| [0004](adr/0004-dlq-topology.md) | DLQ 토폴로지 + replay 절차 | B, F |
| [0005](adr/0005-worker-bulkhead.md) | Worker 프로세스 격리 | D |
| [0006](adr/0006-audit-at-least-once.md) | Audit logger at-least-once 보장 | B, F |

## 6. 본 시리즈가 *답하지 않는* 질문

다음은 분석 단계에서 의도적으로 결론을 내지 않는다. ADR 단계에서 정식으로 다룬다.

- "matcher 를 leader-follower 로 갈 것인가, 단일 + WAL 로 갈 것인가" — ADR-0001
- "outbox vs CDC (Debezium)" — ADR-0002
- "idempotency key 를 Postgres unique 로 강제할지 Redis SETNX 로 할지" — ADR-0003
- "DLQ 재시도를 자동화할지 사람 손으로만 처리할지" — ADR-0004
- "워커를 별 프로세스로 띄울지 별 컨테이너로 띄울지" — ADR-0005
- "audit flush 를 eachBatch + manual commit 으로 갈지, 메모리에 저장 후 별도 워커가 처리할지" — ADR-0006

분석 문서는 "*무엇이 문제인가*" 까지만 답하고, "*어떻게 해결할 것인가*" 는 ADR 의 몫이다.
