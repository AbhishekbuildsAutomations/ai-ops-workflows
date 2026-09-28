# Build log

Everything that failed or surprised me while building this, with the cause and the fix. Newest last.

Stack: n8n 2.40.7 (Docker image), Postgres 18, Docker Compose 5.5 on Colima, macOS.

---

## Workflow 0: error handling and failure ledger (2026-09-28)

### 1. n8n docs URLs had moved
- **Symptom:** `docs.n8n.io/flow-logic/error-handling/` and `/hosting/installation/docker/` returned 404.
- **Cause:** the docs were reorganised under `/build/…` and `/deploy/…`.
- **Fix:** fetched `docs.n8n.io/sitemap.md` and used the `.md` version of each page. Every node setting here comes from the current page or from the n8n source in the image, not from memory.

### 2. The docs contradict each other on env access in expressions
- **Symptom:** the env-vars reference says `N8N_BLOCK_ENV_ACCESS_IN_NODE` defaults to `false`; the 2.0 breaking-changes page says `true`.
- **Cause:** one page is stale.
- **Fix:** read the source. `n8n-workflow/dist/cjs/workflow-data-proxy-env-provider.js` blocks access unless the value is exactly the string `'false'`. So it is blocked by default, and compose sets it to `false`.
- **Follow-on:** with env access on, a workflow can read every env var in the n8n container. The DB password, encryption key and runner token therefore go in as Docker Compose secrets (`environment:` source → `/run/secrets/…` → `*_FILE` vars), and the container environment holds only non-secret values. Checked with `docker compose exec n8n env`.

### 3. Docker wasn't installed
- **Fix:** `brew install colima docker docker-compose`, then `colima start --cpu 2 --memory 4`. Compose needed `"cliPluginsExtraDirs": ["/opt/homebrew/lib/docker/cli-plugins"]` in `~/.docker/config.json` to be found as `docker compose`. No GUI and no licence prompt. A native n8n already used port 5678, so this stack ran on `N8N_PORT=5680` locally.

### 4. The error workflow didn't run: "is not active and cannot be executed"
- **Symptom:** the test workflow failed, but no ledger row appeared. Log: `Calling Error Workflow for "aiopsTestFail000". Workflow "aiopsErrHandler0" is not active and cannot be executed`.
- **Cause:** the Error Trigger docs say *"If a workflow uses the Error Trigger node, you don't have to publish the workflow."* That is not true in 2.40.7.
- **Fix:** `bootstrap.sh` publishes the error handler too (`n8n publish:workflow`, then a restart, because CLI publish only takes effect on restart).

### 5. Re-importing a workflow unpublishes it
- **Symptom:** after re-importing the handler to test a change, errors stopped being logged again.
- **Cause:** `n8n import:workflow` defaults to `--activeState=false`, which deactivates what it imports.
- **Fix:** bootstrap always publishes after importing. Rule: after any CLI import, publish and restart.

### 6. Telegram: `Bad Request: chat not found`
- **Symptom:** the ledger row was written and the handler reported success, but no message arrived. The Telegram node's output was `{"error":"Bad Request: chat not found"}`.
- **Cause:** a new bot can't message a user who hasn't pressed **Start** on it. The chat ID was right; the bot was new.
- **Fix:** press Start in the bot's chat. The README setup now has this as step 2.
- **Useful side effect:** this proved the "never fails itself" design. Telegram failed and the ledger write still happened, and the execution stayed green.

### 7. Ledger-down alert said `[object Object]`
- **Test:** renamed `failure_ledger` mid-run to simulate a dead database.
- **Symptom:** the alert went out (good) but the reason read `Ledger: [object Object]`.
- **Cause:** with *continue on error*, a failed node outputs `{ message: "...", error: { ...details } }`. I had read `error.message`, which doesn't exist.
- **Fix:** read `r.message` first. Re-tested: the alert now reads `relation "failure_ledger" does not exist`.

