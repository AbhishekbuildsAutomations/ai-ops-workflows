#!/usr/bin/env bash
# One command from clone to working demo:
#   starts the stack (plus any COMPOSE_PROFILES), applies every workflows/*/sql/schema.sql,
#   loads business facts, creates credentials from .env, imports every workflow and publishes it.
# Safe to re-run: schemas are idempotent, and credentials and workflows keep fixed IDs, so a
# re-run updates them in place.
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env ] || { echo "No .env. Run: cp .env.example .env   then fill it in."; exit 1; }
set -a; . ./.env; set +a
for v in N8N_ENCRYPTION_KEY RUNNERS_AUTH_TOKEN POSTGRES_PASSWORD TELEGRAM_CHAT_ID; do
  case "${!v:-}" in ''|change-me|123456789|*replace-with*) echo "Set $v in .env first."; exit 1 ;; esac
done
URL="http://localhost:${N8N_PORT:-5678}"

docker compose up -d
echo -n "waiting for n8n"
until curl -sf "$URL/healthz" >/dev/null; do echo -n .; sleep 2; done; echo

psql_in() { docker compose exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -q -U "$POSTGRES_USER" -d "$POSTGRES_DB" "$@"' psql "$@"; }

# Schemas: all idempotent (IF NOT EXISTS / CREATE OR REPLACE), so this also upgrades an old volume.
for f in workflows/*/sql/schema.sql; do
  echo "schema $f"; psql_in < "$f" 2>&1 | grep -v 'already exists, skipping' || true
done

# business-facts.json -> business_facts table (the lead agent's prompt and reply guard read it).
for f in workflows/*/business-facts.json; do
  echo "facts  $f"
  psql_in -v facts="$(cat "$f")" <<'SQL'
INSERT INTO business_facts (id, data) VALUES (1, :'facts'::jsonb)
ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, loaded_at = now();
SQL
done

# Twenty's demo image accepts a demo API key that Twenty publishes in its own repo.
if [ "${CRM_ENABLED:-false}" = true ] && [ -z "${TWENTY_API_KEY:-}" ]; then
  TWENTY_API_KEY=$(curl -fsSL https://raw.githubusercontent.com/twentyhq/twenty/main/packages/twenty-sdk/src/cli/constants/dev-api-key.ts \
    | tr -d "\n '" | sed -n 's/.*DEV_API_KEY=\(eyJ[^;]*\);.*/\1/p')
  [ -n "$TWENTY_API_KEY" ] || { echo "Could not fetch Twenty's demo key; set TWENTY_API_KEY in .env."; exit 1; }
fi

# Credentials are built inside the container. Optional secrets are passed to this one process
# only (-e), never to the n8n container's environment, so $env cannot read them.
# A blank value creates the credential with the placeholder "not-configured": n8n refuses to start
# a run at all if any node's credential is missing (even a node that would never run), so a
# placeholder keeps the other paths working and turns a missing key into an ordinary, handled
# API error. An existing credential is never overwritten with a placeholder, so one you filled
# in through the n8n UI survives re-runs.
existing=$(psql_in -At -c "SELECT string_agg(id, ' ') FROM credentials_entity WHERE id LIKE 'aiopsCred%'" 2>/dev/null || true)
docker compose exec -T -e EXISTING="$existing" \
  -e TG_TOKEN="${TELEGRAM_BOT_TOKEN:-}" \
  -e LLM_KEY="${LLM_API_KEY:-}" -e LLM_URL="${LLM_BASE_URL:-}" \
  -e WA_TOKEN="${WHATSAPP_ACCESS_TOKEN:-}" \
  -e CRM_KEY="${TWENTY_API_KEY:-}" \
  n8n sh -c '
  node -e "
    const fs = require(\"fs\"); const e = process.env;
    const ph = (v, id) => (v || ((e.EXISTING || \"\").split(\" \").includes(id) ? null : \"not-configured\"));
    const cred = (id, name, type, v, data) => { const val = ph(v, id); return val === null ? [] : [{ id, name, type, data: data(val) }]; };
    fs.writeFileSync(\"/tmp/creds.json\", JSON.stringify([
      { id: \"aiopsCredPg00001\", name: \"Ops ledger (Postgres)\", type: \"postgres\", data: {
          host: \"postgres\", port: 5432, database: e.DB_POSTGRESDB_DATABASE, user: e.DB_POSTGRESDB_USER, ssl: \"disable\",
          password: fs.readFileSync(\"/run/secrets/postgres_password\", \"utf8\").trim() } },
      ...cred(\"aiopsCredTg00001\", \"Ops alerts (Telegram bot)\", \"telegramApi\", e.TG_TOKEN, (k) => ({ accessToken: k })),
      ...cred(\"aiopsCredLlm0001\", \"LLM (OpenAI-compatible)\", \"openAiApi\", e.LLM_KEY, (k) => ({ apiKey: k, url: (e.LLM_URL || \"https://generativelanguage.googleapis.com/v1beta/openai/\").replace(/\\/$/, \"\") })),
      ...cred(\"aiopsCredWa00001\", \"WhatsApp Cloud API token\", \"httpHeaderAuth\", e.WA_TOKEN, (k) => ({ name: \"Authorization\", value: \"Bearer \" + k })),
      ...cred(\"aiopsCredCrm0001\", \"Twenty CRM API key\", \"httpHeaderAuth\", e.CRM_KEY, (k) => ({ name: \"Authorization\", value: \"Bearer \" + k })),
    ]));
  " && n8n import:credentials --input=/tmp/creds.json; rc=$?; rm -f /tmp/creds.json; exit $rc'

# Every JSON file under workflows/ that is an n8n workflow. The error handler goes first.
workflows=$(grep -rl --include='*.json' '"connections"' workflows | sort)
ids=""
for f in workflows/00-error-handling/workflow-error-handler.json $(echo "$workflows" | grep -v 'workflow-error-handler.json'); do
  echo "import $f"
  docker compose exec -T n8n n8n import:workflow --input="/repo/$f" 2>&1 | grep -v 'migration lock' || true
  ids="$ids $(sed -n 's/^  "id": "\(.*\)",$/\1/p' "$f" | head -1)"
done

# Publish everything. Importing unpublishes (--activeState defaults to false), so this runs every time.
# The n8n docs say an error workflow needs no publish; 2.40 refuses to run an unpublished one
# ("is not active and cannot be executed"). Sub-workflows must be published too. See docs/build-log.md.
for id in $ids; do
  docker compose exec -T n8n n8n publish:workflow --id="$id" 2>&1 | grep -i 'publishing\|error' || true
done
docker compose restart n8n   # publish via CLI only takes effect after a restart
until curl -sf "$URL/healthz" >/dev/null; do sleep 2; done

# /healthz answers before n8n has registered every webhook. Wait until each one answers a CORS
# preflight (OPTIONS: 204 once registered, an error before), which never runs the workflow.
echo -n "waiting for webhooks"
for path in $(psql_in -At -c 'SELECT DISTINCT "webhookPath" FROM webhook_entity'); do
  for _ in $(seq 1 30); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' -X OPTIONS -H 'Origin: http://localhost' \
         -H 'Access-Control-Request-Method: POST' "$URL/webhook/$path")" = 204 ] && break
    echo -n .; sleep 2
  done
done; echo

echo
echo "Ready: $URL  (first visit asks you to create the owner account)"
[ -n "${TELEGRAM_BOT_TOKEN:-}" ] || echo "No TELEGRAM_BOT_TOKEN: set the Telegram credential in n8n (README, Configure your own alerts)."
[ -n "${LLM_API_KEY:-}" ] || echo "No LLM_API_KEY: every lead becomes needs_human until you add one (Workflow 1 README)."
echo "Test Workflow 0:  curl -X POST $URL/webhook/trigger-failure"
echo "Test Workflow 1:  see workflows/01-whatsapp-lead-agent/README.md, How to test"
