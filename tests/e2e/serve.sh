#!/usr/bin/env bash
set -euo pipefail

state=$(mktemp -d "${TMPDIR:-/tmp}/lulu-e2e.XXXXXXXX")
trap 'rm -rf -- "$state"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

touch "$state/empty.env"
wrangler=(node ../../node_modules/wrangler/bin/wrangler.js)
cd apps/cf
"${wrangler[@]}" d1 migrations apply LULU_METADATA --local --persist-to "$state/db" --env-file "$state/empty.env"
"${wrangler[@]}" dev --local --ip 127.0.0.1 --port "$1" --inspector-port 0 \
  --persist-to "$state/db" --env-file "$state/empty.env" \
  --var "MCP_ADMIN_TOKEN:${MCP_ADMIN_TOKEN:?}" \
  --var "MCP_ENCRYPTION_KEY:$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64"))')" \
  --var "OTEL_EXPORTER_OTLP_ENDPOINT:"
