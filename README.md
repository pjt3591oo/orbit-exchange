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
  shared/     공용 DTO / 이벤트 스키마 / Kafka topic·Redis key 상수
infra/
  localstack/bootstrap.sh        S3 / SNS / SQS / Kafka 토픽 시드
  keycloak/realm-export.json     orbit realm + 4 role / 5 group / 5 시드 운영자
  postgres/init.sh               keycloak DB 자동 생성 (postgres 첫 부팅 시)
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
3. `infra:up` — Docker 컨테이너 5개 기동 (postgres / redis / redpanda / localstack / **keycloak**)
4. `infra:wait` — 전 컨테이너 `healthy` 될 때까지 대기 (Keycloak realm import 가 가장 오래 걸림 — ~60s)
5. `infra:bootstrap` — LocalStack에 S3 버킷, SNS 토픽, SQS 큐, Kafka 토픽 생성
6. `db:migrate` — Prisma 마이그레이션 (User · Wallet · Market · Order · Trade · Candle · **AdminAuditLog**)
7. `db:seed` — 자산/마켓 + 데모 계정 2개(alice, bob) 시드. 어드민 계정 5명은 Keycloak 의 `infra/keycloak/realm-export.json` 으로 자동 시드 (자세한 내용은 §6).

> 처음 받는 Docker 이미지가 ~500MB 이므로 첫 실행은 수 분 걸릴 수 있습니다 (Keycloak 이미지 ~600MB 추가).

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
| **어드민 콘솔 (Vite)** | http://localhost:5174 |
| API (HTTP) | http://localhost:3000/api/v1/health |
| Realtime (WS + health) | http://localhost:3001/health |
| Redpanda Console (Kafka UI) | http://localhost:8080 |
| **Keycloak 콘솔** (admin/admin) | http://localhost:8081 |
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

## 4. 관측 (Kafka / Redis / S3 / SNS)

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

## 5. 주문 트래픽 생성기 (부하 테스트)

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

## 6. 어드민 콘솔 (운영자용)

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

## 7. 자주 쓰는 커맨드

| 작업 | 커맨드 |
|---|---|
| 인프라만 내리기 | `pnpm infra:down` |
| 인프라 + 볼륨까지 초기화 | `pnpm infra:reset` |
| 로그 따라보기 | `pnpm infra:logs` |
| DB 스키마 초기화 + 재시드 | `pnpm db:reset && pnpm db:seed` |
| Keycloak realm 만 재import | `docker exec orbit-postgres psql -U orbit -d orbit -c "DROP DATABASE keycloak WITH (FORCE); CREATE DATABASE keycloak;" && docker restart orbit-keycloak` |
| 주문 트래픽 생성 (부하 테스트) | `pnpm orders:gen` (위 §5 참조) |
| 전체 빌드 (CI/배포용) | `pnpm build` |
| shared 재빌드만 | `pnpm shared:build` |

---

## 8. 문제 해결

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

---

## 9. AWS 배포 전환 체크리스트

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

---

## 주의 (학습용 범위)

- 실제 화폐 입출금, KYC, 콜드월렛, 인출 보안은 구현 범위 밖. 어드민 콘솔도 그에 맞춰 입출금 / KYC / 출금 4-eyes 워크플로우는 미구현 (입출금 도메인 도입 시 role 추가만으로 확장 가능).
- 매칭엔진은 `apps/matcher` 안에서 단일 프로세스 단일 스레드. 마켓 수평 분산은 프로세스 샤딩(consumer group + 파티션 키)으로만 가능. 향후 Phase 2(Go) / Phase 3(Rust) 이식 시 같은 Kafka 토폴로지 위에서 교체될 수 있도록 명령 스키마(`OrderCommand`)를 `packages/shared` 에 분리해 두었습니다.
- STP(Self-Trade Prevention)는 매칭엔진이 옵션으로 지원하지만 현재 API 레이어에서 노출하지 않음.
- WebSocket 인증은 현재 미적용 (Phase 1 범위 밖). 토큰 검증 미들웨어는 차기 작업으로 분리.
- 어드민 2FA / TOTP / WebAuthn 은 Keycloak 이 지원하지만 현재 realm 설정에서 미강제. 운영 진입 시 Realm settings → Authentication → Required actions 에서 `Configure OTP` 활성화 필요.