### 8. Credentials didn't re-link unless `id` was `null`
- **Question:** can the committed JSON reference credentials by name only, so a fresh instance links them?
- **Finding:** n8n's `replaceInvalidCredentials` (`dist/workflow-helpers.js`) looks a credential up by name and type only when the reference is a string or has `id === null`. A missing `id` does not trigger the lookup.
- **Fix:** the export script writes `{"id": null, "name": "Ops ledger (Postgres)"}`. After a clean import, the DB showed both nodes linked to the bootstrap-created credentials.

### 9. `n8n execute` from the CLI failed twice
- **Symptom 1:** `n8n Task Broker's port 5679 is already in use`. The CLI command starts its own task broker, which collides with the running n8n.
  **Fix (testing only):** `docker compose exec -e N8N_RUNNERS_MODE=internal -e N8N_RUNNERS_BROKER_PORT=5690 -e N8N_RUNNERS_AUTH_TOKEN_FILE= n8n n8n execute --id=…`.
- **Symptom 2:** `Missing node to start execution`. The CLI needs a Manual or Execute Workflow trigger.
  **Fix:** added a **Run now (test)** manual trigger to the digest. It also gives a reviewer a one-click test in the UI.

### 10. Deprecation warnings at startup
- `WEBHOOK_URL` has been deprecated since 2.35 → `N8N_WEBHOOK_URL`.
- Internal task-runner mode is deprecated → an external `n8nio/runners` container, as in n8n's official `withPostgres` compose example.

### 11. The docs show the wrong execution URL
- The docs' Error Trigger example has `https://n8n.example.com/execution/231`. The code (`execution-lifecycle/execute-error-workflow.js`) builds `<base>/workflow/<workflowId>/executions/<executionId>`. The alert uses whatever n8n sends, and `N8N_EDITOR_BASE_URL` sets the host.

### 12. macOS ships bash 3.2
- `declare -A` (associative arrays) doesn't exist in bash 3.2, so the export script's id → file map broke. Replaced it with a `grep -rl` lookup.

### 13. Things I avoided on purpose, from the docs
- **Postgres Query Parameters as a comma-separated string** split on commas inside values, and error messages contain commas. The node gets an array expression instead: `={{ [ $json.signature, … ] }}`.
- **Schedule timezone:** the Schedule Trigger follows the workflow timezone, then the instance timezone (default `America/New_York`). The digest sets `settings.timezone = Asia/Kolkata`, so "Monday 9 AM IST" holds on any server.

### 14. Personal email in commit metadata
- **Symptom:** the pre-push scan found every file clean, but all 12 commits had a personal Gmail as author and committer, from the global git config. GitHub shows that publicly.
- **Fix (before any push):** set the repo's `user.email` to the GitHub no-reply address, rewrite all commits with `git filter-branch --env-filter` (author and committer email), then `reflog expire` and `gc --prune=now`, so no object with the old email is left. Checked with `git cat-file --batch-all-objects`.
- **Lesson:** scanning file contents is not enough. Commit metadata is published too.

### Verified end to end (clean volumes, `docker compose down -v` then `bootstrap.sh`)
- `schema.sql` created `failure_ledger` on first start.
- Test webhook ×2 → one row, `recurrence_count = 2`, two Telegram messages delivered.
- Marked `fixed` → next failure reopened it, and the alert said "Regression".
- Table renamed → the alert still went out, saying why the ledger write failed.
- The digest ran → Telegram message delivered; Sheets branch skipped with the flag off.
- **Not verified:** the Monday 09:00 cron firing on its own (it needs a Monday morning), and the Google Sheets append (it needs a Google OAuth credential).

---

## Part A: flow.html for every workflow (2026-09-28)

### 15. Mermaid is on v12, not v11
- The first draft imported `mermaid@11`. jsDelivr's latest is 12.0.0, and the Mermaid usage docs now show `mermaid@12/dist/mermaid.esm.min.mjs` (https://mermaid.js.org/config/usage.html). The script now pins the major, `@12`, so a future v13 can't change the pages silently.

### 16. Docker on Colima couldn't see `/private/tmp`
- **Symptom:** `cp: cannot stat '/out/check.mjs'` inside the Playwright container, although the file existed on the Mac.
- **Cause:** Colima only shares your home folder with its VM. A bind mount from outside `$HOME` shows up as an empty directory, with no error.
- **Fix:** screenshots and the check script live under `~/.cache/aiops-shots`.

