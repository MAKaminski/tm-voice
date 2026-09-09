#!/usr/bin/env bash
# Zero-infra local run: embedded Postgres (PGlite), no Redis, every vendor mocked.
# usage: scripts/dev-local.sh api | console
set -euo pipefail
cd "$(dirname "$0")/.."
export NODE_ENV=development
export DATABASE_URL="pglite:$PWD/.data/pglite"
export INTERNAL_API_TOKEN="${INTERNAL_API_TOKEN:-dev-local-token-0123456789abcdef}"
export API_BASE_URL="http://localhost:8787"
export APP_BASE_URL="http://localhost:3000"
export DIAL_MODE=dry_run
export PORT=8787
mkdir -p .data
case "${1:-api}" in
  api)
    pnpm --filter @tm/db migrate
    if [ ! -f .data/seeded ]; then pnpm --filter @tm/db seed && touch .data/seeded; fi
    exec pnpm --filter @tm/api dev ;;
  console)
    exec pnpm --filter @tm/console dev ;;
  *) echo "usage: $0 api|console"; exit 2 ;;
esac
