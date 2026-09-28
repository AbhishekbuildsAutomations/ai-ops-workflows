// Fails if any workflow node is missing from its flow.html diagram or steps table,
// or if a committed flow.html is stale.   node scripts/build-flow-html.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { folders, renderFolder, mermaidFor } from './build-flow-html.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
let checked = 0;

for (const folder of folders()) {
  const { html, workflows } = renderFolder(folder);
  assert.ok(workflows.length, `${folder}: no workflow-*.json files`);
  for (const { file, wf } of workflows) {
    const diagram = mermaidFor(wf);
    for (const n of wf.nodes.filter((x) => x.type !== 'n8n-nodes-base.stickyNote')) {
      assert.ok(diagram.includes(`"${n.name.replace(/"/g, '#quot;')}"`), `${folder}/${file}: "${n.name}" missing from diagram`);
      assert.ok(html.includes(`<td data-label="Node"><strong>${esc(n.name)}</strong></td>`), `${folder}/${file}: "${n.name}" missing from steps table`);
      checked++;
    }
    for (const [from, outs] of Object.entries(wf.connections))
      for (const branch of outs.main ?? []) for (const c of branch ?? [])
        assert.ok(wf.nodes.some((n) => n.name === c.node), `${folder}/${file}: connection ${from} -> ${c.node} points at no node`);
  }
  const onDisk = readFileSync(join(ROOT, 'workflows', folder, 'flow.html'), 'utf8');
  assert.equal(onDisk, html, `${folder}/flow.html is stale: run node scripts/build-flow-html.mjs`);
}
console.log(`flow.html tests passed (${checked} nodes checked)`);
