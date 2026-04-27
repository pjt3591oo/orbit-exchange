# ADR-0005 — Worker 프로세스 격리 (Bulkhead)

- **Status**: Proposed
- **Date**: 2026-04-27
- **Deciders**: 본 프로젝트 owner
- **Related**: F-WORK-1

## Context

`apps/workers/src/main.ts:12–30` 은 4개 워커를 **단일 Node 프로세스의 단일 이벤트 루프** 에서 동시 실행한다.

```ts
const tasks: Array<Promise<void>> = [];
if (enabled.includes('candle')) tasks.push(runCandleAggregator());
if (enabled.includes('fanout')) tasks.push(runMarketDataFanout());
if (enabled.includes('notification')) tasks.push(runNotification());
if (enabled.includes('audit')) tasks.push(runAuditLogger());
await Promise.all(tasks);
```

이 4개는 **failure mode / 부하 특성 / SLA 가 모두 다르다**:

| Worker | 부하 특성 | 외부 의존 | 실패 빈도 | 영향 범위 |
|---|---|---|---|---|
| `market-data-fanout` | 빠른 hot path (밀리초) | Redis | 낮음 (Redis 안정) | UI latency |
| `candle-aggregator` | CPU-bound 집계 | Postgres | 낮음 | 차트 정확성 |
| `notification` | 외부 API (SMTP/SNS) — 느림 | SNS | **높음** (외부 의존) | 알림 누락 |
| `audit-logger` | I/O batch (S3) | S3 | 낮음 | 컴플라이언스 |

이 비대칭이 노이지 네이버 문제를 만든다:
- Notification 의 SNS publish 가 5초 hang → 단일 이벤트 루프 점유 → 같은 시점의 fanout 에도 latency 추가
- Notification 의 unhandled rejection → `Promise.all` reject → **프로세스 종료** → 4개 워커 동시 정지
- Candle aggregator 가 큰 batch 처리 중이면 audit logger 의 S3 flush 도 같이 밀림

ADR-0004 의 retry/DLQ 정책이 이 일부를 흡수하지만, **프로세스 자체가 죽는 것** 은 ADR-0004 만으로 막지 못한다. 프로세스 분리가 본질적 해결.

## Decision

### D1. 프로세스 분리 — 같은 이미지, 다른 entrypoint

같은 `apps/workers/` 빌드 산출물을 **워커별로 별도 컨테이너로 띄운다**. env var `WORKERS_ENABLED` 로 분기.

`apps/workers/src/main.ts` 는 이미 그 분기 로직 보유 (`enabled.includes(...)`), 따라서 코드 변경 거의 없음.

**docker-compose.yml** 변경 (예시):

```yaml
worker-fanout:
  build: { context: ., dockerfile: apps/workers/Dockerfile }
  environment:
    WORKERS_ENABLED: fanout
    WORKER_OPS_PORT: 3010
  ports: ["3010:3010"]
  depends_on: [postgres, kafka, redis]

worker-candle:
  build: *worker-build
  environment:
    WORKERS_ENABLED: candle
    WORKER_OPS_PORT: 3011
  ports: ["3011:3011"]

worker-notification:
  build: *worker-build
  environment:
    WORKERS_ENABLED: notification
    WORKER_OPS_PORT: 3012
  ports: ["3012:3012"]

worker-audit:
  build: *worker-build
  environment:
    WORKERS_ENABLED: audit
    WORKER_OPS_PORT: 3013
  ports: ["3013:3013"]

# 추가로 ADR-0002 / 0004 에서 도입되는 워커
worker-outbox:
  build: *worker-build
  environment: { WORKERS_ENABLED: outbox-relay, WORKER_OPS_PORT: 3014 }

worker-retry:
  build: *worker-build
  environment: { WORKERS_ENABLED: retry-30s, WORKER_OPS_PORT: 3015 }

worker-dlq:
  build: *worker-build
  environment: { WORKERS_ENABLED: dlq-monitor, WORKER_OPS_PORT: 3016 }
```

