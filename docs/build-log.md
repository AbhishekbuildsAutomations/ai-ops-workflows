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

### 28. Every LLM call returned 404: n8n was calling the Responses API
- **Symptom:** `Chat model: The resource you are requesting could not be found (404)`, although the same key, base URL and model worked with curl on `/chat/completions`.
- **Searched first:** the n8n docs say the OpenAI Chat Model "will default to using the Chat Completions API" unless **Use Responses API** is toggled (<!-- doc --> https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.lmchatopenai.md). A similar custom-base-URL 404 is open as n8n issue #21651.
- **Proved it:** pointed the credential at a request-logging container. n8n sent `POST /v1beta/openai/responses`. In 2.40.7 source, node v1.3 has `responsesApiEnabled` with `default: true`, so the docs sentence is misleading for v1.3. Gemini's OpenAI-compatible endpoint has no `/responses`.
- **Fix:** `"responsesApiEnabled": false` on every OpenAI Chat Model node.

### 29. Gemini's free tier was overloaded: 100–200 s answers and 503 "high demand"
- **Symptom:** one direct call took 98 s, the next 197 s, for a 21-token answer. Other Gemini models returned `503 This model is currently experiencing high demand`.
- **Searched:** it's a known, recurring issue, reported even by paid Tier 2 projects on Google's developer forum (<!-- doc --> https://discuss.ai.google.dev/t/503-error-this-model-is-currently-experiencing-high-demand-spikes-in-demand-are-usually-temporary-please-try-again-later/139055).
- **Fix:**
  - The primary model (`LLM_MODEL`, Gemini 3.5 Flash-Lite) gets a 20 s timeout.
  - The chain's **fallback model** (n8n wraps it as LangChain `withFallbacks`) is `LLM_FALLBACK_MODEL` = `gemma-4-26b-a4b-it`: same key, 30 requests/min, 14.4K/day free, about 8 s per call.
  - Gemma prefixes its JSON with `<thought>…</thought>`, so the validator now strips that and parses the outermost `{…}`.
- **Trade-off:** when the primary is down, every lead pays the 20 s timeout before the fallback runs. The eval latency shows this honestly.

### 30. The eval found the prompt was the problem, and the model choice
- **Run 1:** hot-lead precision 40%. The model scored an angry existing customer 100 and "how much?" 90. The prompt said "how likely this lead becomes a paying customer" but never defined a scale, so the model rewarded anyone engaged.
  **Fix:** a rubric in the prompt (70+ = wants to book a service we sell, in our area, soon; support = 0–9). Labels unchanged.
- **Run 1, Gemini 3.5 Flash-Lite:** answered 0 of 33 runs; everything came from the Gemma fallback. At the user's request, "fast and cheap":
  - **Pricing page** (<!-- doc --> https://ai.google.dev/gemini-api/docs/pricing, 2026-09-24): 3.1 Flash-Lite is the cheapest current model.
  - **Live test, 5 calls each:** 3.1 Flash-Lite 4/5 in 4–11 s; 3.5 Flash-Lite, `flash-lite-latest` and 3.7 Flash 0/5.
  - **Switched** `LLM_MODEL` to `gemini-3.1-flash-lite`; primary timeout 15 s.
- **Run 2:** intent 93.3%, schema-valid 100% on the first try, hot precision 71.4% and recall 71.4%, median 8.5 s. Remaining misses are written up in the README (office contract, heavy typos, "next month" scored hot).
- **Lesson:** the eval paid for itself. Without it, 9 of 15 Telegram alerts would have been false, and nobody would have known why.

### 31. Getting the ngrok tunnel up (followed https://ngrok.com/agent-setup/prompt.md)
- **ERR_NGROK_313:** the compose command always passed `--url` with a placeholder domain the account doesn't own.
  **Fix:** `${NGROK_URL:+--url=${NGROK_URL}}` (Compose's "alternative value" syntax, <!-- doc --> https://docs.docker.com/reference/compose-file/interpolation/). With no `NGROK_URL`, ngrok uses the account's own free dev domain.
- **ERR_NGROK_108** "limited to 3 simultaneous ngrok agent sessions" (<!-- doc --> https://ngrok.com/docs/errors/err_ngrok_108): no other ngrok was running on this Mac, so the sessions belonged to other machines on the same account. They had expired by the next attempt.
  **Lesson:** the free plan caps agents per account, not per machine. The fix is to stop other agents, or run several tunnels from one agent config.
- **No way to read the URL:** the `ngrok/ngrok` image has no `curl`/`wget`, and the agent's default interactive display writes no logs.
  **Fix:** publish the agent API as `127.0.0.1:4040:4040` (localhost only, since it shows live traffic) and read `/api/tunnels`, as ngrok's Docker page recommends.
- **Verified through the public URL:** `/healthz` returned `{"status":"ok"}` as locally, the editor loads (behind the n8n login), and the WhatsApp verify webhook echoed `hub.challenge` (200), with 403 for a wrong token. The domain stayed the same after a restart.

### 32. Twenty v2.43.0 serves no UI: every page 404s, the API works
- **Symptom:** the CRM sync kept working, but `http://localhost:2020/` returned 404, so nobody could log in to look at the synced leads.
- **Searched:** known regression in v2.43.0. The frontend's static-file middleware isn't wired up, so the server only registers `/metadata`, `/admin-panel` and `/graphql` (<!-- doc --> https://github.com/twentyhq/twenty/issues/26755). No fixed release yet (newest tag is still v2.43.0).
- **Fix:** pin `twentycrm/twenty-app-dev:v2.42.6`, the last release before it. Downgrading onto a database v2.43 had already migrated isn't safe, so the demo volumes (seed data plus test records only) were recreated. The seeded API key is unchanged; UI 200 and API 200, and a lead sent through the public URL synced to a new person and deal.
- **Lesson:** the automated checks only covered the API the workflow uses. A reviewer opens the UI first, so check that too.

### 33. Real WhatsApp: three things the dashboard doesn't tell you
- **Verify token rejected:** Meta's GET reached n8n (ngrok showed `facebookplatform/1.0` → 403), so the tunnel was fine. The app secret had been pasted as the verify token. Correct value → 200.
- **Dashboard Test works, real messages don't:** the Configure Webhooks page warns that an unpublished app only receives dashboard test webhooks. An n8n community thread (<!-- doc --> https://community.n8n.io/t/error-receiving-messages-in-n8n-whatsapp-trigger-new-meta-apps-set-up-api-vs-test-api-webhook-test-ok-live-messages-fail/233724) pointed to a second cause. `GET /<WABA_ID>/subscribed_apps` listed only Meta's internal "WA DevX Webhook Events 1P App", not ours.
  **Fix:** `POST /<WABA_ID>/subscribed_apps`, then publish (needs a privacy policy URL, so [PRIVACY.md](../PRIVACY.md) was added). After that, real `sent`/`delivered` statuses and inbound messages arrived.
- **Token expiry:** `debug_token` showed the dashboard token expiring within the hour. Replaced with a system-user token (`expires_at: 0`), and checked that n8n's credential matches `.env` without printing it.
- **Result:** a real message from a phone was scored `buy`/90, got a guarded reply quoting the facts price (₹3,499), triggered the Telegram hot-lead alert and synced to Twenty. About 20 s end to end, 18 s of it the Gemini call.

### 34. Follow-up messages went nowhere
- **Found by using it:** after the first reply, "Okay - schedule" was stored and nothing else happened. By design, attached messages got no reply, but the owner wasn't told either, so a lead ready to book got silence.
- **Fix (chosen with the user):** hand off, don't converse. Once the first message has been answered, each follow-up is forwarded to Telegram, the lead becomes `needs_human` (which also stops the automated nudge), and the customer gets one fixed acknowledgement from `business-facts.json`.
- **Bug 1:** the acknowledgement was empty. `lead_ingest()` only returns `facts` for new leads. The handoff SQL now reads `handoff_reply` from `business_facts` itself.
- **Bug 2 (race):** with a slow LLM (40 s+), a follow-up sent during qualification got "someone will confirm" before the real answer, and the first run's save then overwrote `needs_human` with `replied`. Handoff now only happens when the lead's status is no longer `new` (and never for spam). Earlier follow-ups are only stored.
- **Verified:** fake-WhatsApp run with 4 messages: the mid-qualification message was stored only, then the answer, exactly one acknowledgement, and a Telegram forward for each later message. Then a real follow-up from a phone got the acknowledgement.
- **Lesson:** a fixed acknowledgement reads as a template, and that's the trade-off. It can't promise a time slot the business doesn't have.

### 35. Screenshots, and the eval was spamming the owner
- Screenshots from the real run: the WhatsApp chat, the Telegram handoff alerts and the Twenty deal. The phone number isn't visible in any of them.
- **Found while taking them:** 14 "Follow-up needed" nudges on Telegram at 11:30 PM, all for eval leads. The follow-up workflow was right: those were web-form leads with no answer after `FOLLOWUP_HOURS`. The eval just left its fictional leads open.
  **Fix:** `run-eval.mjs` now closes its own leads when it finishes (`followed_up_at` set, `followup_status = 'eval'`), so they are never picked up.
- **Also found:** Docker (Colima) had stopped overnight, so the bot was offline until restarted. That's fine for a laptop demo; a real deployment needs a host that stays up.

---

## What I should be able to explain about Workflow 1

1. **One core, two doors:** WhatsApp (Meta verification, HMAC signature over the raw body, retries deduped by message id) and a plain web form both call one sub-workflow. `lead_ingest()` uses a per-contact advisory lock, so a burst of messages makes one lead (proven: 4–5 duplicates without the lock, 1 with).
2. **An LLM output is untrusted input:** it's validated in code against the schema, retried once with the errors, then `needs_human`. A reply guard blocks any price, discount or promise that isn't in `business-facts.json`. Prompt injection was resisted 2/2, and the guard caught one "guarantee".
3. **Designed for free-tier failure:** the primary has a 15 s timeout, then a Gemma fallback on the same key. If both are down, the lead is still stored, still answered safely, and logged to Workflow 0's ledger. A missing credential would kill a whole n8n run, so bootstrap creates placeholders.
4. **Measured, not claimed:** a 30-message labelled eval. Run 1 exposed an undefined `fit_score` (40% hot precision); a rubric took it to 71%. Both runs and every remaining miss are in the README.
5. **Honest limits:** the WhatsApp test number only reaches verified numbers, replies are billed from 1 Oct 2026, 24-hour window (template_needed), free-tier latency spikes, and support messages don't alert anyone yet.