### 17. The automated check passed, but the page looked wrong
- The Playwright check (scrollWidth ≤ viewport, body font ≥ 16px, every diagram rendered) passed on the first run. Looking at the screenshots showed three real bugs it couldn't catch:
  1. **Giant diagram on a laptop.** `svg{max-width:100%!important}` overrode Mermaid's own natural-width cap, so a 5-node chain scaled up to fill 950px.
     **Fix:** `useMaxWidth:false`, render at natural size, and put `overflow-x:auto` on the diagram box. A wide diagram now scrolls inside its box on a phone and never scrolls the page.
  2. **Fake tables in "Where data lives"** (`SET`, `the`). The SQL regex matched `DO UPDATE SET` and the word "from" in a SQL comment.
     **Fix:** strip `--` comments, and ignore an `update` that is followed by `set`.
  3. **Summary cut off mid-thought.** The README's first paragraph ended in "When any of them fails:", a lead-in to a list.
     **Fix:** rewrote that paragraph as standalone sentences.
- **Lesson:** a pass/fail check proves the page isn't broken; only looking at it proves it's right.

---

## What I should be able to explain about Workflow 0

1. **Why a ledger and not just alerts:** an alert tells you something broke; a ledger tells you it's the fortieth time. The signature (workflow + node + message with ids, numbers, URLs and timestamps masked) is what makes 40 runs one row.
2. **Why one SQL statement:** `INSERT … ON CONFLICT (signature) DO UPDATE SET recurrence_count = recurrence_count + 1` is atomic, so concurrent failures can't double-insert or lose a count. A CTE reads the old status in the same statement to flag regressions of "fixed" bugs.
3. **How it never fails itself:** Postgres and Telegram both continue on error with retries, Postgres first. A dead DB still alerts (and says so); a dead bot still logs. The Code nodes never throw. n8n won't recurse an error workflow into itself.
4. **How it stays runnable and leak-free:** fixed workflow IDs, credentials referenced by name with `id: null`, the chat ID from `$env`, and secrets as Docker `*_FILE` secrets because env access is on. The export script strips metadata and refuses tokens, emails and the chat ID.
5. **What I'd do next:** suppress repeat alerts within a time window, give the ledger its own DB role, and alert on a spike (N failures in M minutes) rather than on every failure.

---

## Workflow 1: WhatsApp and web-form lead agent (2026-09-28)

