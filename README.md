# ORBIT Exchange

프로덕션 지향으로 설계한 학습용 스팟 암호화폐 거래소.
HTTP API · 매칭엔진 · WebSocket 게이트웨이 · 백그라운드 워커가 **각자의 프로세스**로 분리되어 Kafka command/event 토폴로지 위에서 동작합니다 (Phase 1 — TypeScript). 자체 매칭엔진은 npm 패키지 [`orderbook-match-engine`](https://www.npmjs.com/package/orderbook-match-engine) v2를 그대로 사용하고, AWS(S3 / SNS / SQS / Secrets Manager)는 LocalStack으로, 운영자 인증은 Keycloak 으로 로컬에서 그대로 동작합니다. 고객 프론트(`apps/web`)와 운영자 어드민 콘솔(`apps/admin`)이 별도 SPA로 분리되어 있습니다.

![ORBIT Exchange — BTC/KRW 트레이딩 뷰](./images/image.png)

- **시스템 설계**: [SYSTEM_DESIGN.md](./SYSTEM_DESIGN.md)
- **UI 디자인**: [Claude Design · ORBIT Exchange](https://claude.ai/design/p/38eb67ef-e881-468a-a0aa-4358fc5d317d?via=share&file=ORBIT+Exchange.html)
  — Claude Design에서 만든 라이트테마 핀테크 시안. JSX 원본은 [design/](./design) 디렉토리에 함께 커밋되어 있고,
  `apps/web` 은 그 토큰/레이아웃을 TypeScript로 이식한 구현입니다.

```
apps/
  api/        NestJS — HTTP only (auth · 잔고 락 · 주문 생성 → Kafka command 발행)   :3000
  matcher/    NestJS standalone — Kafka command 컨슘 → in-memory book → 정산 트랜잭션
  realtime/   NestJS — Socket.IO 게이트웨이 (Redis pub/sub 구독, 스냅샷 캐시 read)   :3001
  workers/    NestJS — Kafka consumer들 (candle / WS fanout / SNS / S3 audit)
  web/        Vite + React — 라이트 테마 트레이딩 뷰 (디자인: design/*)             :5173
  admin/      Vite + React — 운영자용 어드민 콘솔 (Keycloak OIDC 로그인)             :5174
packages/
  shared/         공용 DTO / 이벤트 스키마 / Kafka topic·Redis key 상수
  observability/  OTel SDK · prom-client 헬퍼 · pino mixin · /metrics 엔드포인트
infra/
  localstack/bootstrap.sh        S3 / SNS / SQS / Kafka 토픽 시드
  keycloak/realm-export.json     orbit realm + 4 role / 5 group / 5 시드 운영자
  postgres/init.sh               keycloak DB 자동 생성 (postgres 첫 부팅 시)
  prometheus/prometheus.yml      4 service scrape config
  loki/loki-config.yml           single-binary Loki (7d retention)
  tempo/tempo.yml                OTLP gRPC/HTTP receiver + service-graph generator
  grafana/{datasources,dashboards}/  자동 provisioning + 4 baseline 대시보드 JSON
scripts/
  order-gen.ts        부하 테스트 (pnpm orders:gen)
  grafana-export.ts   UI 편집 → 파일로 저장 (pnpm grafana:export)
  grafana-reload.ts   provisioning 즉시 재읽기 (pnpm grafana:reload)
```

### 토폴로지 (Phase 1 — TS 분리 완료)

```
            ┌─────────────────── Browser (React) ───────────────────┐
            │  REST  /api → :3000          WS  /socket.io → :3001   │
            └──────────┬────────────────────────────┬───────────────┘
                       │                            │
                       ▼                            ▼
              ┌──────────────────┐         ┌──────────────────┐
              │   apps/api       │         │  apps/realtime   │
              │  (HTTP, stateless)│         │ (Socket.IO only) │
              │  • lock+create    │         │ • snapshot read  │
              │  • publish CMD    │         │ • Redis psub     │
              └──────┬───────────┘         └────────▲─────────┘
                     │ Kafka                        │ Redis pub/sub (md:*)
                     │ orbit.order-commands.v1      │   + ob:snapshot:* (SET)
                     ▼                              │
              ┌──────────────────┐  Kafka events    │
              │  apps/matcher    │──────────────────┤
              │ • in-memory book │ trades/orders/   │
              │ • per-market PQ  │ orderbook/user-  │
              │ • settle in TX   │ events           │
              └──────┬───────────┘                  │
                     │                              │
            ┌────────┴───────┐               ┌──────┴──────┐
            ▼                ▼               ▼             ▼
        Postgres        Kafka topics    apps/workers   (S3 / SNS)
       (orders,      (orbit.*.v1)      (candle/fanout/
        trades,                        notify/audit)
        wallets)
```

수평 확장 모델: `api` / `realtime` / `workers`는 stateless → 다중 replica 가능. `matcher`는 마켓 단위 owner이므로 **마켓 샤딩(consumer group + 파티션 키)** 으로만 확장 (단일 프로세스 = 단일 in-memory book).

---

## 0. 사전 요구사항

| | 버전 | 확인 |
|---|---|---|
| Docker Desktop | running | `docker info` |
| Node.js | ≥ 20 (권장 24) | `node -v` |
| pnpm | ≥ 10 | `corepack enable && corepack use pnpm@10` |
| AWS CLI | 최신 | `aws --version` (LocalStack 부트스트랩용) |

---

## 1. 원클릭 세업 (최초 1회)

```bash
pnpm setup
```

내부적으로 다음이 순차 실행됩니다:

1. `pnpm install` — 전 워크스페이스 의존성 설치
2. `shared:build` — `packages/shared` 빌드 (api / matcher / realtime / workers 가 import 하는 공용 타입·상수)
3. `infra:up` — Docker 컨테이너 9개 기동:
   - 데이터: **postgres / redis / redpanda / localstack**
   - 인증: **keycloak**
   - 관측 (LGTM): **prometheus / loki / tempo / grafana**
4. `infra:wait` — 전 컨테이너 `healthy` 될 때까지 대기 (Keycloak realm import 가 가장 오래 걸림 — ~60s)
5. `infra:bootstrap` — LocalStack에 S3 버킷, SNS 토픽, SQS 큐, Kafka 토픽 생성
6. `db:migrate` — Prisma 마이그레이션 (User · Wallet · Market · Order · Trade · Candle · **AdminAuditLog**)
7. `db:seed` — 자산/마켓 + 데모 계정 2개(alice, bob) 시드. 어드민 계정 5명은 Keycloak 의 `infra/keycloak/realm-export.json` 으로 자동 시드 (§7). Grafana 대시보드 4종은 `infra/grafana/dashboards/*.json` 으로 자동 provisioning (§5).

> 처음 받는 Docker 이미지 합계 ~2.5GB (postgres 100MB / redpanda 600MB / keycloak 600MB / grafana+loki+tempo+prometheus 800MB / localstack 500MB) — 첫 실행은 수 분 걸릴 수 있습니다.

---

## 2. 개발 서버 실행

```bash
pnpm dev
```

한 터미널에서 **api · matcher · realtime · workers · web** 이 병렬로 기동됩니다.

기동이 끝나면:

| 용도 | URL |
|---|---|
| 고객 프론트 (Vite) | http://localhost:5173 |
| 어드민 콘솔 (Vite) | http://localhost:5174 |
| API (HTTP) | http://localhost:3000/api/v1/health |
| Realtime (WS + health) | http://localhost:3001/health |
| Matcher (ops only — `/metrics` + `/health`) | http://localhost:3002/health |
| Workers (ops only — `/metrics` + `/health`) | http://localhost:3003/health |
| Redpanda Console (Kafka UI) | http://localhost:8080 |
| Keycloak 콘솔 (admin/admin) | http://localhost:8081 |
| **Grafana** (anonymous Admin) | **http://localhost:3030** |
| Prometheus | http://localhost:9090 |
| Loki API | http://localhost:3100 |
| Tempo query | http://localhost:3200 |
| LocalStack | http://localhost:4566 |

> Matcher는 HTTP를 노출하지 않습니다 (Kafka command 컨슈머 전용). 헬스체크는 로그의 `matching engines ready: <markets>` / `subscribed to orbit.order-commands.v1` 로 확인.

### 개별 실행 (선호하는 경우)

```bash
pnpm dev:api       # HTTP API           :3000
pnpm dev:matcher   # 매칭/정산 워커      (no port)
pnpm dev:realtime  # Socket.IO 게이트웨이 :3001
pnpm dev:workers   # Kafka consumers
pnpm dev:web       # 고객 프론트         :5173
pnpm dev:admin     # 어드민 콘솔         :5174
```

---

## 3. 데모 계정 & 빠른 체결 시나리오

시드된 계정 (둘 다 비밀번호 `orbit1234!`):

| 이메일 | 초기 잔고 |
|---|---|
| alice@orbit.dev | KRW 1억, BTC 2, ETH 10, USDT 50,000 |
| bob@orbit.dev   | KRW 1억, BTC 2, ETH 10, USDT 50,000 |

체결을 바로 보고 싶다면 브라우저 2개(또는 시크릿창)로 같이 접속:

1. **alice** 로그인 → `BTC-KRW` 트레이딩 뷰 → 매도 지정가 `50,000,000 KRW × 0.1 BTC`
2. **bob** 로그인 → 같은 마켓에서 매수 지정가 `50,000,000 × 0.06`
3. 좌측 호가창 / 차트 / 체결 테이프 / 하단 미체결 탭이 실시간 갱신됨

내부 흐름:

```
api (POST /orders)
  └─ 잔고 lock + Order(OPEN) 생성 (한 트랜잭션)
  └─ Kafka publish → orbit.order-commands.v1  [key=symbol]
                              │
                              ▼
matcher (consumer group orbit.matcher)
  └─ per-market p-queue → orderbook.add()  → trades 산출
  └─ 정산 트랜잭션 (지갑 update + Trade row + Order status)
  └─ Kafka publish → orbit.{trades,orders,orderbook,user-events}.v1
  └─ Redis SET     → ob:snapshot:<symbol>  (TTL 60s, throttle 100ms)
                              │
                              ▼
workers/market-data-fanout
  └─ Kafka → Redis publish → md:<symbol>:{orderbook,trade}
                              │
                              ▼
realtime (/market namespace)
  └─ subscribe 시 Redis SET 으로 스냅샷 1회 emit
  └─ md:* psubscribe → 룸별 emit
```

검증된 정산 식 (시드 마켓 BTC-KRW: makerFee=10bp / takerFee=20bp):
- Alice ASK 0.1 BTC @ 50M, Bob BID 0.06 → trade 0.06@50M
- Alice 수령: `0.06 × 50,000,000 × (1 − 10bp)` = **+2,997,000 KRW**, ASK 잔량 0.04 BTC locked
- Bob   수령: `0.06 × (1 − 20bp)` = **+0.05988 BTC**, KRW 3,000,000 차감

### 터미널에서 검증 (선택)

```bash
# 로그인
ALICE=$(curl -s -X POST http://localhost:3000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"alice@orbit.dev","password":"orbit1234!"}' | jq -r .accessToken)

# ASK 0.1 BTC @ 50,000,000 KRW
curl -s -X POST http://localhost:3000/api/v1/orders \
  -H "Authorization: Bearer $ALICE" \
  -H 'Content-Type: application/json' \
  -d '{"market":"BTC-KRW","side":"ASK","type":"LIMIT","price":"50000000","quantity":"0.1"}' | jq

# 잔고 확인
curl -s http://localhost:3000/api/v1/wallets -H "Authorization: Bearer $ALICE" | jq
```

---

## 4. 인프라 직접 점검 (Kafka / Redis / S3 / SNS)

> 평소 대시보드는 §5 Grafana 로 보고, 이 절은 **수동으로 토픽 / 키 / 큐를 들여다봐야 할 때** 의 CLI 모음.

```bash
# Kafka 토픽 메시지 수
docker exec orbit-redpanda rpk topic describe orbit.trades.v1 -p
docker exec orbit-redpanda rpk topic describe orbit.order-commands.v1 -p

# matcher 컨슈머 그룹 lag
docker exec orbit-redpanda rpk group describe orbit.matcher

# 최근 체결 이벤트 1개
docker exec orbit-redpanda rpk topic consume orbit.trades.v1 --num 1 --offset start --format '%v\n'

# 호가창 스냅샷 캐시 (matcher가 throttle 100ms / TTL 60s 로 write)
docker exec orbit-redis redis-cli GET ob:snapshot:BTC-KRW

# 실시간 fanout 채널 엿보기 (Ctrl-C로 종료)
docker exec orbit-redis redis-cli psubscribe 'md:*'

# 감사 로그 (S3, LocalStack)
aws --endpoint-url http://localhost:4566 \
    s3 ls s3://orbit-audit-logs/ --recursive

# SNS → SQS 배송된 사용자 알림 수
aws --endpoint-url http://localhost:4566 \
    sqs get-queue-attributes \
    --queue-url http://localhost:4566/000000000000/orbit-user-events-subscriber \
    --attribute-names ApproximateNumberOfMessages
```

> LocalStack용 자격증명은 bootstrap 스크립트에 이미 `AWS_ACCESS_KEY_ID=test / AWS_SECRET_ACCESS_KEY=test / AWS_DEFAULT_REGION=ap-northeast-2` 로 들어있습니다. 별도 파이어월 설정 없이 그대로 동작합니다.

---

## 5. 관측 / Grafana 대시보드 (LGTM 스택)

사용자 서비스 4개 (api · matcher · realtime · workers) 의 **메트릭 / 로그 / trace** 를 한 자리에서 봅니다. 어드민(`apps/admin`) 과 Keycloak 은 관측 대상 외.

### 진입

```
http://localhost:3030          # Grafana — anonymous Admin (로그인 폼 비활성)
좌측 Dashboards → ORBIT 폴더    # 4개 대시보드 자동 provisioning
```

### 토폴로지

```
사용자 서비스 (api/matcher/realtime/workers)
  ├── /metrics       ──► Prometheus :9090 (15s scrape)
  ├── pino → stdout  ──► (현재 dev) pino-loki transport ──► Loki :3100
  └── OTel SDK       ──► Tempo :4317 (OTLP gRPC)
                          │
                          └─► metrics_generator (service-graph + span-metrics)
                              ──► Prometheus remote-write

Grafana :3030 ──► 3 datasource 자동 provisioning (Prometheus / Loki / Tempo)
                  + log↔trace deep link (Loki derived field on trace_id)
                  + trace↔log deep link (Tempo "Logs for this span" tag → service)
                  + Service Graph (Tempo Explore 탭)
```

### 6개 baseline 대시보드 (자동 provisioning)

| UID / 파일 | 무엇 |
|---|---|
| `orbit-overview` | 4 서비스 CPU / Heap / Event-loop p99 + HTTP RPS · 에러율 · submit p50/p95/p99 + WS 연결수 + room emit rate |
| `orbit-pipeline` | 시장별 submit rate (BID/ASK), 결과 분포 (ok/4xx/5xx), trade rate (taker side), 취소 (user vs admin), 시장별 submit p50/p95/p99, frozen 차단 카운터 |
| `orbit-matcher` | 시장별 settle p50/p95/p99, 시장별 p-queue depth, 시장별 책 깊이 (bid/ask level 수), 명령 결과 (ok/noop/error), settle 에러 stat |
| `orbit-kafka` | 토픽별 publish rate / errors / p95 duration, worker 처리량 (worker×topic×result), worker handler p95, 누적 에러 stat |
| `orbit-service-map` | Tempo 자동 service map (NodeGraph 패널) + edge별 RPS / latency / 누적 호출수 표 + 서비스별 spanmetrics RED + Top-10 hot path |
| **`orbit-reliability`** | Outbox 백로그 / 처리량, Idempotency hit/miss/conflict, Consumer dedupe, Retry tier 분기, DLQ 적체, 서비스 readiness — ADR-0001~0006 의 모든 invariant 한 화면 |

### 커스텀 비즈니스 메트릭 (`packages/observability/src/metrics.ts`)

| 메트릭 | 종류 | 라벨 |
|---|---|---|
| `orbit_orders_submitted_total` | Counter | market, side, type, result(ok/4xx/5xx) |
| `orbit_order_submit_duration_ms` | Histogram | market |
| `orbit_orders_cancelled_total` | Counter | market, origin(user/admin) |
| `orbit_frozen_blocks_total` | Counter | — |
| `orbit_matcher_settle_duration_ms` | Histogram | symbol, cmdType(SUBMIT/CANCEL) |
| `orbit_matcher_queue_depth` | Gauge | symbol |
| `orbit_orderbook_depth_levels` | Gauge | market, side |
| `orbit_matcher_commands_consumed_total` | Counter | cmdType, result(ok/noop/error) |
| `orbit_trades_executed_total` | Counter | market, taker_side |
| `orbit_kafka_publish_duration_ms` | Histogram | topic, result |
| `orbit_realtime_active_connections` | Gauge | namespace |
| `orbit_realtime_room_emit_total` | Counter | kind(trade/orderbook/candle) |
| `orbit_worker_messages_processed_total` | Counter | worker, topic, result |
| `orbit_worker_handler_duration_ms` | Histogram | worker |
| `orbit_outbox_appended_total` | Counter | topic |
| `orbit_outbox_pending_count` | Gauge | topic |
| `orbit_outbox_oldest_age_seconds` | Gauge | topic |
| `orbit_outbox_relay_published_total` | Counter | topic, result |
| `orbit_outbox_relay_publish_duration_ms` | Histogram | topic |
| `orbit_idempotency_hit_total` | Counter | method, path |
| `orbit_idempotency_miss_total` | Counter | method, path |
| `orbit_idempotency_conflict_total` | Counter | method, path |
| `orbit_dedupe_hit_total` | Counter | worker |
| `orbit_dedupe_miss_total` | Counter | worker |

기본 Node 메트릭 (`process_cpu_*`, `nodejs_heap_*`, `nodejs_eventloop_lag_*`) 도 자동 노출.

### log ↔ trace 연동

각 앱의 pino mixin 이 active OTel context 의 `trace_id` / `span_id` 를 모든 로그 라인에 자동 주입:

```json
{"level":30,"time":...,"msg":"request completed","trace_id":"cd9e66b2528e2719b78208515230d96e","span_id":"87210d0a138c9584",...}
```

Grafana 의 Loki datasource 에 derived field 가 설정되어 있어 — 로그 펼치면 `trace_id` 옆에 **"View trace"** 버튼 → 그 trace 의 Tempo span 으로 점프.

반대로 Tempo trace 에서 한 span 클릭 → "Logs for this span" 버튼 → 그 trace 의 Loki 로그만 필터.

### Tempo Service Graph

Tempo 의 `metrics_generator` 가 들어오는 span 의 parent-child 관계를 분석해서 **서비스 간 호출 그래프** 를 자동 생성. 별도 코드 없음.

```
Grafana → Explore → Tempo datasource → "Service Graph" 탭
```

api → matcher → workers 의존을 노드 그래프로 표시. edge 굵기 = 호출 빈도, 색 = 에러율. 분산 trace 의 진짜 가치.

### Kafka 컨슈머의 trace context 전파 — `withKafkaContext`

`@opentelemetry/auto-instrumentations-node` 의 kafkajs 인스트루먼트는 producer 측에서 `traceparent` 헤더를 자동 inject 하지만, **consumer 측 `eachMessage` 핸들러를 propagated context 안에서 자동으로 활성화하지는 못합니다** (버전/구성에 따라). 그러면 핸들러 안의 `redis.publish` / `prisma.upsert` 같은 자식 호출이 root span 으로 떠서 service map 에 `matcher → workers → redis` 같은 edge 가 안 그려집니다.

해결 헬퍼: `@orbit/observability/kafka-trace` 의 `withKafkaContext`. 헤더에서 `traceparent` 를 추출 → `context.with` 으로 활성화 → CONSUMER span 시작 → 핸들러 실행. 매처와 4개 워커 모두 이 패턴으로 감싸져 있음.

```ts
import { withKafkaContext } from '@orbit/observability';

await consumer.run({
  eachMessage: ({ topic, partition, message }) =>
    withKafkaContext(
      { worker: 'market-data-fanout', topic, partition, message },
      async () => {
        // 기존 핸들러. 이 안의 모든 span 은 producer 의 자식이 됨
      },
    ),
});
```

→ Tempo service map 에 `<producer> → <consumer>` edge 가 자동 등장.

> **새 Kafka 컨슈머 추가 시 반드시 이 헬퍼로 감싸세요.** 안 감싸면 trace 가 끊겨 분산 디버깅이 의미 없어짐.

### 운영 워크플로우 — 매번 초기화 시

```bash
pnpm infra:reset   # 볼륨까지 삭제 (대시보드 포함)
pnpm infra:up      # 부팅 시 ORBIT 폴더에 4 대시보드 자동 import
```

### 대시보드 수정 → 파일로 보존

```bash
# 1. http://localhost:3030 에서 UI 편집 + Save
# 2. dump
pnpm grafana:export
# 3. git diff infra/grafana/dashboards/  → commit
```

기존 파일명 (`orbit-overview.json` 등) 을 자동 매칭해 덮어씀 — 중복 생성 X.

### 파일 직접 수정 → 즉시 반영

```bash
# 30초 자동 polling 안 기다리고 바로 적용
pnpm grafana:reload
```

### 새 메트릭 추가하기

1. `packages/observability/src/metrics.ts` 의 `Metrics` 객체에 신규 Counter/Gauge/Histogram 추가
2. `packages/observability/src/metric-names.ts` 에 상수 추가 (대시보드 JSON 에서 reference 시)
3. `pnpm shared:build && pnpm --filter @orbit/observability build`
4. 사용 측 service: `import { metrics } from '@orbit/observability'; metrics.Metrics.myMetric.inc({...})`
5. 대시보드 JSON 에 panel 추가 → `pnpm grafana:reload`

### 알려진 한계 (의도적)

- **promtail 비활성** — apps 가 호스트에서 `pnpm dev` 로 실행되므로 Docker SD 가 못 잡음. 그래서 pino-loki transport 로 대체. apps 컨테이너화 시 `docker-compose.yml` 의 promtail 블록 주석 해제하면 됨
- **Grafana anonymous Admin** — dev 편의용. 운영은 OIDC/Keycloak 연동 필요
- **Trace 샘플링 100%** — `OTEL_TRACES_SAMPLER_ARG=0.1` 로 환경변수 조절 가능. 운영 진입 시 0.01~0.1 권장

---

## 6. 신뢰성: Outbox + Idempotency

ORBIT 의 두 hot path — **api → matcher** (SUBMIT/CANCEL command) 와 **matcher → workers** (TRADE / ORDER / ORDERBOOK / USER_EVENT events) — 는 모두 *DB write + Kafka publish* 의 dual-write 문제를 가집니다. broker 단절 / 컨테이너 재기동 / OOM 사이의 race 에서 한쪽만 성공하면 funds 영구 lock 또는 trade event 영구 유실로 이어집니다.

**해결: Transactional Outbox 패턴 + Consumer 측 idempotency**.
설계 근거는 [`docs/failure-scenarios/adr/0002-outbox-pattern.md`](docs/failure-scenarios/adr/0002-outbox-pattern.md), [`adr/0003-idempotency-policy.md`](docs/failure-scenarios/adr/0003-idempotency-policy.md) 참조.

### 6.1 Outbox vs DLQ — 무엇이 무엇을 보장하나

둘 다 "실패를 흡수하는 큐 같은 무언가" 라 처음엔 헷갈리기 쉽지만, **메시지 라이프사이클의 다른 단계** 를 보호합니다.

> **Outbox** = "내가 commit 한 메시지가 Kafka 까지 도달했나?" — *publish* 보장 (producer side)
> **DLQ** = "Kafka 에서 받은 메시지를 의도한 side effect 까지 적용했나?" — *처리* 보장 (consumer side)

같은 메시지가 둘 다 거칠 수도 있습니다.

```
api / matcher
   │
   │  prisma.$transaction → DB write + OutboxEvent INSERT
   ▼
[OutboxEvent table]  ← Outbox 영역: "publish 됐는가?"
   │  outbox-relay polling
   │  실패 시 retry — 자동 회복
   ▼
[Kafka 토픽]
   │  consumer (notification / fanout / ...)
   │
   ▼
[side effect 시도]   ← DLQ 영역: "처리 됐는가?"
   │
   │  실패 → withRetryPolicy → retry-30s → DLQ → 운영자 결정 (replay/dismiss)
   ▼
DlqEvent table → admin /dlq
```

| 측면 | **Outbox** | **DLQ** |
|---|---|---|
| 보호 단계 | DB write + Kafka publish 의 dual-write | Consumer 측 처리 실패 |
| 외부 의존 | 없음 (DB + broker = 우리 인프라) | 있음 (SNS / Redis / S3 / 3rd-party) |
| 자동 회복 | ✅ broker 복구 시 relay 가 따라잡음 | ❌ 사람이 결정 (replay vs dismiss) |
| 실패 본질 | 일시적 (broker 단절) — 시간이 해결 | 영구적일 수 있음 (corrupt payload, 영구 4xx) |
| Admin 페이지 | `/outbox` (retry / skip) | `/dlq` (replay / dismiss) |

**왜 분리하나** — Outbox 가 "consumer 까지 도달했나" 까지 책임지려면 모든 downstream consumer 의 정체 + ack 상태 + 외부 API 의 4xx/5xx 의미까지 알아야 하는데, 그건 곧 Kafka 본체 + consumer offset + 외부 도메인 지식을 한 컴포넌트가 다 지는 것. **각 layer 가 자기 control boundary 안의 invariant 만 강제** 하는 게 자연스러운 책임 분리입니다.

| 장애 시나리오 | Outbox | DLQ |
|---|---|---|
| Kafka broker down | ✅ 누적 후 자동 drain | — (consumer 도 메시지 못 봄) |
| API 가 commit 후 OOM | ✅ outbox row 살아있음 | — |
| Notification 의 SNS down | — (Kafka 발행은 정상) | ✅ retry-30s → DLQ |
| Consumer schema mismatch | — | ✅ permanent → 즉시 DLQ |

### 6.2 데이터 흐름

```
┌─ apps/api / apps/matcher ─────────────────────────────────────┐
│                                                                │
│  prisma.$transaction(async (tx) => {                          │
│    await tx.order.create({ ..., commandId });                 │
│    await outbox.publish(tx, {                                 │
│      topic: 'orbit.order-commands.v1',                        │
│      key:   'BTC-KRW',                                        │
│      payload: { commandId, orderId, ... },                    │
│    });                                                         │
│  });                                                           │
│       ↑                                                        │
│   같은 트랜잭션 — DB COMMIT 시점에 Order + OutboxEvent 동시 가시 │
└────────────────────────────────────────────────────────────────┘
                             │
                             ▼ (OutboxEvent 테이블)
┌─ apps/workers/src/outbox-relay (100ms polling) ────────────────┐
│                                                                 │
│   SELECT * FROM "OutboxEvent" WHERE processedAt IS NULL ...   │
│   await producer.send({ topic, key, value, headers });        │
│   await prisma.outboxEvent.update({ processedAt: NOW() });    │
│                                                                 │
└────────────────────────────────────────────────────────────────┘
                             │
                             ▼ (Kafka 토픽)
┌─ apps/matcher / apps/workers (consumer) ───────────────────────┐
│                                                                 │
│   await withDedupe(redis, evt.eventId, WORKER, 3600, async () => {  │
│     await sns.publish(...);   // side effect 한 번만           │
│   });                                                           │
└────────────────────────────────────────────────────────────────┘
```

### 6.3 Producer 측 — `OutboxPublisherService`

```ts
// apps/api/src/order/order.service.ts (발췌)
const commandId = randomUUID();   // matcher 측 dedupe 키
await this.prisma.$transaction(async (tx) => {
  const order = await tx.order.create({ data: { ..., commandId } });
  await this.outbox.publish(tx, {
    topic: KAFKA_TOPICS.ORDER_COMMANDS,
    key: dto.market,
    payload: { v: 1, type: 'SUBMIT', commandId, orderId: order.id, ... },
  });
});
// 더 이상 kafka.send() 직접 호출 없음 — outbox-relay 가 발행
```

`apps/api/src/kafka/outbox-publisher.service.ts` 와 `apps/matcher/src/kafka/outbox-publisher.service.ts` 양쪽에 같은 인터페이스. matcher 의 `SettlerService` 도 정산 트랜잭션 안에서 TRADE / ORDER_ADDED / ORDERBOOK_SNAPSHOT / USER_EVENT 모두 outbox 로 보냄.

### 6.4 Relay — `apps/workers/src/outbox-relay`

| 환경변수 | 기본값 | 의미 |
|---|---|---|
| `OUTBOX_POLL_MS` | `100` | 미처리 행이 없을 때 polling 간격 |
| `OUTBOX_BATCH` | `200` | 한 번에 가져오는 행 수 (백로그 따라잡기 시 즉시 다음 batch) |

producer 는 kafkajs `idempotent: true` + 8회 retry. broker 가 5분 down 이어도 relay 가 catch up.

### 6.5 At-least-once 경계 — 의식적 trade-off

`producer.send()` 성공 직후 `prisma.outboxEvent.update({ processedAt: NOW() })` 가 실패하면 → 다음 polling tick 에서 같은 행을 다시 발행 → **같은 메시지가 Kafka 에 두 번**.

이는 outbox 패턴의 *설계상* at-least-once 경계이고, 다음 4중 방어로 흡수합니다.

| 방어선 | 어디서 | 무엇을 보장 |
|---|---|---|
| 1. Producer idempotent | kafkajs `idempotent: true` | 같은 producer session 안의 중복 차단 |
| 2. Consumer dedupe | `withDedupe(redis, eventId)` (notification, market-data-fanout) | side effect 한 번만 |
| 3. Settler 멱등 분기 | `order.status === 'FILLED'` 면 no-op + commandId mismatch 감지 | 자금 두 번 차감 안 됨 |
| 4. DB unique | `Trade.matchId` UNIQUE | 같은 trade row 두 번 INSERT 불가 |

### 6.6 클라이언트용 — `Idempotency-Key` 헤더 (선택, 강력 권장)

```bash
curl -X POST http://localhost:3000/api/v1/orders \
  -H "Authorization: Bearer $TOK" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000" \
  -d '{"market":"BTC-KRW","side":"BID","type":"LIMIT","price":"50000000","quantity":"0.01"}'
```

- `Idempotency-Key` 는 **UUID v4** 여야 함 (포맷 잘못이면 409)
- 24h 캐시 윈도우 내 같은 키 + 같은 body → 캐시된 응답 그대로 반환
- 같은 키 + 다른 body → 409 Conflict (키 재사용 버그 방지)
- 헤더 없으면 동작은 종전과 동일 (멱등성 강제 안 함)

저장소: `IdempotencyKey` 테이블, `(userId, key, method, path)` unique. 만료 행은 5분마다 cron-style cleanup.

### 6.7 운영자 모니터링

```promql
# Outbox 백로그가 쌓이는지
orbit_outbox_pending_count{topic=~".+"}              # > 100 for 1m → WARN
orbit_outbox_oldest_age_seconds{topic=~".+"}         # > 30s for 1m → WARN

# Relay 가 발행 실패하고 있는지
sum(rate(orbit_outbox_relay_published_total{result="error"}[5m])) by (topic)

# Idempotency 사용 패턴
sum(rate(orbit_idempotency_hit_total[5m])) by (path)        # 같은 키 재요청 빈도
sum(rate(orbit_idempotency_conflict_total[5m])) by (path)   # 키 재사용 버그 감지

# Consumer dedupe — 중복 도달 빈도 가시화
sum(rate(orbit_dedupe_hit_total[5m])) by (worker)
```

알림 권장값은 ADR-0002 §D5 / ADR-0003 §D6 참조.

### 6.8 새 producer 추가 시 체크리스트

새로운 코드 경로에서 Kafka 로 publish 하고 싶으면:

1. `kafka.send()` 직접 호출 ❌
2. `prisma.$transaction(async (tx) => { ... await outbox.publish(tx, { topic, key, payload }); })` ✅
3. payload 에 `commandId` (command 류) 또는 `eventId` (event 류) UUID 포함
4. 해당 토픽 컨슈머가 있다면 `withDedupe` 로 핸들러 감싸기

이 4단계만 지키면 같은 신뢰성 보장이 자동으로 적용됩니다.

### 6.9 DLQ + 재시도 토폴로지 (ADR-0004)

worker 가 던지는 예외는 `withRetryPolicy` 가 분류합니다.

```
[main 토픽]
   │ throw
   ▼
[in-flight retry 2회]
   │ 여전히 실패
   ▼
              ┌─ transient (5xx / timeout / network) → orbit.retry.30s.v1
              │      → 30s 후 retry-30s worker 가 main 토픽으로 republish
              │      → 다시 실패하면 DLQ 로 직행
              └─ permanent (4xx / zod / schema) → orbit.dlq.v1 즉시
                     → dlq-monitor 가 DlqEvent 테이블에 mirror
                     → admin SPA `/dlq` 에서 replay / dismiss
```

| 토픽 | 역할 | 컨슈머 |
|---|---|---|
| `orbit.retry.30s.v1` | 30초 지연 재시도 | `retry-30s` 워커 → 원본 토픽으로 republish |
| `orbit.dlq.v1` | 영구 실패 | `dlq-monitor` 워커 → `DlqEvent` 테이블에 mirror |

**Admin SPA `/dlq` 페이지** (SUPPORT_READ + MARKET_OPS):
- 미해결 DLQ 행 목록 + 필터 (worker / 원본 토픽 / 해결됨 여부)
- payload / headers 펼쳐보기 (자동 JSON pretty-print)
- **replay** — 원본 토픽으로 republish + `resolution = 'replayed'`
- **dismiss** — 처리 불가 마킹 + `resolution = 'dismissed'`
- 두 액션 모두 사유 필수 + `AdminAuditLog` 자동 기록 + DLQ id 입력 challenge

알림 권장:
```promql
sum(rate(orbit_worker_retry_enqueued_total{target="orbit.dlq.v1"}[5m])) > 1   # WARN
orbit_dlq_pending_count > 100                                                  # CRITICAL
orbit_dlq_oldest_age_seconds > 86400                                          # WARN (1일)
```

### 6.10 Liveness vs Readiness (ADR-0001)

각 서비스는 두 종류의 probe 를 노출.

| Endpoint | 의미 | 응답 |
|---|---|---|
| `/health` | **Liveness** — 프로세스가 살아있나 | 항상 200 (프로세스가 살아있는 한) |
| `/ready` | **Readiness** — 트래픽 받을 준비 됐나 | sub-check 모두 통과 시 200, 아니면 503 |

| 서비스 | `/ready` 조건 |
|---|---|
| api | DB 도달 가능 |
| matcher | `MatchingEngineService.isReady()` (boot replay 완료) + DB 도달 |
| realtime | Redis ping OK |
| workers | 활성 워커 1개 이상 (ADR-0005 split 후 per-worker 강화 예정) |

쿠버네티스 마이그레이션 시:
```yaml
livenessProbe: { httpGet: { path: /health, port: ops } }
readinessProbe: { httpGet: { path: /ready, port: ops } }
```

### 6.11 At-least-once audit / candle (ADR-0006)

`audit-logger` 와 `candle-aggregator` 는 `eachBatch` + `autoCommit: false` 패턴으로 작동합니다.

```
fetch batch → 메모리에 누적 → S3 PutObject (또는 Postgres upsert) → 성공해야 offset commit
```

PutObject / upsert 가 실패하면 offset 미commit → 다음 fetch 에서 같은 batch 재시도. S3 키는 `<topic>-<partition>-<firstOffset>.jsonl` 로 결정적이라 중복 발행 시에도 같은 객체에 overwrite — naturally idempotent.

이전 `eachMessage` + `setInterval(flushBatch, 30s)` 패턴은 offset 이 flush 보다 먼저 commit 되어 최대 999건 손실 위험이 있었습니다 (F-WORK-2). 이제 closed.

### 6.12 Worker bulkhead 모드 (ADR-0005)

기본 `pnpm dev` 는 7개 워커를 단일 Node 프로세스에서 실행 (개발 편의). 운영/스테이징에서는 각 워커를 별도 컨테이너로 띄워 한 워커의 OOM / unhandled exception 이 다른 워커로 전파되지 않게 합니다.

```bash
# bulkhead 모드 — 7개 워커 각자 컨테이너
docker compose -f docker-compose.yml -f docker-compose.workers.yml up -d \
  worker-fanout worker-candle worker-notification worker-audit \
  worker-outbox worker-retry worker-dlq

# 각자 ops 포트 (Prometheus scrape):
# 3010 fanout / 3011 candle / 3012 notification / 3013 audit
# 3014 outbox-relay / 3015 retry-30s / 3016 dlq-monitor
```

같은 `apps/workers/Dockerfile` 이미지로 7개 컨테이너. 차이는 `WORKERS=<one>` env 한 개. 메모리 footprint ~80MB × 7 ≈ 560MB.

→ 한 워커 OOM → 그 컨테이너만 restart. 다른 6개는 영향 없음.

### 6.13 자동화 검증 스크립트 — `pnpm reliability:smoke` / `:chaos`

설계만 하고 끝나지 않게, **실제 동작 검증을 코드로** 박아 두었습니다. 모든 invariant 가 회귀 가능한 형태.

#### `pnpm reliability:smoke` — happy path E2E (23 assertions)
```bash
pnpm reliability:smoke
# preflight: api/realtime/matcher/workers 4개 health 200
# bot 프로비저닝: 신규 가입 또는 로그인 + 잔고 충전
# 1) POST /orders (Idempotency-Key 포함)
#    → Order.commandId 생성 ✓
#    → OutboxEvent 행 추가 ✓
#    → outbox-relay 가 15s 내 processedAt 마킹 ✓
#    → matcher 가 ORDERS / ORDERBOOK 토픽으로 후속 publish ✓
# 2) 같은 키 + 같은 body 재요청 → 캐시 응답 (같은 Order.id) ✓
# 3) 같은 키 + 다른 body → 409 Conflict ✓
# 4) UUID v4 형식 아님 → 409 ✓
# 5) /metrics 에 outbox/idempotency/dedupe 카운터 노출 ✓
```

#### `pnpm reliability:chaos` — 실제 장애 주입 (13 assertions)

**Scenario A — Kafka 죽임 → 복구 → catch-up**:
```bash
pnpm reliability:chaos              # A + B 모두
SCENARIOS=A pnpm reliability:chaos  # A 만
```
1. baseline 주문 1건 → relay 가 publish 함을 확인
2. `docker stop orbit-redpanda` (브로커 강제 종료)
3. **브로커가 내려간 상태에서 5개 주문 추가 제출** — API 는 모두 201 (DB 만 쓰므로)
4. OutboxEvent 누적 검증: 미처리 행 정확히 +5 증가
5. `docker start orbit-redpanda` + 헬스체크 대기
6. 60초 내 모든 미처리 행 drain → `processedAt` 마킹
7. **Order 행 5/5 모두 보존** — 데이터 유실 0

**Scenario B — Consumer dedupe**:
1. notification 의 `dedupe_hit_total` 메트릭 baseline 캡처
2. 같은 `eventId` 의 UserEvent 를 Kafka 에 2번 발행 (raw producer)
3. notification 워커가 두 번째 메시지를 dedupe 로 흡수 → `dedupe_hit` 증가 검증

**Scenario C — DLQ end-to-end** (`SCENARIOS=C`):
1. `DlqEvent{worker=notification}` baseline count 스냅샷
2. `docker stop orbit-localstack` (SNS 소스 죽임)
3. UserEvent 1건을 `orbit.user-events.v1` 에 발행
4. notification 핸들러가 SNS publish 실패 → `withRetryPolicy` in-memory counter 가 attempt 추적
5. 메인 토픽에서 in-flight 2회 실패 → `orbit.retry.30s.v1` 으로 escalate
6. 30초 후 retry-30s 가 메인 토픽으로 republish (`x-orbit-attempt: 3` 헤더 포함)
7. notification 또 실패 → header > 0 이므로 즉시 `orbit.dlq.v1` 으로 escalate
8. dlq-monitor 가 consume → `DlqEvent` 행 INSERT
9. **`DlqEvent.attempt = 4`, `originalTopic = orbit.user-events.v1`, `lastError` 에 ECONNREFUSED 보존** ✓
10. `docker start orbit-localstack` 으로 복구

#### 마지막 실측 결과 (2026-04-27)
```
PASS 23/23   pnpm reliability:smoke
PASS 13/13   SCENARIOS=A,B pnpm reliability:chaos
PASS  6/6    SCENARIOS=C   pnpm reliability:chaos
```

브로커가 30초 down → 5개 주문 누적 → 복구 후 60초 내 모두 drain → **0건 손실**.
SNS 가 down → in-flight 2회 → retry-30s 30초 → DLQ → **DlqEvent 행 ~50초 내 admin UI 에 노출**.

### 6.14 대시보드 — `ORBIT — Reliability`

위 6.1~6.11 의 모든 invariant 를 **한 화면** 에서 봅니다. Grafana → Dashboards → "ORBIT — Reliability" (UID `orbit-reliability`):

| 섹션 | 패널 | 답하는 질문 |
|---|---|---|
| **Outbox** | pending count, oldest age, throughput (appended vs published), per-topic pending, publish errors, publish p95 | "outbox-relay 가 따라잡고 있나?" "broker 가 죽었나?" |
| **Idempotency** | hit vs miss /s, conflict /s, conflicts last-1h | "클라이언트가 retry 하고 있나?" "키 재사용 버그 있나?" |
| **Consumer dedupe** | dedupe hit (중복 흡수) vs miss (정상 처리) — worker별 | "outbox-relay 가 같은 메시지 반복 발행 중인가?" |
| **DLQ + Retry** | DLQ pending, oldest age, retry enqueue rate (worker × target), DLQ ingress (original_topic × worker), 1h DLQ enqueues by worker | "DLQ 쌓이고 있나?" "어느 워커가 가장 많이 실패?" |
| **Readiness** | `up{service=~"orbit-.*"}` state-timeline | "지금 어느 서비스가 트래픽을 받을 수 있는 상태인가?" |

`pnpm infra:up` 후 자동 import.

---

## 7. 주문 트래픽 생성기 (부하 테스트)

`scripts/order-gen.ts` 는 전용 봇 유저 N개를 자동 생성·충전한 뒤 `POST /api/v1/orders` 에 정해진 RPS 로 부하를 거는 CLI 입니다. 일반 사용자와 동일한 HTTP 경로를 사용하므로 api → matcher → workers 전체 파이프라인이 그대로 검증됩니다.

```bash
# 기본값: 10 bots × 20 req/s × 60초
pnpm orders:gen

# 부하 테스트 (200 req/s × 30초)
RATE=200 DURATION=30 BOTS=20 pnpm orders:gen

# SIGINT(Ctrl-C) 까지 무한 실행
DURATION=0 pnpm orders:gen

# 다른 마켓
MARKET=ETH-KRW BASE_PRICE=3000000 pnpm orders:gen

# 모든 에러 응답 본문 출력
VERBOSE=1 pnpm orders:gen
```

### 동작 요약

- **봇 프로비저닝**: `loadbot-1@orbit.dev` … `loadbot-N@orbit.dev` 자동 signup (이미 있으면 login). 시작 시 wallet `balance` 만 generous 하게 top-up 하므로 기존 OPEN 주문의 `locked` 는 보존.
- **전송 경로**: 일반 사용자와 동일한 `POST /api/v1/orders` + Bearer JWT.
- **스케줄러**: open-loop. 응답 대기와 무관하게 고정 cadence 로 발송, `MAX_INFLIGHT` 도달 시 `dropped` 로 카운트되어 메모리 폭주를 방지.
- **가격**: `GET /api/v1/markets` 로 tickSize/stepSize/minNotional 을 동적 로드 → mid 가격 random walk + ±`SPREAD_BP` 안에서 양측 호가. side 별 약한 lean 으로 약 70% rest / 30% cross.
- **통계**: 1초마다 delta line + 종료 시 누적 summary (sent/ok/4xx/5xx/err/drop + p50/p95/p99 latency).

### 튜닝 환경변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `API_URL` | `http://localhost:3000` | API 엔드포인트 |
| `MARKET` | `BTC-KRW` | 대상 마켓 (enabled 여야 함) |
| `BOTS` | `10` | 봇 유저 수 (`loadbot-i@orbit.dev`) |
| `RATE` | `20` | 목표 orders/sec |
| `DURATION` | `60` | 초. `0` = SIGINT 까지 |
| `MAX_INFLIGHT` | `200` | in-flight 캡 (초과 시 drop) |
| `BASE_PRICE` | 마켓별 | mid 가격 시드 (BTC-KRW=5천만, ETH-KRW=3백만, BTC-USDT=5만) |
| `SPREAD_BP` | `50` | 양측 호가 분포 (basis points, 50 = ±0.50%) |
| `MARKET_RATIO` | `0.05` | MARKET 주문 비율 (0~1) |
| `QTY_MIN` / `QTY_MAX` | `0.001` / `0.02` | 주문 수량 범위 |
| `FUND_KRW` / `FUND_BTC` / `FUND_ETH` / `FUND_USDT` | 100조 / 100만 / 100만 / 100억 | 봇 wallet top-up 금액 |
| `PASSWORD` | `orbit-bot-pw` | 봇 유저 패스워드 |
| `BOT_PREFIX` | `loadbot` | 봇 이메일 prefix |
| `VERBOSE` | (off) | 모든 4xx/5xx/error 응답 본문 출력 |

### 검증 예시

`RATE=200 DURATION=5 BOTS=10` 으로 1,001건 전송:

```
sent: 1001  ok: 1001  4xx: 0  5xx: 0  err: 0  drop: 0
latency: p50=4.5ms p95=7.3ms p99=11.5ms
```

DB 기준 약 50% 가 즉시 체결, 50% 가 잔류해 organic depth 가 형성됩니다. matcher 컨슈머가 모두 정산했는지는:

```bash
docker exec orbit-redpanda rpk group describe orbit.matcher  # TOTAL-LAG=0 이면 OK
```

> 추가 install 불필요 — `pnpm orders:gen` 은 `pnpm --filter @orbit/api exec tsx ../../scripts/order-gen.ts` 로 동작하며 api 워크스페이스의 tsx + `@prisma/client` 를 그대로 빌려씁니다. `apps/api/.env` 의 `DATABASE_URL` 도 자동 로드합니다.

---

## 8. 어드민 콘솔 (운영자용)

`apps/admin` 은 **운영자 전용** 별도 SPA 입니다. 고객 프론트 (`apps/web`) 와 도메인/포트가 분리되고, 인증도 자체 JWT 가 아니라 **Keycloak OIDC (Authorization Code + PKCE)** 를 씁니다 — 운영자 계정/권한/세션 관리는 Keycloak 콘솔에서 하면 코드 변경 없이 적용됩니다.

### 진입

```
http://localhost:5174       # 자동으로 Keycloak 로그인 페이지로 redirect
```

`pnpm setup` 시 시드된 5개 계정 (모두 비밀번호 `orbit-admin-pw`):

| Email | 그룹 | 권한 |
|---|---|---|
| `admin@orbit.dev` | SuperAdmin | 모든 권한 |
| `support@orbit.dev` | CustomerSupport | `SUPPORT_READ` (읽기 전용) |
| `ops@orbit.dev` | Operations | `SUPPORT_READ` + `MARKET_OPS` (마켓/자산 설정 + 주문 강제 취소) |
| `finance@orbit.dev` | Finance | `SUPPORT_READ` + `WALLET_ADJUST` (사용자 잔고 조정 + freeze) |
| `audit@orbit.dev` | Audit | `AUDITOR` (감사 로그만 조회) |

### 권한 모델 (4 role × 5 group)

권한은 **Keycloak realm role** 로 정의되고, 운영자는 **group** 멤버십으로만 부여받습니다 (직무 단위).

| Role | 부여 범위 |
|---|---|
| `SUPPORT_READ` | 사용자/주문/거래/마켓/지갑 조회 |
| `MARKET_OPS` | 마켓 enable/disable, fee/tick/step 변경, asset CRUD, 주문 강제 취소 |
| `WALLET_ADJUST` | 사용자 잔고 수동 조정, 계정 freeze 토글 (가장 위험) |
| `AUDITOR` | `AdminAuditLog` 조회 (수정 불가) |

### 어드민이 할 수 있는 mutation (모두 `AdminAuditLog` 자동 기록)

| 액션 | 권한 | 사유 필수 |
|---|---|---|
| 마켓 enable/disable, fee/tick 변경 | `MARKET_OPS` | ✅ |
| Asset CRUD | `MARKET_OPS` | (delete만) |
| 주문 강제 취소 (Kafka CANCEL 발행) | `MARKET_OPS` | ✅ |
| 사용자 freeze 토글 | `WALLET_ADJUST` | ✅ |
| 사용자 잔고 ± 조정 | `WALLET_ADJUST` | ✅ + userId 끝자리 재입력 |

`AdminAuditLog` 테이블에는 actor (Keycloak `sub` + email) / action / target / before · after JSON / 사유 / IP / UA 가 기록되고, 어드민 콘솔의 `/audit` 페이지에서 검색·필터·diff 조회 가능합니다.

### Keycloak 콘솔에서 운영 (코드 변경 없음)

```
http://localhost:8081           # admin / admin (master realm)
좌측 상단 dropdown → "ORBIT Exchange" 선택
```

| 작업 | 메뉴 |
|---|---|
| 새 운영자 추가 | Users → "Add user" → Credentials 탭에서 비밀번호 → Groups 탭에서 직무 그룹 join |
| 운영자 권한 변경 | Users → 클릭 → Groups 탭 → group leave/join |
| 강제 로그아웃 | Sessions → 해당 user "Sign out" |
| 로그인 시도/실패 audit | Events → Login events |
| Token TTL 변경 | Realm settings → Tokens (현재 access 5min / SSO session 1h) |

### 어드민 모듈 구조

```
apps/api/src/admin/
  keycloak/   KeycloakAuthGuard (jose JWKS 검증) · KeycloakRolesGuard · @Roles · @CurrentAdmin
  audit/      AdminAuditService · AdminAuditInterceptor · @AdminAction 데코레이터
  users · wallets · markets · assets · orders · trades · stats   각 컨트롤러+서비스
apps/admin/src/
  lib/keycloak.ts    keycloak-js 싱글턴 + 자동 token refresh
  lib/api.ts         axios + 401 → silent refresh + 1회 retry
  components/        AdminShell · Protected · ConfirmDialog · PageHeader
  pages/             Dashboard · Users · UserDetail · Markets · MarketDetail ·
                     Orders · Trades · Assets · Audit
```

향후 운영 시 별도 서비스 (`apps/admin-api`) 로 떼고 IP allowlist / WAF 를 따로 걸기 좋은 구조 — 지금은 같은 NestJS 안에서 path 기반 분리 (`/api/v1/admin/*` + `KeycloakAuthGuard`) 로 두었습니다.

> 운영 환경 전환 시: docker-compose 의 `KEYCLOAK_ADMIN/_PASSWORD` 와 시드된 5개 계정 password 를 즉시 교체하고, `--import-realm` 부팅 옵션을 빼서 운영 중 realm 이 시드 데이터로 덮이지 않게 하세요.

---

## 9. 자주 쓰는 커맨드

| 작업 | 커맨드 |
|---|---|
| 인프라만 내리기 | `pnpm infra:down` |
| 인프라 + 볼륨까지 초기화 | `pnpm infra:reset` |
| 로그 따라보기 | `pnpm infra:logs` |
| DB 스키마 초기화 + 재시드 | `pnpm db:reset && pnpm db:seed` |
| Keycloak realm 만 재import | `docker exec orbit-postgres psql -U orbit -d orbit -c "DROP DATABASE keycloak WITH (FORCE); CREATE DATABASE keycloak;" && docker restart orbit-keycloak` |
| 주문 트래픽 생성 (부하 테스트) | `pnpm orders:gen` (위 §6 참조) |
| Grafana 대시보드 → 파일 dump | `pnpm grafana:export` |
| Grafana provisioning 즉시 재읽기 | `pnpm grafana:reload` |
| 전체 빌드 (CI/배포용) | `pnpm build` |
| shared 재빌드만 | `pnpm shared:build` |
| observability 재빌드만 | `pnpm --filter @orbit/observability build` |

---

## 10. 문제 해결

### API 부트 시 `Cannot find module '@orbit/shared'`
`packages/shared`를 빌드하지 않았을 때 발생. `pnpm shared:build`로 해결.
`pnpm dev`는 내부적으로 먼저 빌드하므로 보통 자동 해결됩니다.

### `EADDRINUSE: address already in use :::3000` 또는 `:::3001`
이전 API / Realtime 프로세스가 남아있음. 다음으로 정리:
```bash
lsof -ti :3000 :3001 | xargs kill
```

### Matcher가 명령을 받지 못함 (주문이 OPEN에서 안 움직임)
1. Matcher 로그에 `subscribed to orbit.order-commands.v1` 가 떴는지 확인
2. `docker exec orbit-redpanda rpk group describe orbit.matcher` 의 `LAG` 가 늘어나면 매처가 죽었거나 재기동 중
3. `apps/matcher/.env` 의 `DATABASE_URL` / `KAFKA_BROKERS` / `REDIS_URL` 확인 (api와 동일해야 함)

### LocalStack `health` 상태에서 bootstrap 실패
LocalStack이 완전히 올라오기 전에 bootstrap이 실행된 경우. `pnpm infra:wait && pnpm infra:bootstrap` 재실행.

### Kafka 토픽이 비어있거나 컨슈머가 lag 쌓임
Workers 프로세스가 죽었을 가능성. `pnpm dev:workers` 로그 확인. 또는
```bash
docker exec orbit-redpanda rpk group describe orbit.candle-aggregator
```

### Keycloak: `Local access required` / `admin / admin` 로그인 실패
첫 부팅 때 `KEYCLOAK_ADMIN/_PASSWORD` 환경변수가 적용되지 않은 경우 (이미 keycloak DB 가 있던 상태에서 부팅 시 무시됨). keycloak DB 만 비우고 재기동:
```bash
docker exec orbit-postgres psql -U orbit -d orbit -c "DROP DATABASE keycloak WITH (FORCE); CREATE DATABASE keycloak;"
docker restart orbit-keycloak
```

### 어드민 콘솔 (5174) 에서 무한 로그인 루프
Keycloak 의 `orbit-admin-web` client redirect URI 가 `http://localhost:5174/*` 인지 확인 (Realm settings → Clients → orbit-admin-web → Settings). 또는 `apps/api/.env` 의 `KEYCLOAK_ISSUER` 값이 `http://localhost:8081/realms/orbit` 인지 확인 — 다르면 토큰 검증이 issuer mismatch 로 실패합니다.

### 어드민 API 401 — 토큰은 받았는데 거부됨
보통 audience mismatch. Keycloak 콘솔 → Clients → `orbit-admin-web` → Client scopes → `orbit-admin-web-dedicated` → "audience-orbit-admin-api" mapper 가 살아있는지 확인. 시드된 realm 에는 기본 포함되어 있습니다.

### Grafana 대시보드 패널이 "No data" 인데 메트릭은 노출됨
원인 1: **`prometheus.yml` 의 target labels 가 메트릭 라벨을 덮어씀.** 우리 setup 은 target labels 를 안 두는데, 손대셨다면 `service: ...` 같은 거 빼고 앱이 보낸 라벨이 그대로 흐르도록 해야 합니다. 검증: `curl 'http://localhost:9090/api/v1/query?query=process_cpu_seconds_total{service=~"orbit-.*"}'` → 4개 series 나와야 정상.

원인 2: **에러 0건일 때 `sum()` 이 빈 vector 반환.** division 패널 (`error %` 등) 은 `or vector(0)` + `clamp_min(분모, 1)` 으로 처리해야 0% 가 그려집니다.

### Grafana UI 에서 편집한 게 다음 reload 때 사라짐
provisioning 의 `allowUiUpdates: true` 라 UI 변경분이 메모리엔 살아있지만, 다음 file scan (30초) 또는 `pnpm grafana:reload` 시 **파일이 우선** → 덮어씌워짐. 보존하려면 편집 직후 `pnpm grafana:export` 로 파일에 다시 dump 하고 commit.

### `pnpm grafana:export` / `:reload` 가 401/403
스크립트는 `admin/admin` basic auth 를 씁니다. 누가 master admin 비번 바꿨다면 `GRAFANA_USER` / `GRAFANA_PASS` env 로 override.

### Loki 가 빈 결과만 반환
앱이 호스트에서 실행 중이고 promtail 비활성 상태 — pino-loki transport 가 로그를 push 합니다. 검증:
```bash
curl -s 'http://localhost:3100/loki/api/v1/labels' | python3 -m json.tool
# `service` label 이 보이고 그 값에 orbit-api 등이 있으면 OK
```
없다면 `apps/*/src/app.module.ts` 의 `pinoTransport()` 가 호출되는지, `LOKI_URL` env (기본 http://localhost:3100) 가 올바른지 확인.

### Tempo 에 trace 가 없음
앱 boot 시 `import { tracing } from '@orbit/observability'; tracing.startTracing(...)` 가 **다른 모든 import 보다 먼저** 실행되어야 auto-instrumentation 이 latch 됩니다. main.ts 의 첫 두 줄이 그것임. import 순서 흐트러뜨리지 마세요.

### Service Map 에 특정 edge 가 안 보임 (예: `matcher → workers`)
원인 1: **컨슈머가 `withKafkaContext` 로 안 감싸짐** — 그러면 핸들러 안의 자식 호출이 root span 으로 떠서 producer 와 연결이 끊김. 4개 워커 + 매처 모두 `eachMessage` 가 `withKafkaContext({...}, async () => { ... })` 로 wrap 돼있어야 함.

원인 2: **Tempo metrics_generator 의 client-server 매칭 윈도우** (~1분). 부하 직후엔 시간이 좀 걸립니다. `Last 6h` 로 시간 범위를 넓혀 보거나 1분 더 기다린 뒤 새로고침. 검증:
```bash
curl -s --data-urlencode 'query=sum by (client, server) (rate(traces_service_graph_request_total[5m]))' \
  http://localhost:9090/api/v1/query | python3 -m json.tool
```

원인 3: redis pub/sub 같은 fire-and-forget 호출은 client side span 이 빠르게 종료되어 server side 와 짝이 안 잡힐 수 있음. virtual_node 로만 표시될 수 있음 (client → redis 만, redis → ... 는 없음).

### Outbox 백로그 (`orbit_outbox_pending_count` 가 계속 증가)
원인 1: **outbox-relay 워커가 안 떠 있음** — `WORKERS` env 에 `outbox-relay` 가 포함됐는지 확인. default 값 `candle,fanout,notification,audit,outbox-relay` 면 자동 활성.
```bash
ps -ef | grep outbox-relay
docker logs orbit-workers 2>&1 | grep -i "outbox relay"
```

원인 2: **Kafka broker 가 down 또는 도달 불가** — relay 의 `producer.send()` 가 모두 실패하고 attempts 만 증가. 메트릭으로 확인:
```promql
sum(rate(orbit_outbox_relay_published_total{result="error"}[1m])) by (topic)
```
broker 복구 후 자동 catch up.

원인 3: **DB 가 느려서 `processedAt` UPDATE 가 밀림** — relay log 에 `outbox attempt-update failed` 나 connection pool 관련 에러 확인. Postgres 의 `pg_stat_activity` 에서 long-running query 점검.

### 같은 trade event 가 WS 클라이언트에 두 번 보임 / 같은 알림이 두 번 도착
원인: **consumer 측 `withDedupe` 가 빠짐 또는 Redis 가 down**. ADR-0003 의 dedupe 는 *fail-open* 설계라 Redis 단절 시 SETNX 가 throw → handler 실행 (중복 가능). 정상화는 Redis 복구 후 자동.
```promql
sum(rate(orbit_dedupe_hit_total[5m])) by (worker)   # 0 이면 dedupe 가 안 도는 중
```

### `Idempotency-Key must be a UUID v4` 응답
형식이 잘못된 키 사용. 클라이언트가 [RFC 4122 §4.4](https://datatracker.ietf.org/doc/html/rfc4122#section-4.4) 호환 UUID v4 를 보내야 함. Node 라면 `crypto.randomUUID()`, 브라우저라면 `crypto.randomUUID()` 또는 `uuid` 라이브러리.

### 같은 키 + 다른 body 로 409 Conflict
의도된 보호. `Idempotency-Key` 를 24h 이내에 *다른 의미의 요청* 에 재사용하는 건 거의 항상 클라이언트 버그. 의도한 거면 새 UUID 발급.

### `withRetryPolicy` 가 escalate 안 되고 같은 메시지가 무한 루프
**과거 버그 (2026-04-27 수정 완료)** — `parseAttempt(ctx.message)` 가 메시지 헤더에서만 `x-orbit-attempt` 를 읽었는데, 그 헤더는 retry/DLQ republish 시에만 셋되므로 *메인 토픽 메시지는 영원히 attempt=0* → `attempt < inFlight` 항상 true → throw → kafkajs 재consume → 무한 루프, escalate 분기 unreachable.

수정: `packages/observability/src/retry-policy.ts` 에 모듈 레벨 `inflightCount: Map<string,number>` 추가. key = `<worker>:<topic>:<partition>:<offset>`. 핸들러 throw 시마다 in-memory bump → 임계 도달 시 escalate. 성공 / escalate 시 cleanup. 프로세스 재시작 시 카운터 리셋 — 의식적 trade-off (재시작은 transient 신호로 간주).

검증: `SCENARIOS=C pnpm reliability:chaos` 가 SNS 죽이고 → DlqEvent 행 자동 생성까지 ~50초 내 완료.

---

## 11. AWS 배포 전환 체크리스트

- `AWS_ENDPOINT_URL`을 **제거** → SDK가 실제 AWS에 연결
- `DATABASE_URL` → RDS (PostgreSQL 16)
- `REDIS_URL` → ElastiCache
- `KAFKA_BROKERS` → MSK bootstrap brokers
- `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` → Secrets Manager `orbit/jwt`에서 런타임 로드
- **`KEYCLOAK_*`** → 자체 운영 Keycloak 또는 Red Hat SSO. 운영 시 `--import-realm` 부팅 옵션 제거 (운영 중 시드 데이터로 덮이는 사고 방지). `KEYCLOAK_ADMIN/_PASSWORD` 는 첫 부팅 후 즉시 콘솔에서 교체. 시드된 5개 운영자 계정은 운영 환경에서 모두 비활성화 또는 비밀번호 재설정.
- ECS / EKS 서비스 배치:
  - `api` — desiredCount≥2 (stateless, ALB 뒤)
  - `realtime` — desiredCount≥2 (sticky 세션 또는 Redis adapter; stateless)
  - `matcher` — **마켓 샤드 단위로 1 replica** (in-memory book의 단일 owner). 샤딩은 consumer group 분리 + Kafka 파티션 키(symbol) 로 처리
  - `workers` — desiredCount≥2 (컨슈머 그룹 리밸런스)
  - `keycloak` — desiredCount≥2 (cluster 모드, 별도 RDS DB)
- Web — `pnpm --filter @orbit/web build` → `dist/`를 `s3://orbit-web-assets` 에 동기화 → CloudFront 무효화
- **Admin** — `pnpm --filter @orbit/admin build` → `s3://orbit-admin-assets` 에 동기화. CloudFront 또는 별도 ALB 뒤에 배치하고 **WAF / IP allowlist 적용** (운영자 IP 만 허용). Keycloak `orbit-admin-web` client 의 redirect URI 를 운영 도메인으로 갱신.

### 관측 (LGTM 스택) 운영 전환

- **Grafana** — Grafana Cloud (managed) 또는 자체 운영. 자체 운영 시 RDS Postgres 백엔드 + ALB 뒤에 배치. anonymous Admin 비활성화 + Keycloak OIDC 연동.
- **Prometheus** — AMP (Amazon Managed Prometheus) 권장 — agent mode 로 각 서비스가 remote-write. `prometheus.yml` 의 `static_configs` 는 ECS service discovery 로 교체. `external_labels: { cluster, env }` 로 환경 분리.
- **Loki** — Grafana Cloud Loki 또는 자체 운영. 자체 운영 시 chunks/index 모두 **S3 백엔드** (`storage_config.aws.s3`). 7d hot + glacier 아카이브 권장.
- **Tempo** — Grafana Cloud Tempo 또는 자체 운영. 자체 운영 시 traces 도 **S3 백엔드**. `metrics_generator` remote-write 대상은 AMP.
- **OTel sampling** — `OTEL_TRACES_SAMPLER_ARG=0.01` (1%) 권장. 핫 path 는 head sampling, 에러는 tail sampling 으로 보존하려면 OTel Collector 도입 검토.
- **로그 수집 경로** — pino-loki transport (현재 dev 방식) 대신 **promtail / Grafana Alloy** 사이드카로 전환 권장. ECS task definition 에 alloy 컨테이너 추가 + awslogs driver 의 stdout 을 tailing.
- **카디널리티 한계** — `orbit_*_total{userId, ...}` 같은 high-cardinality 라벨 절대 금지. 메트릭 정의 시 prom-client 의 `labelNames` 를 의도적으로 좁게 잡았습니다.

---

## 주의 (학습용 범위)

- 실제 화폐 입출금, KYC, 콜드월렛, 인출 보안은 구현 범위 밖. 어드민 콘솔도 그에 맞춰 입출금 / KYC / 출금 4-eyes 워크플로우는 미구현 (입출금 도메인 도입 시 role 추가만으로 확장 가능).
- 매칭엔진은 `apps/matcher` 안에서 단일 프로세스 단일 스레드. 마켓 수평 분산은 프로세스 샤딩(consumer group + 파티션 키)으로만 가능. 향후 Phase 2(Go) / Phase 3(Rust) 이식 시 같은 Kafka 토폴로지 위에서 교체될 수 있도록 명령 스키마(`OrderCommand`)를 `packages/shared` 에 분리해 두었습니다.
- STP(Self-Trade Prevention)는 매칭엔진이 옵션으로 지원하지만 현재 API 레이어에서 노출하지 않음.
- WebSocket 인증은 현재 미적용 (Phase 1 범위 밖). 토큰 검증 미들웨어는 차기 작업으로 분리.
- 어드민 2FA / TOTP / WebAuthn 은 Keycloak 이 지원하지만 현재 realm 설정에서 미강제. 운영 진입 시 Realm settings → Authentication → Required actions 에서 `Configure OTP` 활성화 필요.
