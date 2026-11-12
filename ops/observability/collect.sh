set -eu

case "${1:-}" in
  cloudflare|service-accounts) ;;
  *) exit 2 ;;
esac

: "${CREDENTIALS_DIRECTORY:?}"
OP_SERVICE_ACCOUNT_TOKEN=$(cat "$CREDENTIALS_DIRECTORY/op-token")
export OP_SERVICE_ACCOUNT_TOKEN

exec "$HOME/.local/bin/op" run --environment dwa4hq6cqvhqrxt3jywkaadhzy -- env -u OP_SERVICE_ACCOUNT_TOKEN node "ops/observability/$1.mjs"
