# ai-ops-workflows

n8n workflows that solve problems companies list in AI-automation job posts. Each one runs locally from this repo with Docker, with no accounts to create except a Telegram bot for alerts.

| # | Workflow | Problem it solves | Status | Flow | Demo |
|---|----------|-------------------|--------|------|------|
| 0 | [Error handling and failure ledger](workflows/00-error-handling/) | Automations fail silently; nobody knows a run broke until a customer complains. Every failure is logged to Postgres, grouped by a normalised signature, alerted on Telegram, and summarised weekly. | ✅ done | [flow.html](workflows/00-error-handling/flow.html) | [results](workflows/00-error-handling/README.md#results) |

Every workflow in this repo uses Workflow 0 as its error workflow.

Each workflow folder has a `flow.html`: open it in a browser to see the diagram, every step, what happens on failure, where data goes and how to test it, without opening n8n. [`docs/index.html`](docs/index.html) links them all. GitHub shows `.html` files as source; to view one, clone the repo and open the file, or use a raw-HTML preview.

## Quick start

Needs Docker with Compose v2 (Docker Desktop, OrbStack or Colima) and a Telegram account.

```bash
git clone <this repo> && cd ai-ops-workflows
cp .env.example .env
```

Edit `.env`:

- `N8N_ENCRYPTION_KEY`, `RUNNERS_AUTH_TOKEN`, `POSTGRES_PASSWORD`: generate each with `openssl rand -hex 32`
- `TELEGRAM_CHAT_ID`: see [Configure your own alerts](#configure-your-own-alerts)
- `TELEGRAM_BOT_TOKEN`: optional; leave it blank to paste the token into n8n instead

```bash
./scripts/bootstrap.sh
```

This starts n8n and Postgres, creates the `failure_ledger` table, creates the credentials, imports and publishes every workflow. Open http://localhost:5678, create the owner account, then trigger a failure:

```bash
curl -X POST http://localhost:5678/webhook/trigger-failure
```

You get a Telegram alert and a row in `failure_ledger`. Run it again and the same row's `recurrence_count` goes to 2.

## Configure your own alerts

Nothing in the workflow files points at a particular person. The chat ID is read from the environment, and the bot token lives only in an n8n credential.

1. **Create a bot.** In Telegram, open [@BotFather](https://t.me/BotFather), send `/newbot`, and pick a name and a username ending in `bot`. BotFather replies with a token like `123456789:AA…`. Keep it private.
2. **Start the bot.** Open `t.me/<your_bot_username>` and tap **Start**. A bot cannot message you until you have messaged it first. Skipping this is what causes `Bad Request: chat not found`.
3. **Get your chat ID.** In a browser, open `https://api.telegram.org/bot<TOKEN>/getUpdates`. Find `"chat":{"id":123456789,…}`; that number is your chat ID. If `result` is empty, send the bot any message and reload. `getUpdates` returns nothing if the bot has a webhook set, for example a Telegram Trigger in some other n8n instance, so use a bot that has none. For a group, add the bot to the group and send a message there; group IDs start with `-`.
4. **Set the env var.** Put it in `.env` as `TELEGRAM_CHAT_ID=123456789`. Compose passes it to n8n, and the Telegram nodes read it as `{{ $env.TELEGRAM_CHAT_ID }}`. After changing it, run `docker compose up -d` so n8n picks it up.
5. **Attach the credential.** Choose one:
   - **Let bootstrap do it:** set `TELEGRAM_BOT_TOKEN` in `.env` and run `./scripts/bootstrap.sh`. It creates the credential **Ops alerts (Telegram bot)** inside the container. The token is never passed to the n8n container's environment.
   - **Do it in n8n:** leave `TELEGRAM_BOT_TOKEN` blank. In n8n go to **Overview → Credentials → Create credential → Telegram API**, paste the token into **Access Token**, and name it exactly `Ops alerts (Telegram bot)`. Then open **Send Telegram alert** in *00 · Error handler* and **Send digest** in *00 · Weekly failure digest*, and pick that credential in **Credential to connect with**. Save both.

Why `$env` and not n8n Variables: `$vars` needs a paid n8n plan. `$env` needs `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` (blocked by default since n8n 2.0), which `docker-compose.yml` sets. It passes secrets as Docker secrets (`*_FILE`), so nothing sensitive sits in the environment a workflow can read.

## Repo layout

```
docker-compose.yml        n8n + task runner + Postgres; schema.sql runs on first start
.env.example              every variable used, placeholders only
scripts/bootstrap.sh      clone -> running demo in one command
scripts/export-workflows.sh   n8n -> repo, credentials stripped, refuses personal data
docs/conventions.md       naming, error handling, exporting
docs/build-log.md         what broke while building this, and the fix
docs/index.html           links every workflow's flow.html
scripts/build-flow-html.mjs   regenerates every flow.html + docs/index.html (no dependencies)
workflows/NN-name/        one folder per workflow: JSON, SQL, tests, README, flow.html, screenshots
```

## Stop / reset

```bash
docker compose down        # stop, keep data
docker compose down -v     # stop and delete all data, including saved credentials
```
