// Runs the real Code-node JavaScript from the Workflow 1 JSON files with fake inputs.
// No n8n needed:  node workflows/01-whatsapp-lead-agent/test/code-nodes.test.mjs
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createRequire as cr } from 'node:module';

const require = cr(import.meta.url);
const dir = new URL('..', import.meta.url);
const code = (file, node) => JSON.parse(readFileSync(new URL(file, dir))).nodes.find((n) => n.name === node).parameters.jsCode;
const facts = JSON.parse(readFileSync(new URL('business-facts.json', dir)));
const AsyncFunction = (async () => {}).constructor;

// Minimal stand-in for n8n's Code node globals.
async function run(src, { json = {}, nodes = {}, env = {}, binary } = {}) {
  const $ = (name) => ({ first: () => ({ json: nodes[name] }), item: { json: nodes[name] }, isExecuted: name in nodes });
  const $input = { first: () => ({ json, binary }) };
  const ctx = { helpers: { getBinaryDataBuffer: async () => binary } };
  const f = new AsyncFunction('$json', '$input', '$', '$env', '$execution', '$workflow', 'require', src);
  const out = await f.call(ctx, json, $input, $, env, { id: '7' }, { id: 'wf', name: 'Lead core' }, require);
  return Array.isArray(out) ? out.map((x) => x.json) : out.json;
}

// ---------------------------------------------------------------- Validate answer
const validate = code('workflow-lead-core.json', 'Validate answer');
const good = { intent: 'buy', budget_signal: 'none', urgency: 'now', fit_score: 82, missing_info: ['area'], reply_draft: 'Which area are you in?', reason: 'Wants a clean this week.' };
let [v] = await run(validate, { json: { text: JSON.stringify(good) } });
assert.equal(v.valid, true);
[v] = await run(validate, { json: { text: '```json\n' + JSON.stringify({ ...good, extra: 1 }) + '\n```' } });
assert.equal(v.valid, true, 'code fences and extra keys are tolerated');
assert.equal('extra' in v.q, false, 'extra keys are dropped');
[v] = await run(validate, { json: { text: JSON.stringify({ ...good, intent: 'purchase', fit_score: '82' }) } });
assert.equal(v.valid, false);
assert.equal(v.errors.length, 2, 'bad enum and string score both reported');
[v] = await run(validate, { json: { text: '<thought>\n* Input: need cleaning\n* Goal: return {json}\n</thought>\n' + JSON.stringify(good) } });
assert.equal(v.valid, true, 'a <thought> preamble (Gemma fallback) is stripped');
[v] = await run(validate, { json: { text: 'Sure! Here is the JSON you asked for' } });
assert.match(v.errors[0], /not valid JSON/);
[v] = await run(validate, { json: { text: '[1,2]' } });
assert.equal(v.valid, false);

// ---------------------------------------------------------------- Decide reply (routing + reply guard)
const decide = code('workflow-lead-core.json', 'Decide reply');
const nodes = {
  'Normalise lead': { source: 'form', contact: '+10000000001', contact_name: 'T', message: 'hi', wa_id: null },
  'Save message, find conversation': { lead_id: 1, conversation_id: 'c', facts },
};
const dec = async (q, env = { HOT_LEAD_SCORE: '70' }) => (await run(decide, { json: { valid: !!q, attempt: 1, q, errors: q ? [] : ['bad'] }, nodes, env }))[0];

