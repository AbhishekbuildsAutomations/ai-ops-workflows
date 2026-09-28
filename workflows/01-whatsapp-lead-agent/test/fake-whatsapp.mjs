// Simulates Meta against your local n8n, without a Meta account:
//   1. the webhook verification GET (hub.challenge)
//   2. an inbound text message, signed with WHATSAPP_APP_SECRET exactly like Meta signs it
// usage: node workflows/01-whatsapp-lead-agent/test/fake-whatsapp.mjs "message text" [+fictional phone]
// Reads .env from the repo root. Uses a fictional number by default; the reply send to Meta will
// fail (no real recipient), which the workflow records as delivered=false + needs_human.
import { readFileSync } from 'node:fs';
import { createHmac, randomUUID } from 'node:crypto';

const env = Object.fromEntries(readFileSync(new URL('../../../.env', import.meta.url), 'utf8')
  .split('\n').filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const base = `http://localhost:${env.N8N_PORT || 5678}/webhook/whatsapp`;
const text = process.argv[2] || 'Hi, need a deep clean for my 3BHK next week';
const from = (process.argv[3] || '+10000000009').replace(/\D/g, '');

const challenge = String(Date.now());
const v = await fetch(`${base}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(env.WHATSAPP_VERIFY_TOKEN)}&hub.challenge=${challenge}`);
const vBody = await v.text();
console.log(`verify GET: ${v.status} ${vBody === challenge ? 'challenge echoed' : 'WRONG BODY: ' + vBody.slice(0, 80)}`);
const bad = await fetch(`${base}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`);
console.log(`verify GET with wrong token: ${bad.status}`);

const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '0', changes: [{ field: 'messages', value: {
  messaging_product: 'whatsapp', metadata: { display_phone_number: '10000000000', phone_number_id: env.WHATSAPP_PHONE_NUMBER_ID || '0' },
  contacts: [{ profile: { name: 'Fake WhatsApp Lead' }, wa_id: from }],
  messages: [{ from, id: 'wamid.FAKE' + randomUUID().replace(/-/g, ''), timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }],
} }] }] });
const sig = 'sha256=' + createHmac('sha256', env.WHATSAPP_APP_SECRET || '').update(body).digest('hex');
const r = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig }, body });
console.log(`message POST: ${r.status} (processing continues in n8n)`);
