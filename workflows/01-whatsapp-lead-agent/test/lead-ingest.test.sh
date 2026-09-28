#!/usr/bin/env bash
# Checks lead_ingest() against a running stack: concurrency, dedupe window, Meta retries.
#   ./workflows/01-whatsapp-lead-agent/test/lead-ingest.test.sh
set -euo pipefail
cd "$(dirname "$0")/../../.."
q() { docker compose exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -At -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<<"$1"; }
C="+10000000$RANDOM"          # fictional test contact, cleaned up at the end
trap 'q "DELETE FROM leads WHERE contact = '"'$C'"';" >/dev/null' EXIT

# 5 messages from one contact at the same instant: must become ONE lead with 5 messages.
# All 5 sessions start inside the container and sleep until the same moment, so the calls really overlap.
docker compose exec -T -e C="$C" postgres sh -c '
  at=$(psql -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT now() + interval '"'"'2 seconds'"'"'")
  for i in 1 2 3 4 5; do
    psql -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT pg_sleep_until('"'"'$at'"'"')" \
      -c "SELECT outcome FROM lead_ingest('"'"'$C'"'"','"'"'whatsapp'"'"','"'"'Test'"'"','"'"'msg '"'"'||$i,'"'"'wamid.test-$C-$i'"'"', now(), 30)" &
  done; wait' > /tmp/ingest.$$
leads=$(q "SELECT count(*) FROM leads WHERE contact = '$C';")
msgs=$(q "SELECT count(*) FROM lead_messages m JOIN leads l ON l.id = m.lead_id WHERE l.contact = '$C';")
new=$(grep -c '^new$' /tmp/ingest.$$ || true); rm -f /tmp/ingest.$$
[ "$leads" = 1 ] && [ "$msgs" = 5 ] && [ "$new" = 1 ] || { echo "FAIL concurrency: leads=$leads msgs=$msgs new=$new"; exit 1; }

# Meta retries the same message id: nothing stored twice
[ "$(q "SELECT outcome FROM lead_ingest('$C','whatsapp','Test','msg 1','wamid.test-$C-1', now(), 30);")" = duplicate ] || { echo "FAIL duplicate"; exit 1; }

# Outside the window: a new lead
[ "$(q "SELECT outcome FROM lead_ingest('$C','whatsapp','Test','later','wamid.test-$C-9', now() + interval '2 hours', 30);")" = new ] || { echo "FAIL window"; exit 1; }
echo "lead_ingest tests passed"
