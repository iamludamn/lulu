#!/bin/sh
set -eu

port=${1:?e2e port is required}
cd "$(dirname "$0")/../apps/cf"
mkdir -p ../../.e2e
state=$(mktemp -d ../../.e2e/worker-XXXXXX)

wrangler d1 migrations apply LULU_METADATA --local --persist-to "$state"
exec wrangler dev --local --ip 127.0.0.1 --port "$port" --persist-to "$state" --env-file /dev/null \
  --var "MCP_ADMIN_TOKEN:${LULU_E2E_ADMIN_TOKEN:?}" \
  --var MCP_ENCRYPTION_KEY:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= \
  --var OTEL_EXPORTER_OTLP_ENDPOINT:
