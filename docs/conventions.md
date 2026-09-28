# Conventions

## Naming

- **Folder:** `workflows/NN-short-name/`. `NN` is the portfolio number; `00` is shared infrastructure.
- **Workflow name:** `NN · What it does`, for example `00 · Weekly failure digest`. The number sorts the n8n list the same way as the repo.
- **Workflow ID:** fixed, 16 characters, starting `aiops`, for example `aiopsErrHandler0`. Fixed IDs let workflows reference each other (`settings.errorWorkflow`) and let a re-import update in place instead of duplicating.
- **Node names** say what the node does to the data (`Upsert ledger row`, `Build signature`), not what the node is (`Postgres1`, `Code`).
- **Credential names** describe the role, not the owner: `Ops ledger (Postgres)`, `Ops alerts (Telegram bot)`. The workflow JSON refers to credentials by these names.

## Error handling

1. **Every workflow sets Settings → Error workflow = `00 · Error handler → failure ledger`** (`"errorWorkflow": "aiopsErrHandler0"` in the JSON). The only exception is the error handler itself.
2. **Calls to outside services** (APIs, databases, messaging) get **Retry on fail**, 3 tries, with a wait of 2 s or more.
3. **Continue on error** is only for side effects the run can live without, like an alert or a log write. A step whose output later steps depend on must fail loudly, so the error workflow sees it.
4. **Fail on purpose** with **Stop and Error** when data is wrong but no node errored, for example an API returning 200 with an empty list. A silent success is worse than a failure.
5. **The error workflow must be published.** n8n 2.40 won't run an unpublished one, whatever the docs say (see `build-log.md`).

## Configuration and secrets

| Kind | Where | Example |
|------|-------|---------|
| Secret used by a node | n8n credential | bot token, DB password, API keys |
| Secret used by n8n itself | Docker secret → `*_FILE` env var | `N8N_ENCRYPTION_KEY_FILE` |
| Non-secret per-person setting | `.env` → compose `environment` → `$env.NAME` | `TELEGRAM_CHAT_ID`, feature flags |
| Fixed value | in the node | cron expression, SQL |

Nothing personal goes in a workflow JSON: no chat IDs, emails, phone numbers, sheet IDs or tokens. Add each new `$env` variable to `.env.example` and to the n8n service's `environment` list in `docker-compose.yml`. Only listed variables reach n8n.

## Exporting workflows without credentials

Edit in the n8n UI, then:

```bash
./scripts/export-workflows.sh
git diff workflows/
```

The script:

1. Runs `n8n export:workflow --backup` inside the container.
2. Keeps only `id`, `name`, `nodes`, `connections` and `settings`. It drops `versionId`, `meta.instanceId`, pinned data, sharing, tags and timestamps.
3. Replaces each credential reference with `{"id": null, "name": "…"}`. On import, n8n re-links a credential by name only when `id` is `null` (`replaceInvalidCredentials` in n8n's `workflow-helpers.js`), so a fresh instance picks up the credential that `bootstrap.sh` created.
4. **Refuses to write anything** that contains a Telegram bot token, an email address or your `TELEGRAM_CHAT_ID`.
5. Writes each workflow over the file in the repo with the same `id`. A new workflow lands in `workflows/_new/`; move it into its folder.

Don't use the UI's **Download** for committed files. It keeps credential IDs and instance metadata.

## Tests

- Logic in a Code node that can break (parsing, normalising, anything with a branch) gets a `test/*.test.mjs` that loads the code **from the workflow JSON** and runs it with plain Node. There is no second copy to drift.
- Every workflow folder has a way to trigger its whole path end to end (a webhook or a manual trigger), and the README shows the command.

## Commits

One logical change per commit, message in the imperative (`Add weekly digest workflow`). Before committing, check that the exported JSON diff contains no personal values; the export script enforces this for workflows.