let d = await dec(good);
assert.equal(d.status, 'replied'); assert.equal(d.hot, true); assert.equal(d.reply, good.reply_draft);
d = await dec({ ...good, intent: 'spam', fit_score: 2, reply_draft: '' });
assert.equal(d.status, 'spam'); assert.equal(d.reply, null); assert.equal(d.hot, false);
d = await dec({ ...good, fit_score: 10, missing_info: [] });
assert.equal(d.status, 'no_reply', 'low score and nothing missing: no auto-reply');
d = await dec(null);
assert.equal(d.status, 'needs_human'); assert.equal(d.reply, facts.fallback_reply); assert.equal(d.notify, true);
// the guard
d = await dec({ ...good, reply_draft: 'Sure, we can do 90% off for you! Which area?' });
assert.equal(d.reply, facts.fallback_reply, 'invented discount is blocked');
assert.ok(d.guard_flags.some((f) => f.includes('90%')));
d = await dec({ ...good, reply_draft: '2BHK deep cleaning is from ₹3,499. When would you like it done?' });
assert.equal(d.reply, '2BHK deep cleaning is from ₹3,499. When would you like it done?', 'a price from business-facts.json is allowed');
d = await dec({ ...good, reply_draft: '2BHK deep cleaning is ₹1,999 today only. When?' });
assert.equal(d.reply, facts.fallback_reply, 'a price NOT in the facts is blocked');
d = await dec({ ...good, reply_draft: 'We guarantee the best price in town. Which area?' });
assert.equal(d.reply, facts.fallback_reply, 'promises are blocked');
d = await dec({ ...good, reply_draft: 'Thanks! '.repeat(30) + 'Which area are you in?' });
assert.ok(d.reply.length <= facts.reply_max_chars, 'long drafts are shortened');

// ---------------------------------------------------------------- WhatsApp: signature + extraction
const sig = code('workflow-lead-intake-whatsapp.json', 'Check Meta signature');
const payload = { object: 'whatsapp_business_account', entry: [{ id: '0', changes: [
  { field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: '1' },
    contacts: [{ wa_id: '10000000002', profile: { name: 'Test Lead' } }],
    messages: [{ from: '10000000002', id: 'wamid.TEST1', timestamp: '1790000000', type: 'text', text: { body: 'Need sofa cleaning' } }] } },
  { field: 'messages', value: { statuses: [{ id: 'wamid.OUT', status: 'delivered', recipient_id: '10000000002' }] } },
] }] };
const raw = Buffer.from(JSON.stringify(payload));
const secret = 'test-secret';
const header = 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');
let [s] = await run(sig, { json: { body: payload, headers: { 'x-hub-signature-256': header } }, env: { WHATSAPP_APP_SECRET: secret }, binary: raw });
assert.equal(s._signature, 'valid');
await assert.rejects(run(sig, { json: { body: payload, headers: { 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) } }, env: { WHATSAPP_APP_SECRET: secret }, binary: raw }), /signature mismatch/);
await assert.rejects(run(sig, { json: { body: payload, headers: {} }, env: { WHATSAPP_APP_SECRET: secret }, binary: raw }), /signature mismatch/);
[s] = await run(sig, { json: { body: payload, headers: {} }, env: {}, binary: raw });
assert.match(s._signature, /not checked/);

const extract = code('workflow-lead-intake-whatsapp.json', 'Extract messages');
const leads = await run(extract, { json: payload });
assert.equal(leads.length, 1, 'status updates are ignored');
assert.deepEqual(leads[0], { source: 'whatsapp', contact: '+10000000002', wa_id: '10000000002', contact_name: 'Test Lead',
  message: 'Need sofa cleaning', received_at: new Date(1790000000 * 1000).toISOString(), external_id: 'wamid.TEST1' });

// ---------------------------------------------------------------- Form validation
const form = code('workflow-lead-intake-form.json', 'Validate form');
let [f] = await run(form, { json: { body: { name: ' Asha ', phone: '+1 (000) 000-0003', message: ' hi ' } } });
assert.equal(f.valid, true); assert.equal(f.lead.contact, '+10000000003'); assert.equal(f.lead.message, 'hi');
[f] = await run(form, { json: { body: { email: 'A@Example.COM', message: 'x' } } });
assert.equal(f.lead.contact, 'a@example.com');
[f] = await run(form, { json: { body: { phone: '123', message: '' } } });
assert.deepEqual(f.errors, ['message is required', 'phone must have 8-15 digits, with country code']);

console.log('Workflow 1 code-node tests passed');
