// Runs the real "Build signature" Code node from the exported workflow against fake
// Error Trigger payloads. No n8n needed:  node workflows/00-error-handling/test/signature.test.mjs
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const wf = JSON.parse(readFileSync(new URL('../workflow-error-handler.json', import.meta.url)));
const code = wf.nodes.find((n) => n.name === 'Build signature').parameters.jsCode;
const run = (payload) => new Function('$input', code)({ first: () => ({ json: payload }) })[0].json;

const fail = (message, node = 'Call payment API (simulated)') => ({
  execution: { id: '42', url: 'http://localhost:5678/workflow/w1/executions/42', error: { message }, lastNodeExecuted: node, mode: 'webhook' },
  workflow: { id: 'w1', name: 'Test' },
});

// Same bug, different ids/numbers/timestamps -> same signature
const a = run(fail('Payment API timed out for order 4812 after 3021ms'));
const b = run(fail('Payment API timed out for order 77 after 3950ms'));
assert.equal(a.signature, b.signature);
assert.equal(a.signature, 'w1 | Call payment API (simulated) | payment api timed out for order <n> after <n>ms');
assert.equal(
  run(fail('Row 9f1c2e4a-1b2c-4d3e-8f90-123456789abc missing at 2026-09-28T10:00:00.123Z')).signature,
  run(fail('Row 00000000-1111-4222-8333-444444444444 missing at 2026-01-01T00:00:00Z')).signature,
);
assert.equal(run(fail('GET https://api.x.com/v1/u/5 failed for a@b.co')).signature.split(' | ')[2], 'get <url> failed for <email>');

// Different node or different workflow -> different signature
assert.notEqual(a.signature, run(fail('Payment API timed out for order 1 after 1ms', 'Other node')).signature);

// Raw message and execution link are kept for the alert
assert.equal(a.error_message, 'Payment API timed out for order 4812 after 3021ms');
assert.equal(a.execution_url, 'http://localhost:5678/workflow/w1/executions/42');

// Trigger-node failure: no execution block, must not throw
const t = run({ trigger: { error: { message: 'Bad credentials', node: { name: 'Gmail Trigger' }, timestamp: 1654609328787 }, mode: 'trigger' }, workflow: { id: 'w2', name: 'Inbox' } });
assert.equal(t.failed_node, 'Gmail Trigger');
assert.equal(t.execution_id, null);
assert.equal(t.error_at, '2022-06-07T13:42:08.787Z');

// Garbage in -> still a row, never a throw
assert.equal(run({}).workflow_name, 'unknown workflow');

console.log('signature tests passed');
