#!/usr/bin/env bash
# Export every workflow from the running n8n back into the repo, safe to commit.
#   - n8n CLI export (export:workflow --backup = --all --pretty --separate)
#   - keeps only id, name, nodes, connections, settings; drops instance ids, version ids,
#     pinned data, sharing, tags, timestamps
#   - credential references become {"id": null, "name": ...}; on import n8n re-links them by name
#   - refuses to write anything containing the Telegram chat ID, a bot token or an email address
# A workflow whose id already exists in the repo overwrites that file; a new one lands in workflows/_new/.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] && { set -a; . ./.env; set +a; }

docker compose exec -T n8n sh -c 'rm -rf /tmp/export && n8n export:workflow --backup --output=/tmp/export/ >/dev/null'
docker compose exec -T n8n node -e '
  const fs = require("fs");
  for (const f of fs.readdirSync("/tmp/export")) {
    const w = JSON.parse(fs.readFileSync("/tmp/export/" + f, "utf8"));
    for (const n of w.nodes) {
      for (const t of Object.keys(n.credentials ?? {})) n.credentials[t] = { id: null, name: n.credentials[t].name };
    }
    const clean = { id: w.id, name: w.name, nodes: w.nodes, connections: w.connections, settings: w.settings ?? {} };
    fs.writeFileSync("/tmp/export/" + f, JSON.stringify(clean, null, 2) + "\n");
  }'
rm -rf .export-tmp && docker compose cp n8n:/tmp/export .export-tmp >/dev/null

leak=0
for f in .export-tmp/*.json; do
  if grep -En '[0-9]{8,10}:[A-Za-z0-9_-]{35}|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}' "$f" \
     || { [ -n "${TELEGRAM_CHAT_ID:-}" ] && grep -Fn "$TELEGRAM_CHAT_ID" "$f"; }; then
    echo "REFUSED: $f contains a token, email or your chat ID (lines above)."; leak=1
  fi
done
[ "$leak" = 0 ] || { echo "Nothing written. Move the value into a credential or \$env and export again."; exit 1; }

for f in .export-tmp/*.json; do
  id=$(basename "$f" .json)
  dest=$(grep -rl --include='*.json' "^  \"id\": \"$id\"," workflows | grep -v '^workflows/_new/' | head -1 || true)
  dest=${dest:-workflows/_new/$id.json}
  mkdir -p "$(dirname "$dest")"
  cp "$f" "$dest"
  echo "$dest"
done
rm -rf .export-tmp
git status --short workflows
