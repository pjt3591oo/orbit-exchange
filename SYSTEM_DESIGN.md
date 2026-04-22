# ORBIT Exchange — 시스템 설계

## 1. 목표와 범위

- 프로덕션 지향 설계로 출발하되, 단일 프로세스로도 로컬 실행 가능한 MVP를 함께 제공한다.
- 거래 기능: Spot **지정가(Limit)** / **시장가(Market)** 주문, 실시간 호가창/체결 (WebSocket), 캔들 차트(TradingView Lightweight Charts).
- 매칭엔진은 자체 패키지 [`orderbook-match-engine`](https://www.npmjs.com/package/orderbook-match-engine) v2를 그대로 사용 (in-process, 마켓별 1개 인스턴스).

## 2. 상위 아키텍처

```
┌───────────────────────────────────────────────────────────────────────────┐
│                          Browser (React + Vite)                            │
│   Login / Markets / Trade(Chart+Orderbook+Form) / Account                  │
└────────────┬──────────────────────────────────────────────────────┬───────┘
             │ REST(JSON)                                           │ WS
             ▼                                                      ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                    apps/api — NestJS (HTTP + WS gateway)                   │
│  AuthModule · UserModule · WalletModule · MarketModule ·                   │
│  OrderModule · TradeModule · MarketDataGateway (Socket.IO)                 │
│  · MatchingEngineService (Map<symbol, Engine>, orderbook-match-engine@2)   │
│  · KafkaProducerService                                                    │
└───────────┬──────────────────────┬──────────────────────┬──────────────────┘
            │ SQL                   │ cache/pubsub         │ produce
            ▼                      ▼                       ▼
    ┌──────────────┐       ┌──────────────┐       ┌──────────────────────┐
    │  PostgreSQL  │       │    Redis     │       │  Kafka (Redpanda)    │
    │  users/wallets       │ WS fanout    │       │  topics:             │
    │  orders/trades       │ rate-limit   │       │   orbit.trades.v1    │
    │  candles/assets│     │ caches       │       │   orbit.orders.v1    │
    └──────────────┘       └──────────────┘       │   orbit.orderbook.v1 │
                                                  └────────┬─────────────┘
                                                           │ consume
            ┌──────────────────────────────────────────────┼──────────────┐
            ▼                   ▼                          ▼              ▼
  ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐ ┌──────────────┐
  │ candle-aggregator│ │ market-data-fanout│ │ notification     │ │ audit-logger │
  │ (OHLCV → PG)     │ │ (→ WS, 수평확장) │ │ (→ AWS SNS)       │ │ (→ S3)       │
  └──────────────────┘ └──────────────────┘ └──────────────────┘ └──────────────┘
```

### 핵심 원칙

- **단일 스레드 매칭**: 마켓(symbol)별 in-memory 매칭엔진을 단일 프로세스에서 돌린다. 주문 제출은 마켓별 비동기 큐(serialized)로 직렬화하여 race를 원천 차단.
- **잔고 → 주문 → 체결 → 원장 트랜잭션은 하나의 DB 트랜잭션**으로 묶는다. 엔진의 `before*/after*Hook`에 Prisma `$transaction`을 연결.
- **서비스-리포지토리 분리**: 외부 I/O(`Prisma`, `Redis`)는 리포지토리 계층에 둔다. 엔진은 `DataSourceHook` 구현만 주입받는다.
- **실시간 브로드캐스트는 엔진 `events`에서 파생**: `trade`, `orderAdded`, `orderCancelled` 이벤트를 Gateway에서 room-level emit.
- **수량/가격은 문자열 → Decimal**: `@aficion360/decimal`(엔진 의존성) 또는 DB `Numeric(28, 12)`로 부동소수점 오차 제거.

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

```
POST /api/orders
 ├─ DTO validation (class-validator)
 ├─ MarketRules.validate(tickSize, stepSize, minNotional)
 ├─ MarketQueue[symbol].push(task)      // p-queue concurrency=1
 │     └─ prisma.$transaction(async tx => {
 │           1) lock wallet rows (SELECT ... FOR UPDATE)
 │           2) 잠금(locked++) + Order row 생성 (id 발급)
 │           3) engine.add(orderId, side, price, qty, {stp: 'CANCEL_TAKER'})
 │              · beforeAddHook: 이미 2)에서 끝난 검증 통과 시 true
 │              · afterAddHook: trades[] 순회하며 원장/잔고/Order.leaveQty 업데이트
 │           4) return {order, trades}
 │        })
 ├─ Gateway.broadcast('orderbook:SYMBOL', snapshot)
 ├─ Gateway.broadcast('trades:SYMBOL',  trades)
 └─ Response(201)
```

- 마켓 큐가 단일 write path라서 잔고/주문/체결의 순서가 매칭 엔진 내부 순서와 정확히 일치한다.
- 서버 재시작 시엔 `OPEN/PARTIAL` 주문을 DB에서 읽어 가격-시간 우선순위대로 `engine.add`로 replay → 엔진 상태 복원.

## 5. WebSocket 프로토콜 (Socket.IO)

- 네임스페이스: `/market`
- 클라이언트 구독: `socket.emit('subscribe', { channels: ['orderbook:BTC-KRW', 'trades:BTC-KRW', 'candles:BTC-KRW:M1'] })`
- 서버 이벤트:
  - `orderbook` — `{ symbol, asks:[[price,qty]...], bids:[[price,qty]...], ts }` (스냅샷/델타 — MVP는 스냅샷 limit=15)
  - `trade` — `{ symbol, id, price, qty, side, ts }`
  - `candle` — `{ symbol, interval, openTime, o, h, l, c, v }`
  - `order` (사용자 개인 채널, JWT 인증 후) — `{ status, leaveQty, ... }`

## 6. 캔들 집계

- `CandleService`가 엔진의 `trade` 이벤트를 구독 → 현재 진행 중인 버킷에 누적 → `setInterval`로 마감 시 persist.
- 초기 구현은 1m만. 그 위 interval(5m/15m/1h/4h/1d)은 `TimescaleDB continuous aggregate` 또는 백필 쿼리로 파생. MVP는 1m 저장 + 상위 간격은 on-the-fly 쿼리.

## 7. 인증/보안

- JWT Access(15min) + Refresh(7d, httpOnly cookie).
- `Argon2id` 해시, 로그인 실패 `Redis` 카운터, 주문 API `RateLimitGuard`(10 req/s/user).
- CORS: web origin만 허용. CSP/Helmet. CSRF는 API가 Bearer 토큰만 받으므로 완화 가능.
- 감사 로그(`audit_logs`): 로그인/주문 접수/취소/입출금-모사 이벤트.

## 8. 관측성 / 배포

### 로컬 개발 (LocalStack 기반)

- `docker-compose.yml`에 **Postgres + Redis + LocalStack**을 띄운다. LocalStack으로 AWS 의존(S3, Secrets Manager, SQS)을 로컬 에뮬레이트해 코드는 **AWS SDK만 사용**하도록 작성 → 운영 환경과 동일.
- API는 환경변수로 엔드포인트를 스왑한다:
  - `AWS_ENDPOINT_URL=http://localhost:4566` (LocalStack) ↔ 미지정(실제 AWS).
  - DB/Redis는 LocalStack이 프리티어에서 제한적이라 **직접 컨테이너**(postgres:16, redis:7)로 띄우고 RDS/ElastiCache만 실제 AWS에서 사용.
- 시드: `awslocal` CLI로 S3 bucket, Secrets Manager 시크릿, SQS queue 생성(`infra/localstack/bootstrap.sh`).

### AWS 배포 타겟 (프로덕션)

```
Route53 ─► CloudFront ─► S3 (web 정적 자산)
                │
                └─► ALB ─► ECS Fargate Service(API, 단일 task/market shard)
                          │   ├─ RDS for PostgreSQL (Multi-AZ)
                          │   ├─ ElastiCache for Redis (cluster mode)
                          │   ├─ Secrets Manager (JWT, DB 패스워드)
                          │   ├─ CloudWatch Logs/Metrics
                          │   └─ S3 (감사로그/백업)
```

- **매칭엔진 특성상 ECS 서비스는 desiredCount=1** (마켓 샤드를 늘리려면 symbol별 별도 서비스). 장애 시 ECS가 태스크를 재시작하고 booting 중 `OPEN` 주문을 DB에서 replay.
- WebSocket: ALB 대신 **CloudFront + ALB (sticky, WebSocket listener)** 또는 **API Gateway WebSocket + Lambda**. MVP는 ALB Sticky로 단순화.
- CI/CD: GitHub Actions → ECR push → `aws ecs update-service`. Web은 `s3 sync && cloudfront create-invalidation`.
- IaC: `infra/terraform/`(또는 CDK). MVP는 `docker-compose + LocalStack` 우선, IaC는 skeleton만 제공.

### 관측성

- Logger: `pino` JSON, 요청 `x-request-id`. 프로덕션은 CloudWatch Logs로 전송.
- Metrics: `/metrics` Prometheus (주문 처리 지연, 매칭 이벤트 카운트, 체결량) + CloudWatch Custom Metric 연동.
- Tracing: OpenTelemetry → AWS X-Ray (선택).

### 확장 지점

- 매칭엔진은 **단일 프로세스 유지** — 외부 스케일은 read replica + WS fanout 계층.
- 쓰기 경로가 병목이면 마켓을 샤드(프로세스)별로 분리. API는 `matching-router`만 남음.

## 9. 이벤트 스트리밍 — 대용량 처리 전략

### 토픽 설계

| 토픽 | 파티션 키 | 메시지 | Retention | 소비자 |
|---|---|---|---|---|
| `orbit.trades.v1` | `market` | `{id, seq, market, price, qty, maker*, taker*, ts}` | 7d | candle-aggregator, audit-logger, market-data-fanout |
| `orbit.orders.v1` | `market` | `{orderId, userId, market, side, type, price, qty, status, ts}` | 7d | notification, audit-logger |
| `orbit.orderbook.v1` | `market` | `{market, seq, asks[], bids[], ts}` (snapshot/delta) | 1d (log.compact) | market-data-fanout |
| `orbit.user-events.v1` | `userId` | `{userId, type: 'ORDER_FILLED'|'ORDER_CANCELED', payload}` | 14d | notification |

- 파티션 키 = `market` → 같은 마켓 이벤트는 순서 보존. `user-events`는 `userId`로 해시하여 동일 유저 알림 순서 보존.
- `log.compact` 정책을 `orderbook` 토픽에 써서 마지막 스냅샷만 유지 → 신규 컨슈머 초기 동기화에 활용.

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

### Producer (apps/api)

- 매칭엔진 이벤트(`trade`, `orderAdded`, `orderCancelled`)를 구독하여 `KafkaProducerService.send()`로 publish.
- **트랜잭션 원장 커밋 이후에만** Kafka에 publish (Outbox 패턴 간이 버전: DB INSERT의 `ON COMMIT` 훅이나 단일 `$transaction` 내 후처리로 `at-least-once` 보장). 실패 시 DLQ(local) / SQS(prod).
- Acks: `all`, idempotent producer 활성. compression `zstd`.

### Consumers (apps/workers)

- **candle-aggregator**: `orbit.trades.v1` 구독 → M1 버킷 인메모리 집계 → 1초마다 upsert. M5/M15/H1/H4/D1는 materialized view 또는 별도 집계 잡.
- **market-data-fanout**: `orbit.trades.v1` + `orbit.orderbook.v1` 구독 → Redis Pub/Sub fan-out → 모든 API 인스턴스의 Socket.IO가 브라우저에 브로드캐스트. API를 수평 확장해도 이벤트가 누락되지 않음.
- **notification-worker**: `orbit.user-events.v1` 구독 → **AWS SNS** topic `orbit-user-events`로 publish (email/SMS/mobile push subscriber가 구독). 개인화된 알림은 SNS `MessageAttributes.userId`로 필터.
- **audit-logger**: 모든 v1 토픽 구독 → 5분 단위로 S3 `orbit-audit-logs/yyyy/MM/dd/` 경로에 parquet 저장(MVP는 JSONL). 컴플라이언스 및 포렌식.

### 백프레셔 / 재시도 / 정합성

- Consumer group 내 각 파티션을 단일 워커가 처리 → 순서 보존. 재시도 정책은 `exponential backoff` + `max 5` 후 DLQ(`orbit.dlq.v1`).
- Producer idempotence + consumer at-least-once → **멱등 처리 필수**. Candle upsert는 `(market, interval, openTime)` UNIQUE. Trade 적재는 `tradeId` PK로 중복 차단.
- LocalStack에서 SNS를 에뮬레이트하므로 **모든 경로를 로컬에서 end-to-end 테스트 가능**.

### 프로덕션 토폴로지

```
API ──► MSK (Kafka) ──► ECS Service: workers/*
                          ├─ candle-aggregator  → RDS
                          ├─ market-data-fanout → ElastiCache(Redis Pub/Sub) → API instances (WS)
                          ├─ notification       → SNS → SQS/email/SMS/Mobile
                          └─ audit-logger       → S3 (Glacier 아카이브)
```

## 10. 디렉토리 구조 (pnpm workspace)

```
my-crypto-currency-exchange/
├── apps/
│   ├── api/                  # NestJS: HTTP + WS + 매칭엔진 + Kafka producer
│   ├── workers/              # NestJS: 모든 Kafka 컨슈머 (모듈별 분리)
│   │   ├── candle-aggregator
│   │   ├── market-data-fanout
│   │   ├── notification      # → SNS
│   │   └── audit-logger      # → S3
│   └── web/                  # Vite + React + TypeScript
├── packages/
│   └── shared/               # 공용 타입 (DTO, Kafka event schemas, constants)
├── infra/
│   └── localstack/bootstrap.sh   # LocalStack S3/SNS/SQS/Secrets 시드
├── docker-compose.yml        # postgres + redis + redpanda + localstack
├── pnpm-workspace.yaml
├── package.json
└── SYSTEM_DESIGN.md
```