### 18. The spec was out of date in four places (researched before building, raised before substituting)
- **HubSpot private apps:** creation is disabled from 28 Sep 2026 for new accounts, and 26 Oct for existing ones (<!-- doc --> https://developers.hubspot.com/changelog/legacy-private-app-creation-sunset). Service Keys, the replacement, are in public beta with Free-tier support undocumented.
  **Decision (user):** use a free alternative. Went with **Twenty CRM**, self-hosted in compose. The runner-up was Zoho CRM Free, but it needs a signup and OAuth for every reviewer.
- **WhatsApp:** Meta charges per service message from 1 Oct 2026, and stops delivering service messages for businesses with no payment method by 30 Sep (<!-- doc --> https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing/non-template-messages/). The docs don't say whether the test number is exempt.
  **Decision:** build and test with signed, simulated Meta payloads first, and do the phone test separately.
- **`WEBHOOK_URL`:** deprecated since n8n 2.35; the spec's env var is now `N8N_WEBHOOK_URL`.
- **LLM free tiers had moved:**
  - Gemini 2.5 is closed to new projects.
  - Groq shut down its Llama models on 16 Aug 2026.
  - Gemini's free-tier limits are only visible inside AI Studio. Read from the account: **gemini-3.5-flash-lite = 15 requests/min, 250K tokens/min, 500 requests/day**.

### 19. Template search first
- Searched n8n's template library before writing anything.
- **#18696** (Twenty CRM lead capture) had the right CRM pattern (find → exists? → update/create, filter syntax). But its Twenty node is a **community package** (`@blackswampai/n8n-nodes-twentycrm`), not built in. Kept the pattern, rebuilt it with HTTP Request nodes so a cloner installs nothing.
- The WhatsApp verification setup (Respond With **Text**, `$json.query['hub.challenge']` in bracket notation) comes from an n8n community thread.

### 20. A missing credential kills the whole run, before the first node
- **Symptom:** a form lead returned `Error in workflow`. The execution contained a single node: `Chat model: uses invalid credential`.
- **Cause:** n8n checks the credentials of *every* node when a run starts. A workflow that references a credential that doesn't exist fails immediately, so "continue on error" never gets a chance, even on a branch that would never run.
- **Fix:** `bootstrap.sh` always creates every credential, using the value `not-configured` when `.env` has none, so a missing key becomes an ordinary API error the flow handles. It never overwrites a credential you've filled in through the UI.
- **This also fixed a latent Workflow 0 bug:** without a Telegram token, the error handler itself could never start.

### 21. `/healthz` says ready before webhooks are registered
- **Symptom:** straight after bootstrap, `POST /webhook/lead-form` and `GET /webhook/whatsapp` returned `404 … is not registered`, then worked a few seconds later.
- **Fix, attempt 1 (rejected):** probing each webhook with its real method would *run* it. `trigger-failure` would log a fake failure, and `whatsapp` a signature mismatch.
- **Fix:** probe with a CORS preflight, `OPTIONS`. It returns 204 once the webhook is registered and 500 before, and never runs the workflow.

### 22. My own test script hit the wrong n8n
- **Symptom:** `fake-whatsapp.mjs` kept getting 404, while curl on the same URL worked.
- **Cause:** its `.env` parser used `^[A-Z_]+=`, which silently skips `N8N_PORT` because of the digit. The script fell back to port 5678, which is a *different* n8n on this Mac (the native RS pipeline). The requests only got 404s there; nothing ran.
- **Fix:** `^[A-Z0-9_]+=`. **Lesson:** a hard-coded default port can quietly point at another service.

### 23. My own edit corrupted bootstrap.sh
- A Python `str.replace` used a slice between two `index()` calls. The end marker also appeared earlier in the file, so the slice was empty, and replacing `''` inserts the text between every character: a 3.9 MB file.
- **Fix:** restored from git and rewrote the file. **Lesson:** anchor replacements on unique text and check the file size after the edit.

### 24. The concurrency test wasn't concurrent
- The first SQL test ran 5 `docker compose exec` calls in the background, and passed **with the advisory lock removed**. Each `exec` takes long enough to start that the calls ran one after another.
- **Fix:** start all 5 `psql` sessions inside the container, each running `pg_sleep_until(<same instant>)` before calling `lead_ingest()`.
- **Result:** without the lock, 4–5 leads per run; with it, exactly 1, every run.
- **Why the lock works:** PL/pgSQL takes a fresh snapshot per statement, so once the second caller gets the lock, it sees the lead the first caller committed.

### 25. Twenty: the key in the image was a test fixture, and phones are split
- The only JWT inside the Twenty image was a unit-test fixture with a corrupted payload (`Bad control character in string literal`), not the API key.
- The real demo key is published in Twenty's SDK (`dev-api-key.ts`, marked "not a secret"). `bootstrap.sh` fetches it only when `CRM_ENABLED=true` and no key is set, so it never sits in this repo, where secret scanners would flag it.
- Twenty parses a full number such as `+91` + 10 digits into calling code `+91` and the 10-digit national number, so filtering on the full number finds nothing.
- **Fix:** search every possible national-number suffix in one `in` filter, then keep only the person whose calling code + number equals the full number.

### 26. The Postgres node emits an empty item for zero rows
- **Symptom:** the second follow-up run, with nothing due, crashed in `Decide channel` (`reading 'replace' of undefined`).
- **Cause:** a query returning no rows still passes one empty item on. The CRM sync had the same trap for spam leads.
- **Fix:** drop items without `lead_id`, and add an explicit `Worth syncing?` IF.

### 27. flow.html listed steps out of order
- The depth-first order listed "Save CRM ids" before "Create deal", and pushed short branches to the end.
- **Fix:** topological order (a node only after everything that feeds it), with a breadth-first tie-break. Chat-model sub-nodes count as feeding their chain.