7개 워커 컨테이너. 메모리 footprint 는 NodeJS 단일 프로세스 ~80MB × 7 ≈ 560MB — 학습 환경에서 수용 가능.

### D2. 컨테이너 헬스체크 / 재기동 정책

각 컨테이너에 `restart: unless-stopped` + healthcheck:

```yaml
worker-notification:
  healthcheck:
    test: ["CMD", "wget", "-qO-", "http://localhost:3012/ready"]
    interval: 10s
    timeout: 3s
    retries: 3
    start_period: 30s
```

ADR-0001 의 `/ready` 정의를 재사용. notification 의 `/ready` 는:
- Kafka consumer group join 성공
- Redis ping OK (dedupe 의존)
- (선택) SNS endpoint reachable — 단 외부 의존이라 false 일 때 unhealthy 처리할지는 trade-off

**SNS 가 30분 down 일 때** unhealthy 로 마킹하면 컨테이너가 무한 재기동 루프. 이는 ADR-0004 의 retry/DLQ 가 처리하므로 `/ready` 는 SNS 까지 검사하지 않는다. 의식적 결정.

### D3. 단일 프로세스 모드는 dev / test 전용

개발 편의를 위해 단일 프로세스로 4개 워커 동시 실행하는 옵션은 유지. 단 README 에 명시:

> **개발 환경**: `pnpm dev:workers` 는 단일 프로세스 + `WORKERS_ENABLED=fanout,candle,notification,audit,outbox-relay,retry-30s,dlq-monitor` 로 동작. 프로덕션 / docker-compose 환경에서는 워커별 별도 컨테이너.

이로써 개발자가 hot-reload 시 7개 프로세스 켜는 부담은 없음.

### D4. 헬스 / 메트릭 포트 분리

각 워커는 자기 ops 포트로 `/metrics`, `/health`, `/ready` 노출. Prometheus scrape config 에 7개 target 추가:

`infra/prometheus/prometheus.yml`:

```yaml
- job_name: orbit-workers
  static_configs:
    - targets:
      - "host.docker.internal:3010"  # fanout
      - "host.docker.internal:3011"  # candle
      - "host.docker.internal:3012"  # notification
      - "host.docker.internal:3013"  # audit
      - "host.docker.internal:3014"  # outbox
      - "host.docker.internal:3015"  # retry-30s
      - "host.docker.internal:3016"  # dlq-monitor
```

Grafana 대시보드 `orbit-kafka-workers.json` 도 워커별 분리:

```promql
# 패널: 워커별 처리 rate
sum by (worker) (rate(orbit_worker_messages_processed_total[1m]))

# 패널: 워커별 readiness
up{job="orbit-workers", instance=~".*301[0-6]"}
```

### D5. Resource limits (학습 환경 옵션)

각 컨테이너에 메모리/CPU 제한 (선택):

```yaml
worker-notification:
  deploy:
    resources:
      limits:
        memory: 256M
        cpus: '0.5'
```

학습 환경에서는 필수 아님. 운영 단계에서 *반드시*.

### D6. Graceful shutdown

각 워커는 SIGTERM 수신 시:
1. consumer.stop() — 신규 메시지 안 받음
2. 진행 중 eachMessage 완료 대기 (max 30s)
3. producer.disconnect() — outbox / dlq 발행 마무리
4. process.exit(0)

`apps/workers/src/lib/shutdown.ts` 신규로 공통화. NestJS 가 아닌 plain script 라 직접 처리.

```ts
export function setupGracefulShutdown(disposers: Array<() => Promise<void>>) {
  let shuttingDown = false;
  const handler = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutting down');
    for (const d of disposers) {
      try { await Promise.race([d(), sleep(30_000)]); } catch (e) { log.error({ e }); }
    }
    process.exit(0);
  };
  process.on('SIGTERM', handler);
  process.on('SIGINT', handler);
}
```

