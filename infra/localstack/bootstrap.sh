#!/usr/bin/env bash
# LocalStack bootstrap — creates the AWS resources ORBIT expects at runtime.
# Re-runnable (idempotent).
set -euo pipefail

export AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID:-test}
export AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY:-test}
export AWS_DEFAULT_REGION=${AWS_DEFAULT_REGION:-ap-northeast-2}

ENDPOINT=${AWS_ENDPOINT_URL:-http://localhost:4566}

aws_cmd() { aws --endpoint-url "$ENDPOINT" "$@"; }

echo "[bootstrap] waiting for LocalStack at $ENDPOINT ..."
for i in {1..30}; do
  if curl -fsS "$ENDPOINT/_localstack/health" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

echo "[bootstrap] S3 buckets"
aws_cmd s3api create-bucket \
  --bucket orbit-audit-logs \
  --create-bucket-configuration LocationConstraint="$AWS_DEFAULT_REGION" \
  >/dev/null 2>&1 || true
aws_cmd s3api create-bucket \
  --bucket orbit-web-assets \
  --create-bucket-configuration LocationConstraint="$AWS_DEFAULT_REGION" \
  >/dev/null 2>&1 || true

echo "[bootstrap] Secrets Manager"
aws_cmd secretsmanager create-secret \
  --name orbit/jwt \
  --secret-string '{"access":"dev-access-secret-change-me","refresh":"dev-refresh-secret-change-me"}' \
  >/dev/null 2>&1 || \
aws_cmd secretsmanager put-secret-value \
  --secret-id orbit/jwt \
  --secret-string '{"access":"dev-access-secret-change-me","refresh":"dev-refresh-secret-change-me"}' \
  >/dev/null

echo "[bootstrap] SNS topics"
aws_cmd sns create-topic --name orbit-user-events >/dev/null 2>&1 || true

echo "[bootstrap] SQS — DLQ + subscribe to SNS (demo email channel)"
aws_cmd sqs create-queue --queue-name orbit-dlq >/dev/null 2>&1 || true
aws_cmd sqs create-queue --queue-name orbit-user-events-subscriber >/dev/null 2>&1 || true

SNS_ARN=$(aws_cmd sns list-topics | python3 -c 'import sys,json;print([t["TopicArn"] for t in json.load(sys.stdin)["Topics"] if t["TopicArn"].endswith(":orbit-user-events")][0])')
SQS_ARN="arn:aws:sqs:${AWS_DEFAULT_REGION}:000000000000:orbit-user-events-subscriber"
aws_cmd sns subscribe --topic-arn "$SNS_ARN" --protocol sqs --notification-endpoint "$SQS_ARN" >/dev/null 2>&1 || true

echo "[bootstrap] Kafka topics (Redpanda) — local dev"
rpk_run() {
  if command -v rpk >/dev/null 2>&1; then
    rpk --brokers localhost:9092 "$@"
  elif docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^orbit-redpanda$'; then
    docker exec orbit-redpanda rpk --brokers localhost:9092 "$@"
  else
    return 127
  fi
}
for t in orbit.order-commands.v1 orbit.trades.v1 orbit.orders.v1 orbit.orderbook.v1 orbit.user-events.v1 orbit.dlq.v1; do
  rpk_run topic create "$t" -p 3 -r 1 >/dev/null 2>&1 || true
done

echo "[bootstrap] done."
echo "S3 buckets:"
aws_cmd s3 ls
echo "SNS topics:"
aws_cmd sns list-topics
