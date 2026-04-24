# ORBIT Exchange — 시스템 설계

## 1. 목표와 범위

- 프로덕션 지향 설계로 출발하되, `docker compose + pnpm dev` 만으로 로컬 end-to-end 실행 가능한 MVP를 함께 제공한다.
- 거래 기능: Spot **지정가(Limit)** / **시장가(Market)** 주문, 실시간 호가창/체결 (WebSocket), 캔들 차트(TradingView Lightweight Charts).
- 매칭엔진은 자체 패키지 [`orderbook-match-engine`](https://www.npmjs.com/package/orderbook-match-engine) v2를 그대로 사용 (in-process, 마켓별 1개 인스턴스).
- **Phase 1 (현재): 서비스 분리** — HTTP API · 매칭엔진 · WebSocket 게이트웨이 · 백그라운드 워커를 각자의 OS 프로세스로 분리하고 Kafka command/event 토폴로지로 연결한다. 모든 서비스는 TypeScript/NestJS.
- **Phase 2 / 3 (예정)**: matcher 만 Go → Rust 로 점진 이식. 같은 Kafka 토폴로지 위에서 교체되도록 명령 스키마(`OrderCommand`)를 `packages/shared` 에 분리해 둔다.

## 2. 상위 아키텍처

```
┌─────────────────────────────────────── Browser (React + Vite) ─────────────────────────────────┐
│   Login / Markets / Trade(Chart+Orderbook+Form) / Account                                       │
└─────────────────┬─────────────────────────────────────────────────────────────────┬─────────────┘
                  │ REST  /api → :3000                                                │ WS  /socket.io → :3001
                  ▼                                                                   ▼
   ┌────────────────────────────────┐                                ┌────────────────────────────────┐
   │   apps/api  (NestJS, HTTP)     │                                │  apps/realtime (NestJS, WS)    │
   │  Auth · User · Wallet · Market │                                │  /market namespace (Socket.IO) │
   │  Order(submit/cancel) · Trade  │                                │  Redis psubscribe md:*         │
   │  KafkaProducerService          │                                │  initial snapshot ← Redis SET  │
   └─────────┬───────────────┬──────┘                                └────────────▲────────┬──────────┘
             │ SQL            │ Kafka produce                                       │        │
             │                │   orbit.order-commands.v1 [key=symbol]              │        │
             │                ▼                                                     │        │
             │       ┌────────────────────────────────┐  Kafka produce              │        │
             │       │  apps/matcher (NestJS, no HTTP)│  orbit.{trades, orders,     │        │
             │       │  • orderbook-match-engine@2    │       orderbook,            │        │
             │       │    Map<symbol, Orderbook>      │       user-events}.v1       │        │
             │       │  • per-market PQueue (size=1)  │─────────────┬───────────────┘        │
             │       │  • settle in $transaction      │             │                        │
             │       │  • Redis SET ob:snapshot:*     │─────────────┼─── snapshot read ──────┘
             │       │  • boot replay OPEN/PARTIAL    │             │
             │       └─────────┬──────────────────────┘             │
             │                 │ SQL                                │
             ▼                 ▼                                    ▼
       ┌─────────────────────────────┐                    ┌──────────────────────┐
       │       PostgreSQL            │                    │  Kafka (Redpanda)    │
       │  users · wallets            │                    │   orbit.order-commands.v1
       │  orders · trades · candles  │                    │   orbit.trades.v1      │
       │  assets · markets           │                    │   orbit.orders.v1      │
       └─────────────────────────────┘                    │   orbit.orderbook.v1   │
                                                          │   orbit.user-events.v1 │
                                                          │   orbit.dlq.v1         │
                                                          └─────────┬──────────────┘
                                                                    │ consume
              ┌─────────────────────────────────┬─────────────────┴────────────────┬───────────────┐
              ▼                                 ▼                                  ▼               ▼
   ┌──────────────────┐               ┌────────────────────┐         ┌──────────────────┐ ┌──────────────┐
   │ candle-aggregator│               │ market-data-fanout │         │ notification     │ │ audit-logger │
   │ (trades → OHLCV  │               │ (Kafka → Redis     │         │ (→ AWS SNS,      │ │ (→ S3 JSONL  │
   │  → Postgres)     │               │  pub/sub md:*)     │         │  user 알림)      │ │  /yyyy/MM/dd)│
   └──────────────────┘               └────────┬───────────┘         └──────────────────┘ └──────────────┘
                                                │ Redis publish
                                                ▼
                                         (apps/realtime psubscribe → emit)
```

### 핵심 원칙

- **명령/이벤트 분리 (CQRS-lite)**: HTTP 경로는 *명령*만 발행하고, 사용자 응답은 즉시 OPEN 상태로 반환한다. 실제 매칭/정산은 비동기로 matcher가 처리하고, 결과는 WS로 푸시한다. 사용자 입장에서의 동기적 체결 보장은 포기하지 않는다 — 마켓 단위 순서 보존(파티션 키=symbol) + per-market p-queue 로 *논리적 순서*는 단일 스레드와 동일.
- **단일 스레드 매칭**: 마켓(symbol)별 in-memory `Orderbook` 인스턴스를 matcher 프로세스 안에서 돌린다. Kafka 컨슈머가 받은 명령을 마켓별 p-queue(concurrency=1)로 직렬화 → `Orderbook.add` / `Orderbook.cancel` 호출. 같은 마켓의 SUBMIT/CANCEL은 절대 인터리브되지 않는다.
- **책임 분리된 두 트랜잭션**:
  1. `apps/api`: 잔고 lock + Order(OPEN) row 생성 (한 트랜잭션) — 사용자에게 즉시 응답
  2. `apps/matcher`: 정산 — Trade row + 양 측 지갑 update + Order status 갱신 (한 트랜잭션, ReadCommitted, 10s timeout)
  - 두 트랜잭션 사이의 정합성은 Kafka at-least-once + matcher 멱등성(이미 FILLED/CANCELLED 면 no-op)으로 보장.
- **상태의 단일 소유자**: in-memory orderbook은 matcher 프로세스 단 하나가 소유. realtime/api는 이 상태를 절대 직접 만지지 않는다. 외부에 노출되는 형태는 Redis SET (스냅샷, TTL 60s) + Kafka `orbit.orderbook.v1` (이벤트) 둘.
- **부팅 시 replay**: matcher 프로세스가 시작되면 DB의 `OPEN/PARTIAL` LIMIT 주문을 가격-시간 우선순위대로 SELECT 하여 `engine.add`로 in-memory book을 재구성. matcher 재기동만으로 상태 복원 가능.
- **수량/가격은 문자열 → Decimal**: 입력 단계부터 `decimal.js` / DB `Numeric(28, 12)` 로 일관 — 부동소수점 오차 제거.

## 3. 데이터 모델 (Prisma)

```prisma
model User {
  id         String   @id @default(cuid())
  email      String   @unique
  passwordHash String
  createdAt  DateTime @default(now())
  wallets    Wallet[]
  orders     Order[]
}

model Asset {
  symbol   String @id          // "BTC", "KRW", "USDT"
  name     String
  decimals Int                 // display scale
  wallets  Wallet[]
}

model Wallet {
  id        String  @id @default(cuid())
  userId    String
  asset     String
  balance   Decimal @db.Decimal(28, 12)  // 사용 가능 잔고
  locked    Decimal @db.Decimal(28, 12)  // 주문에 의해 잠긴 잔고
  user   User  @relation(fields: [userId], references: [id])
  assetRef Asset @relation(fields: [asset],  references: [symbol])
  @@unique([userId, asset])
}

model Market {
  symbol      String @id             // "BTC-KRW"
  baseAsset   String
  quoteAsset  String
  tickSize    Decimal @db.Decimal(28, 12)
  stepSize    Decimal @db.Decimal(28, 12)
  minNotional Decimal @db.Decimal(28, 12)
  takerFeeBp  Int      // basis points, 10 = 0.10%
  makerFeeBp  Int
  enabled     Boolean  @default(true)
}

model Order {
  id           BigInt   @id @default(autoincrement())  // engine orderId
  userId       String
  market       String
  side         OrderSide
  type         OrderType            // LIMIT | MARKET
  price        Decimal? @db.Decimal(28,12)
  quantity     Decimal  @db.Decimal(28,12)
  leaveQty     Decimal  @db.Decimal(28,12)
  filledQty    Decimal  @db.Decimal(28,12) @default(0)
  status       OrderStatus          // OPEN | PARTIAL | FILLED | CANCELLED | REJECTED
  createdAt    DateTime @default(now())
  trades       Trade[]
  @@index([userId, createdAt])
  @@index([market, status, price])
}

model Trade {
  id            BigInt   @id @default(autoincrement())  // engine tradeId
  sequence      BigInt
  market        String
  price         Decimal  @db.Decimal(28,12)
  quantity      Decimal  @db.Decimal(28,12)
  makerOrderId  BigInt
  takerOrderId  BigInt
  makerSide     OrderSide
  takerSide     OrderSide
  makerUserId   String
  takerUserId   String
  makerFee      Decimal  @db.Decimal(28,12)
  takerFee      Decimal  @db.Decimal(28,12)
  createdAt     DateTime @default(now())
  @@index([market, createdAt])
  @@index([makerOrderId]) @@index([takerOrderId])
}

model Candle {
  id       BigInt  @id @default(autoincrement())
  market   String
  interval CandleInterval   // M1, M5, M15, H1, H4, D1
  openTime DateTime
  open Decimal @db.Decimal(28,12)
  high Decimal @db.Decimal(28,12)
  low  Decimal @db.Decimal(28,12)
  close Decimal @db.Decimal(28,12)
  volume Decimal @db.Decimal(28,12)
  @@unique([market, interval, openTime])
  @@index([market, interval, openTime])
}
```

### 잔고 회계 규칙

| 이벤트 | 매수(BID) | 매도(ASK) |
|---|---|---|
| 주문 접수(LIMIT) | quote `balance -= price*qty`, `locked += price*qty` | base `balance -= qty`, `locked += qty` |
| 체결(taker/maker) | quote `locked -= fillPrice*fillQty`, base `balance += (1-takerFee)*fillQty` | base `locked -= fillQty`, quote `balance += (1-makerFee)*fillPrice*fillQty` |
| 잔여 취소 | 잠긴 금액 언락 | 잠긴 수량 언락 |
| Market 주문 | 가상 상한(quote balance) 내 실행, 남은 수량 자동 취소 | 잔고 ≥ qty 전제로 즉시 매칭 |

## 4. 주문 처리 파이프라인

### 4.1 주문 제출 (SUBMIT)

```
[1] POST /api/v1/orders                                                       apps/api
     ├─ DTO validation (class-validator)
     ├─ MarketRules.validate(tickSize, stepSize, minNotional)
     ├─ prisma.$transaction (한 트랜잭션):
     │     1) lockReservation(tx)
     │        · BID:  quote 자산  balance -= price*qty,  locked += price*qty
     │        · ASK:  base  자산  balance -= qty,        locked += qty
     │     2) Order row 생성 — status=OPEN, leaveQty=quantity (id 자동발급)
     │
     ├─ Kafka publish → orbit.order-commands.v1  [key=market]
     │     payload: { v:1, type:'SUBMIT', orderId, userId, symbol,
     │                side, ordType, price, quantity, ts }
     │     (best-effort; 실패해도 사용자에겐 OPEN 상태로 응답)
     │
     └─ Response 201  →  { id, status:'OPEN', leaveQty, filledQty:0, ... }

[2] Kafka consumer (group=orbit.matcher)                                      apps/matcher
     ├─ MatchingEngineService.run(symbol, async () => {        // p-queue, concurrency=1
     │     SettlerService.settleSubmit(cmd):
     │       · order = SELECT * FROM Order WHERE id=cmd.orderId
     │       · if order.status ∈ {FILLED, CANCELLED}: return  // 멱등 short-circuit
     │       · prisma.$transaction (ReadCommitted, timeout=10s):
     │           - LIMIT:  res = book.add(orderId, side, price, leaveQty)
     │           - MARKET: 가용 호가 sweep (level별 add+cancel residual)
     │           - settleTrades(res.trades):
     │               · Trade row 생성
     │               · 메이커/테이커 양 측 wallet locked / balance 갱신
     │                 (가격이 더 좋은 매칭 시 reserved-quote 차액은 BID 메이커에게 환불)
     │               · 두 Order의 filledQty / leaveQty / status (PARTIAL|FILLED) 갱신
     │   })
     │
     ├─ Kafka publish → orbit.orders.v1  (ORDER_ADDED)
     │                  orbit.trades.v1  (TRADE × n)
     │                  orbit.user-events.v1  (ORDER_FILLED — maker, taker 각각 1건)
     │                  orbit.orderbook.v1  (ORDERBOOK_SNAPSHOT, seq 증가)
     └─ Redis SET ob:snapshot:<symbol>  (TTL 60s, throttle 100ms per symbol)

[3] apps/workers (market-data-fanout)
     └─ Kafka orbit.{trades,orderbook}.v1 → Redis publish md:<symbol>:{trade,orderbook}

[4] apps/realtime
     ├─ subscribe 시점: Redis GET ob:snapshot:<symbol> → client emit('orderbook')
     └─ md:* psubscribe → 룸별(`md:<symbol>:<kind>`) emit
```

### 4.2 주문 취소 (CANCEL — 멱등 명령)

```
DELETE /api/v1/orders/:id                                                     apps/api
  ├─ 소유자 검증 + status ∉ {FILLED, CANCELLED} 확인
  ├─ Kafka publish → orbit.order-commands.v1
  │     payload: { v:1, type:'CANCEL', orderId, userId, symbol, ts }
  └─ Response 200  ← 현재 DB 상태 그대로 반환 (실제 CANCEL 반영은 WS로)

apps/matcher:                                                                 (group=orbit.matcher)
  └─ run(symbol, async () => settleCancel(cmd))
       · order = SELECT *; status ∈ {FILLED, CANCELLED} → no-op (idempotent)
       · prisma.$transaction:
           - book.cancel(orderId)             // 이미 빠졌으면 silent skip
           - leaveQty 만큼 reserved 자산 환불 (BID: quote, ASK: base)
           - status=CANCELLED
       · Kafka publish → orbit.orders.v1 (ORDER_CANCELLED), user-events
       · Redis snapshot 업데이트
```

- API는 DB write를 하지 않는다 → 같은 cancel 명령이 두 번 도착해도 matcher의 status check 한 곳에서만 막으면 충분.
- 부분체결 후 취소(PARTIAL → CANCELLED)도 동일 경로. 환불은 `leaveQty` 기준.

### 4.3 부팅 시 replay (matcher 단독 책임)

- matcher 프로세스 `onModuleInit`에서:
  ```
  enabled markets 로 빈 Orderbook 인스턴스 생성
  → SELECT * FROM Order WHERE status IN ('OPEN','PARTIAL') AND type='LIMIT' ORDER BY id
  → 각 주문에 대해 book.add(id, side, price, leaveQty)
  → 이후 Kafka 컨슈머 시작
  ```
- replay 도중 새 명령은 partition assignment 가 끝난 뒤에야 들어오므로 race 없음.
- 매처 재기동 만으로 in-memory book = DB persisted state 가 일치 (단일 진실원: DB).

## 5. WebSocket 프로토콜 (Socket.IO)

WS 게이트웨이는 **`apps/realtime` 단독 책임**. api 프로세스에는 WS 코드가 없다.

- 진입점: `ws://<host>:3001/socket.io` (개발: vite proxy `/socket.io → ws://localhost:3001`)
- 네임스페이스: `/market` (시장 데이터). 사용자 개인 채널은 `/user` 네임스페이스로 분리 예정 (Phase 1+).
- 클라이언트 구독: `socket.emit('subscribe', { symbol: 'BTC-KRW', kind: 'orderbook' })`
  - kind ∈ `{ 'orderbook' | 'trade' }` — 룸 키는 `md:<symbol>:<kind>`
- 서버 이벤트:
  - `orderbook` — `{ symbol, asks:[{price,qty},...], bids:[...], ts }`
    - 구독 직후 1회: realtime 이 `Redis GET ob:snapshot:<symbol>` 으로 즉시 emit (late joiner 동기화)
    - 이후: market-data-fanout 워커가 publish 한 `md:<symbol>:orderbook` 을 그대로 emit
  - `trade` — `{ id, market, price, quantity, makerSide, takerSide, ts, ... }`
  - `candle` (예정) — `{ symbol, interval, openTime, o, h, l, c, v }`
  - `order` (예정, 사용자 개인 채널 + JWT 인증 후) — `{ status, leaveQty, ... }` (Phase 1 범위 밖)

### 왜 두 채널 (Redis pub/sub vs Redis SET) 인가

| 채널 | 용도 | 특성 |
|---|---|---|
| Redis pub/sub `md:*` | 라이브 델타 스트림 | fire-and-forget, late joiner 받지 못함 |
| Redis SET `ob:snapshot:*` | 신규 구독자의 최초 1회 스냅샷 | matcher 가 throttle 100ms/symbol 로 write, TTL 60s |

→ pub/sub 단독으로는 *지금 막 접속한 사용자*가 빈 호가창을 보게 됨. SET 단독으로는 throttle 때문에 라이브가 끊김. 두 채널이 보완 관계.

## 6. 캔들 집계

- `apps/workers/candle-aggregator` 가 `orbit.trades.v1` (group=`orbit.candle-aggregator`) 를 구독 → 현재 진행 중인 버킷에 인메모리 누적 → 1초마다 `(market, interval, openTime)` UNIQUE upsert.
- 초기 구현은 1m만. 그 위 interval(5m/15m/1h/4h/1d)은 `TimescaleDB continuous aggregate` 또는 백필 쿼리로 파생. MVP는 1m 저장 + 상위 간격은 on-the-fly 쿼리.
- 컨슈머 그룹이 matcher 와 분리되므로 캔들 집계 지연/재시작이 매칭에 영향 없음.

## 7. 인증/보안

- JWT Access(15min) + Refresh(7d, httpOnly cookie).
- `Argon2id` 해시, 로그인 실패 `Redis` 카운터, 주문 API `RateLimitGuard`(10 req/s/user).
- CORS: web origin만 허용. CSP/Helmet. CSRF는 API가 Bearer 토큰만 받으므로 완화 가능.
- 감사 로그(`audit_logs`): 로그인/주문 접수/취소/입출금-모사 이벤트.

## 8. 관측성 / 배포

### 로컬 개발 (LocalStack 기반)

- `docker-compose.yml`에 **Postgres + Redis + Redpanda + LocalStack**을 띄운다. LocalStack으로 AWS 의존(S3, Secrets Manager, SQS, SNS)을 로컬 에뮬레이트해 코드는 **AWS SDK만 사용**하도록 작성 → 운영 환경과 동일.
- 모든 NestJS 서비스(api / matcher / realtime / workers)는 환경변수로 엔드포인트를 스왑한다:
  - `AWS_ENDPOINT_URL=http://localhost:4566` (LocalStack) ↔ 미지정(실제 AWS).
  - `KAFKA_BROKERS=localhost:9092` (Redpanda) ↔ MSK bootstrap brokers.
  - DB/Redis 는 LocalStack 프리티어에서 제한적이라 직접 컨테이너(postgres:16, redis:7) 로 띄우고 RDS/ElastiCache 만 실제 AWS 에서 사용.
- 시드: `awslocal`/`aws --endpoint-url`로 S3 bucket, Secrets Manager 시크릿, SQS queue, **Kafka 토픽** 생성 (`infra/localstack/bootstrap.sh`).

### AWS 배포 타겟 (프로덕션)

```
Route53 ─► CloudFront ─► S3 (web 정적 자산)
                │
                ├─► ALB(http) ─► ECS Service: api          (Fargate, ≥2 task, stateless)
                │                     │
                │                     ├── RDS PostgreSQL (Multi-AZ)
                │                     ├── ElastiCache Redis (cluster mode)
                │                     ├── Secrets Manager (orbit/jwt 등)
                │                     └── MSK (Kafka)         ◄─── produce orbit.order-commands.v1
                │
                ├─► ALB(ws , sticky) ─► ECS Service: realtime (Fargate, ≥2 task, stateless)
                │                     │
                │                     └── ElastiCache Redis  ◄─── psubscribe md:* / GET ob:snapshot:*
                │
                ├─►            ECS Service: matcher          (Fargate, **샤드 단위 1 task**)
                │                     │
                │                     ├── RDS PostgreSQL  (matcher 만 쓰기 권한)
                │                     ├── ElastiCache Redis (snapshot SET write)
                │                     └── MSK (consume orbit.order-commands.v1, produce events)
                │
                └─►            ECS Service: workers          (Fargate, ≥2 task per worker kind)
                                      │
                                      ├── candle-aggregator   → RDS
                                      ├── market-data-fanout  → ElastiCache (Redis publish)
                                      ├── notification        → SNS
                                      └── audit-logger        → S3 (Glacier 아카이브)
```

| 서비스 | desiredCount | 상태성 | 비고 |
|---|---|---|---|
| `api` | ≥2 (auto scale) | stateless | ALB 라운드로빈, JWT는 Secrets Manager에서 시작 시 1회 로드 |
| `realtime` | ≥2 | stateless | ALB sticky **또는** Socket.IO Redis adapter. ElastiCache 만 있으면 임의 노드 → 임의 노드 push 가능 |
| `matcher` | **마켓 샤드당 1** | in-memory book = stateful | MSK consumer group 분할(`orbit.matcher.shard1` 등) + 토픽 파티션 키=symbol. 같은 symbol은 항상 같은 샤드로. 장애 시 ECS 재기동 → DB replay 로 5–30s 내 회복 |
| `workers/*` | ≥2 per consumer group | stateless | Kafka 컨슈머 그룹 리밸런스로 노드 추가 시 파티션 자동 재분배 |

- WebSocket: ALB 의 WebSocket listener 사용 + sticky. realtime 의 다중화는 sticky 만으로도 충분하지만, sticky 없이도 동작하도록 **모든 fanout을 Redis pub/sub 으로 통일**해 둠 (`md:*`).
- CI/CD: GitHub Actions → 4개 이미지 ECR push → `aws ecs update-service`. Web은 `s3 sync && cloudfront create-invalidation`.
- IaC: `infra/terraform/` (또는 CDK). MVP 는 `docker-compose + LocalStack` 우선, IaC 는 skeleton.

### 관측성

- Logger: `pino` JSON, 요청 `x-request-id`. 모든 서비스 동일. 프로덕션은 CloudWatch Logs로 전송.
- Metrics: `/metrics` Prometheus 노출
  - api: 주문 접수 지연, 잠금 트랜잭션 시간, Kafka publish 지연
  - matcher: 명령 컨슈머 lag, 매칭 사이클 시간, 정산 트랜잭션 시간, in-memory book 깊이
  - realtime: 동시 접속자 수, room 별 publish rate
  - workers: 컨슈머 lag (그룹별), DLQ depth
  - 모두 CloudWatch Custom Metric 으로 연동.
- Tracing: OpenTelemetry → AWS X-Ray. trace context를 Kafka 메시지 헤더로 전파해 api → matcher → workers 까지 한 trace 로 본다.

### 확장 지점

- **매칭엔진은 단일 프로세스 유지** (마켓 샤드 단위). 마켓 추가 시 샤드 추가 → consumer group 분리. 같은 마켓을 두 프로세스가 처리하면 안 됨 → 토픽 파티션과 그룹 매핑이 운영 핵심.
- 읽기 경로(market data, history)가 병목이면 read replica + market-data-fanout 노드 증설.
- Phase 2/3: matcher 만 Go → Rust. 그 외 서비스(api/realtime/workers)는 그대로 둔다. 명령 스키마 (`OrderCommand`) + 이벤트 스키마 (`TradeEvent`, `OrderEvent`, `OrderbookEvent`) 가 와이어 프로토콜이므로 언어 교체에 자연스러움.

## 9. 이벤트 스트리밍 — 대용량 처리 전략

### 토픽 설계

| 토픽 | 파티션 키 | 메시지 | Retention | Producer | Consumer |
|---|---|---|---|---|---|
| `orbit.order-commands.v1` | `market` | `OrderCommand = SUBMIT \| CANCEL` | 7d | **api** | **matcher** (group `orbit.matcher`) |
| `orbit.trades.v1` | `market` | `{id, seq, market, price, qty, maker*, taker*, ts}` | 7d | matcher | candle-aggregator, audit-logger, market-data-fanout |
| `orbit.orders.v1` | `market` | `{orderId, userId, market, side, type, price, qty, status, ts}` | 7d | matcher | notification, audit-logger |
| `orbit.orderbook.v1` | `market` | `{market, seq, asks[], bids[], ts}` (snapshot) | 1d (log.compact) | matcher | market-data-fanout |
| `orbit.user-events.v1` | `userId` | `{userId, type: 'ORDER_FILLED'\|'ORDER_CANCELLED', payload}` | 14d | matcher | notification, audit-logger |
| `orbit.dlq.v1` | originating key | 실패 메시지 + reason | 30d | (각 컨슈머) | 운영자 수동 / 재처리 잡 |

- 파티션 키 = `market` → 같은 마켓 이벤트는 순서 보존. matcher 가 같은 symbol 의 SUBMIT/CANCEL 을 인터리브하지 않는 핵심 근거.
- `user-events`는 `userId` 키로 해시 → 동일 유저 알림 순서 보존.
- `log.compact` 정책을 `orderbook` 토픽에 사용 → 마지막 스냅샷만 유지 → 신규 컨슈머 초기 동기화에 활용 (Phase 1+ 계획).
- 컨슈머 그룹: `orbit.matcher`, `orbit.candle-aggregator`, `orbit.market-data-fanout`, `orbit.notification`, `orbit.audit-logger` (모두 `packages/shared/src/constants.ts` 의 `CONSUMER_GROUPS` 에 정의).

### 왜 Kafka인가 (SNS/SQS 단독 대비)

| 요구 | Kafka | SNS+SQS |
|---|---|---|
| **TPS 수만~수십만 이벤트/s** | ✅ 파티션 병렬 | SQS 단일 큐 throttle |
| **순서 보존(per market)** | ✅ 파티션 단위 | FIFO 큐 300msg/s 제한 |
| **리플레이/백필** | ✅ offset rewind | 불가(메시지 소비되면 삭제) |
| **다수 컨슈머 그룹 독립 소비** | ✅ | ✅ (SNS fan-out) |
| **팬아웃 푸시 알림(email/SMS/Mobile)** | 간접 | ✅ |

→ **Kafka = 거래 이벤트 백본(체결/오더북/유저이벤트), SNS = 사용자 알림 경로**. 두 개를 조합.

로컬은 Kafka wire protocol 호환인 **Redpanda**로 대체(단일 바이너리, JVM·ZK 없음, `docker-compose up` 즉시 가동). 프로덕션은 **AWS MSK** 또는 **MSK Serverless**로 이행 — 드라이버는 `kafkajs`라 코드 변경 없음.

### Producers

| 서비스 | 토픽 | 발행 시점 |
|---|---|---|
| `apps/api` | `orbit.order-commands.v1` | 잔고 lock + Order(OPEN) 트랜잭션 **commit 직후** (best-effort, 실패 시 사용자 응답은 OPEN 으로 정상 — 다음 dev 단계에서 outbox 패턴 추가 예정) |
| `apps/matcher` | `orbit.{trades, orders, orderbook, user-events}.v1` | 정산 트랜잭션 commit 직후 |

- 두 프로듀서 모두 **idempotent + acks=all + GZIP** (현재 설정; 운영에선 `zstd` 권장).
- API 의 best-effort 발행이 실패해도 정합성은 깨지지 않는다 — 사용자 입장에선 `OPEN` 인 채 매칭이 일어나지 않는 *지연* 으로 보일 뿐. 운영에서는 outbox 테이블 + 재발행 잡 (`OrderOutbox.dispatched=false` row scan) 으로 완전 보장 예정.

### Consumers

- **matcher** (`group=orbit.matcher`, partitions per symbol): `orbit.order-commands.v1` 구독 → per-market p-queue → 정산 → 다운스트림 토픽 publish + Redis snapshot SET. **이 컨슈머가 비즈니스 로직의 사실상 단일 write path**.
- **candle-aggregator** (`apps/workers`): `orbit.trades.v1` 구독 → M1 버킷 인메모리 집계 → 1초마다 upsert. M5/M15/H1/H4/D1는 materialized view 또는 별도 집계 잡.
- **market-data-fanout** (`apps/workers`): `orbit.trades.v1` + `orbit.orderbook.v1` 구독 → Redis Pub/Sub `md:<symbol>:{trade,orderbook}` 로 fan-out → 모든 `apps/realtime` 인스턴스의 Socket.IO 가 브라우저에 emit. realtime 을 수평 확장해도 이벤트는 모든 노드에서 동일하게 보임.
- **notification-worker**: `orbit.user-events.v1` 구독 → **AWS SNS** topic `orbit-user-events` 로 publish (email/SMS/mobile push subscriber 가 구독). 개인화된 알림은 SNS `MessageAttributes.userId` 로 필터.
- **audit-logger**: 모든 v1 토픽 구독 → 5분 단위로 S3 `orbit-audit-logs/yyyy/MM/dd/` 경로에 parquet 저장 (MVP 는 JSONL). 컴플라이언스 및 포렌식.

### 백프레셔 / 재시도 / 정합성

- Consumer group 내 각 파티션을 단일 워커가 처리 → 순서 보존. 재시도 정책은 `exponential backoff` + `max 5` 후 DLQ(`orbit.dlq.v1`).
- Producer idempotence + consumer at-least-once → **모든 컨슈머는 멱등이어야 함**:
  - matcher: 같은 SUBMIT 명령이 재배달되어도 Order.status 가 이미 FILLED/CANCELLED 면 no-op. CANCEL 도 동일.
  - candle: `(market, interval, openTime)` UNIQUE 제약으로 upsert.
  - audit-logger: S3 object key 에 `tradeId/orderId` 포함 → 같은 키 덮어쓰기.
- LocalStack 에서 SNS 까지 에뮬레이트되므로 **api → matcher → workers → SNS → SQS 까지 한 머신에서 end-to-end 테스트 가능**.

### 프로덕션 토폴로지

```
api ──► MSK (orbit.order-commands.v1)
          │
          ▼
       matcher  ──► MSK (orbit.{trades,orders,orderbook,user-events}.v1)
          │                                │
          │                                ├─► candle-aggregator   → RDS
          ▼                                ├─► market-data-fanout  → ElastiCache → realtime instances (WS)
   ElastiCache (ob:snapshot:*)             ├─► notification        → SNS → SQS/email/SMS/Mobile
                                           └─► audit-logger        → S3 (Glacier 아카이브)
```

## 10. 디렉토리 구조 (pnpm workspace)

```
my-crypto-currency-exchange/
├── apps/
│   ├── api/                  # NestJS — HTTP only :3000
│   │                         #   Auth · User · Wallet · Market · Order(submit/cancel) · Trade
│   │                         #   KafkaProducer → orbit.order-commands.v1
│   ├── matcher/              # NestJS standalone (HTTP/WS 없음)
│   │                         #   Kafka consumer (group=orbit.matcher)
│   │                         #   in-memory Orderbook (orderbook-match-engine@2)
│   │                         #   per-market PQueue, settle in $transaction
│   │                         #   produces orbit.{trades,orders,orderbook,user-events}.v1
│   │                         #   Redis SET ob:snapshot:* (TTL 60s, throttle 100ms)
│   ├── realtime/             # NestJS — Socket.IO :3001
│   │                         #   /market namespace
│   │                         #   subscribe Redis md:* → emit
│   │                         #   초기 스냅샷은 Redis SET 에서 read
│   ├── workers/              # NestJS — Kafka consumers
│   │   ├── candle-aggregator     # → Postgres
│   │   ├── market-data-fanout    # → Redis publish md:*
│   │   ├── notification          # → SNS
│   │   └── audit-logger          # → S3
│   └── web/                  # Vite + React + TypeScript :5173
│                             #   /api → :3000 proxy, /socket.io → :3001 proxy
├── packages/
│   └── shared/               # 공용 타입·상수
│                             #   OrderCommand (SUBMIT/CANCEL), OrderEvent, TradeEvent,
│                             #   OrderbookEvent, UserEvent, KAFKA_TOPICS, CONSUMER_GROUPS,
│                             #   REDIS_KEYS, ORDERBOOK_SNAPSHOT_TTL_SEC
├── infra/
│   └── localstack/bootstrap.sh   # S3 / SNS / SQS / Secrets / Kafka 토픽 시드
├── docker-compose.yml        # postgres + redis + redpanda + redpanda-console + localstack
├── pnpm-workspace.yaml
├── package.json              # dev:api / dev:matcher / dev:realtime / dev:workers / dev:web
└── SYSTEM_DESIGN.md
```
