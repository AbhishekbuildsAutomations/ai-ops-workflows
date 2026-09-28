#!/usr/bin/env bash
# One command from clone to working demo:
#   starts n8n + Postgres, creates the Postgres and Telegram credentials from .env,
#   imports every workflow in workflows/, and publishes them.
# Safe to re-run: credentials and workflows keep fixed IDs, so a re-run updates them in place.
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env ] || { echo "No .env. Run: cp .env.example .env   then fill it in."; exit 1; }
set -a; . ./.env; set +a
for v in N8N_ENCRYPTION_KEY RUNNERS_AUTH_TOKEN POSTGRES_PASSWORD TELEGRAM_CHAT_ID; do
  case "${!v:-}" in ''|change-me|123456789|*replace-with*) echo "Set $v in .env first."; exit 1 ;; esac
done

docker compose up -d
echo -n "waiting for n8n"
until curl -sf "http://localhost:${N8N_PORT:-5678}/healthz" >/dev/null; do echo -n .; sleep 2; done; echo

# Credentials are built inside the container. The bot token is optional here: if set, it is
# passed to this one process only (-e), never to the n8n container's environment, so $env
# cannot read it. If blank, create the Telegram credential in the n8n UI instead (README).
docker compose exec -T -e TG_TOKEN="${TELEGRAM_BOT_TOKEN:-}" n8n sh -c '
  node -e "
    const fs = require(\"fs\");
    fs.writeFileSync(\"/tmp/creds.json\", JSON.stringify([
      { id: \"aiopsCredPg00001\", name: \"Ops ledger (Postgres)\", type: \"postgres\", data: {
          host: \"postgres\", port: 5432, database: process.env.DB_POSTGRESDB_DATABASE,
          user: process.env.DB_POSTGRESDB_USER, ssl: \"disable\",
          password: fs.readFileSync(\"/run/secrets/postgres_password\", \"utf8\").trim() } },
      ...(process.env.TG_TOKEN ? [{ id: \"aiopsCredTg00001\", name: \"Ops alerts (Telegram bot)\", type: \"telegramApi\", data: {
          accessToken: process.env.TG_TOKEN } }] : [])
    ]));
  " && n8n import:credentials --input=/tmp/creds.json; rc=$?; rm -f /tmp/creds.json; exit $rc'

# The error handler goes first so the others can point at it.
for f in workflows/00-error-handling/workflow-error-handler.json \
         $(find workflows -name '*.json' ! -name 'workflow-error-handler.json' | sort); do
  echo "import $f"
  docker compose exec -T n8n n8n import:workflow --input="/repo/$f"
done

# Publish everything. The n8n docs say an error workflow needs no publish; 2.40 refuses to
# run an unpublished one ("is not active and cannot be executed"). See docs/build-log.md.
for id in aiopsErrHandler0 aiopsTestFail000 aiopsWeeklyDig00; do
  docker compose exec -T n8n n8n publish:workflow --id="$id"
done
docker compose restart n8n   # publish via CLI only takes effect after a restart
until curl -sf "http://localhost:${N8N_PORT:-5678}/healthz" >/dev/null; do sleep 2; done

echo
echo "Ready: http://localhost:${N8N_PORT:-5678}  (first visit asks you to create the owner account)"
[ -n "${TELEGRAM_BOT_TOKEN:-}" ] || echo "No TELEGRAM_BOT_TOKEN: create the Telegram credential in n8n (README, Configure your own alerts)."
echo "Test:  curl -X POST http://localhost:${N8N_PORT:-5678}/webhook/trigger-failure"