## Consequences

### Positive

- F-WORK-1 closed.
- 한 워커의 unhandled exception 이 다른 워커에 영향 없음.
- Notification 의 외부 의존 hang 이 fanout latency 에 안 옮음.
- Worker 별로 *독립적으로 scale* 가능 — fanout 만 2 replica 로 늘리는 등.
- Worker 별 CPU/memory 메트릭이 분리 — 어느 워커가 많이 쓰는지 가시적.

### Negative

- 컨테이너 수 증가 — docker-compose 의 cognitive load. 단 코드 복잡도는 늘지 않음.
- 메모리 footprint ~560MB. 학습 환경에서 수용 가능.
- 로컬 개발은 단일 프로세스로 우회하므로 dev/prod parity 일부 깨짐. 단 이는 docker-compose `pnpm infra:up` 으로 운영 모드 검증 가능.

### Neutral

- ADR-0002, 0004 가 도입하는 신규 워커 (outbox-relay, retry-30s, dlq-monitor) 도 같은 패턴으로 자연스럽게 등록.

## Implementation notes

영향 파일:
- `docker-compose.yml` — 7개 worker 서비스 정의 (또는 docker-compose.workers.yml 분리)
- `apps/workers/Dockerfile` — 신규 (있다면 그대로 활용)
- `apps/workers/src/lib/shutdown.ts` — 신규
- `apps/workers/src/main.ts` — graceful shutdown hook 등록
- `infra/prometheus/prometheus.yml` — scrape target 7개로 확장
- `infra/grafana/dashboards/orbit-kafka-workers.json` — 워커별 패널
- `README.md` §3 (인프라) 섹션에 7개 워커 설명 추가

테스트 케이스:
1. `pnpm infra:up` 후 7개 컨테이너 모두 healthy
2. notification 컨테이너만 kill → 다른 컨테이너 영향 없음 + restart 후 lag 회복
3. SNS down 시뮬레이션 → notification 만 retry/DLQ 동작, 다른 워커 정상
4. `WORKERS_ENABLED` env 없는 컨테이너 시작 시 안내 후 종료

## Alternatives considered

### Alt A. NodeJS worker_threads 로 격리

같은 프로세스 안에서 worker thread 로 4개 분리.

**Rejected**:
- 메모리는 공유 — 한 thread 의 메모리 누수가 전체 영향
- unhandled exception 이 thread 만 죽일 수도, 프로세스를 죽일 수도 (NodeJS 버전/구성 의존)
- thread 간 메시지 전달이 IPC 와 동일하게 직렬화 비용
- 컨테이너 분리만큼 강한 격리 안 됨

### Alt B. PM2 같은 process manager 도입

PM2 로 단일 머신에서 N개 프로세스 관리.

**Rejected**:
- docker-compose 위에 PM2 를 한 번 더 얹는 복잡도
- 컨테이너 자체가 process manager 역할이라 중복

### Alt C. 모노 프로세스 유지 + supervisor 패턴 도입

NestJS 의 module-level 격리 (예: `Promise.all` → 각 worker 를 독립 Promise 로 catch + restart).

**Considered but rejected**:
- unhandled rejection / OOM 같은 케이스는 process 단위 격리 외 방법 없음
- 코드 복잡도만 늘고 강한 격리 보장 안 됨

### Alt D. Kubernetes Deployment 로 가는 게 최종

운영 단계에서는 k8s Deployment 7개 + HPA.

**Path**: 본 ADR 의 docker-compose 패턴을 유지하면 k8s 마이그레이션 시 그대로 변환됨 (워커 1개 = k8s Deployment 1개).

## Follow-ups

- Worker resource limits (운영 단계)
- Worker per-replica scaling (k8s)
- Cross-worker shared state (Redis 등) 의 lock 정책
- Cron-based maintenance worker (idempotency-key cleanup, outbox archive 등) — 별도 ADR
