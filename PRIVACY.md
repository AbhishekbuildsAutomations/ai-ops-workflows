# Privacy policy

This repository is a portfolio demo. The "AI Ops Lead Agent" Meta app exists only to test Workflow 1 (the WhatsApp lead agent) with the Meta test phone number and a handful of test recipients added by the repo owner. It is not a public service.

**What it processes.** When a test recipient messages the test number, the workflow receives the sender's WhatsApp ID, profile name and message text.

**Where it goes.** That data is stored in a Postgres database and an optional Twenty CRM, both running on the repo owner's own machine. The message text is sent to an LLM API (Google Gemini) to classify the lead and draft a reply. A short alert may be sent to the owner's Telegram. Nothing is sold or shared with anyone else.

**How long.** Test data is deleted when the demo stack is torn down (`docker compose down -v`).

**Deletion.** To have your data removed, open an issue on this repository and it will be removed.

Last updated: 2026-09-28.
