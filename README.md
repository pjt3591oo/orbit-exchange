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

### 5개 baseline 대시보드 (자동 provisioning)

| UID / 파일 | 무엇 |
|---|---|
| `orbit-overview` | 4 서비스 CPU / Heap / Event-loop p99 + HTTP RPS · 에러율 · submit p50/p95/p99 + WS 연결수 + room emit rate |
| `orbit-pipeline` | 시장별 submit rate (BID/ASK), 결과 분포 (ok/4xx/5xx), trade rate (taker side), 취소 (user vs admin), 시장별 submit p50/p95/p99, frozen 차단 카운터 |
| `orbit-matcher` | 시장별 settle p50/p95/p99, 시장별 p-queue depth, 시장별 책 깊이 (bid/ask level 수), 명령 결과 (ok/noop/error), settle 에러 stat |
| `orbit-kafka` | 토픽별 publish rate / errors / p95 duration, worker 처리량 (worker×topic×result), worker handler p95, 누적 에러 stat |
| **`orbit-service-map`** | Tempo 자동 service map (NodeGraph 패널) + edge별 RPS / latency / 누적 호출수 표 + 서비스별 spanmetrics RED + Top-10 hot path |

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

## 6. 주문 트래픽 생성기 (부하 테스트)

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

## 7. 어드민 콘솔 (운영자용)

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

## 8. 자주 쓰는 커맨드

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

## 9. 문제 해결

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

---

## 10. AWS 배포 전환 체크리스트

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
