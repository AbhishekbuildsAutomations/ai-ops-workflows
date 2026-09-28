#!/usr/bin/env node
// Builds workflows/<folder>/flow.html for every workflow folder, and docs/index.html.
// No dependencies: node scripts/build-flow-html.mjs
//
// Everything on the page is derived, so it can't drift from the real workflow:
//   diagram + steps  <- the workflow JSON (nodes, connections, node notes, settings)
//   summary + tests  <- the folder README ("## Problem", "## What it does", "## How to test")
//   status           <- the root README table
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MERMAID = 'https://cdn.jsdelivr.net/npm/mermaid@12/dist/mermaid.esm.min.mjs';

// ---------------------------------------------------------------- helpers
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const isSticky = (n) => n.type === 'n8n-nodes-base.stickyNote';
const isTrigger = (n) => /trigger$/i.test(n.type) || n.type === 'n8n-nodes-base.webhook';
const shortType = (t) => t.split('.').pop();

/** "Postgres: run query", not "n8n-nodes-base.postgres" */
export function plainType(n) {
  const p = n.parameters ?? {};
  const t = shortType(n.type);
  switch (t) {
    case 'errorTrigger': return 'Error Trigger: runs when a linked workflow fails';
    case 'scheduleTrigger': {
      const i = p.rule?.interval?.[0] ?? {};
      return i.field === 'cronExpression' ? `Schedule: cron ${i.expression}` : `Schedule: every ${i.field ?? 'interval'}`;
    }
    case 'manualTrigger': return 'Manual trigger: runs when you click Execute';
    case 'webhook': return `Webhook: ${p.httpMethod ?? 'GET'} /webhook/${p.path ?? ''}`;
    case 'code': return 'Code: JavaScript';
    case 'postgres': return `Postgres: ${p.operation === 'executeQuery' || !p.operation ? 'run query' : p.operation}`;
    case 'telegram': return `Telegram: ${p.operation === 'sendMessage' || !p.operation ? 'send message' : p.operation}`;
    case 'if': return 'IF: branch on a condition';
    case 'switch': return 'Switch: route by value';
    case 'googleSheets': return `Google Sheets: ${p.operation ?? 'read'} row`;
    case 'stopAndError': return 'Stop and Error: fail the run on purpose';
    case 'httpRequest': return `HTTP Request: ${p.method ?? 'GET'}`;
    case 'respondToWebhook': return 'Respond to Webhook: send the HTTP reply';
    case 'set': return 'Edit Fields: set values';
    case 'merge': return 'Merge: combine branches';
    case 'wait': return 'Wait';
    case 'executeWorkflow': return 'Execute Workflow: call a sub-workflow';
    case 'executeWorkflowTrigger': return 'Sub-workflow trigger: runs when called';
    default: return t.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
  }
}

/** What happens when this node fails, from its settings and the workflow's error workflow. */
export function onFailure(n, wf) {
  if (n.type === 'n8n-nodes-base.errorTrigger') return 'n/a (entry point)';
  const parts = [];
  if (n.retryOnFail) parts.push(`retries up to ${n.maxTries ?? 3}× (${(n.waitBetweenTries ?? 1000) / 1000}s apart)`);
  if (n.onError === 'continueRegularOutput') parts.push('then continues; the error is passed on as data');
  else if (n.onError === 'continueErrorOutput') parts.push('then continues on the error output');
  else if (wf.settings?.errorWorkflow) parts.push(`then stops the run → error workflow runs`);
  else if (wf.nodes.some((x) => x.type === 'n8n-nodes-base.errorTrigger')) parts.push('then stops the run (this is the error handler; n8n does not re-run it on itself)');
  else parts.push('then stops the run (no error workflow set!)');
  return parts.join(', ').replace(/^then /, '').replace(/^./, (c) => c.toUpperCase());
}

/** Depth-first from each trigger, following outputs in order: the order n8n v1 runs branches. */
export function executionOrder(wf) {
  const nodes = wf.nodes.filter((n) => !isSticky(n));
  const byName = Object.fromEntries(nodes.map((n) => [n.name, n]));
  const seen = new Set(); const out = [];
  const visit = (name) => {
    if (seen.has(name) || !byName[name]) return;
    seen.add(name); out.push(byName[name]);
    for (const branch of wf.connections[name]?.main ?? []) for (const c of branch ?? []) visit(c.node);
  };
  nodes.filter(isTrigger).sort((a, b) => a.position[1] - b.position[1]).forEach((t) => visit(t.name));
  nodes.forEach((n) => visit(n.name)); // anything unreachable still gets listed
  return out;
}

export function mermaidFor(wf) {
  const nodes = wf.nodes.filter((n) => !isSticky(n));
  const id = Object.fromEntries(nodes.map((n, i) => [n.name, `n${i}`]));
  const label = (s) => `"${String(s).replace(/"/g, '#quot;')}"`;
  const lines = ['flowchart TD'];
  for (const n of nodes) {
    const t = shortType(n.type); const L = label(n.name);
    lines.push(`  ${id[n.name]}${isTrigger(n) ? `([${L}])` : t === 'if' || t === 'switch' ? `{${L}}` : t === 'postgres' ? `[(${L})]` : `[${L}]`}`);
  }
  for (const [from, outs] of Object.entries(wf.connections)) {
    if (!id[from]) continue;
    const src = nodes.find((n) => n.name === from);
    (outs.main ?? []).forEach((branch, i) => (branch ?? []).forEach((c) => {
      if (!id[c.node]) return;
      let tag = '';
      if (shortType(src.type) === 'if') tag = i === 0 ? 'true' : 'false';
      else if (src.onError === 'continueErrorOutput' && i === (outs.main.length - 1)) tag = 'error';
      lines.push(`  ${id[from]} -->${tag ? `|${tag}|` : ''} ${id[c.node]}`);
    }));
  }
  lines.push('  classDef trig fill:#e8f1ff,stroke:#3b6fd8,color:#0b2a66');
  const trig = nodes.filter(isTrigger).map((n) => id[n.name]);
  if (trig.length) lines.push(`  class ${trig.join(',')} trig`);
  return lines.join('\n');
}

/** Tables, sheets and CRM objects a workflow reads or writes. */
export function dataStores(wf) {
  const w = new Set(); const r = new Set();
  for (const n of wf.nodes) {
    const p = n.parameters ?? {}; const t = shortType(n.type);
    if (t === 'postgres') {
      const q = String(p.query ?? '').replace(/--.*$/gm, '');   // comments mention words like "from"
      for (const m of q.matchAll(/\b(?:insert\s+into|update(?!\s+set\b)|delete\s+from)\s+([a-z_][\w.]*)/gi)) w.add(`Postgres table \`${m[1]}\``);
      for (const m of q.matchAll(/\b(?:from|join)\s+([a-z_][\w.]*)/gi)) if (!/^(prev|w|t|excluded)$/i.test(m[1])) r.add(`Postgres table \`${m[1]}\``);
      if (p.table) w.add(`Postgres table \`${p.table.value ?? p.table}\``);
    }
    if (t === 'googleSheets') w.add(`Google Sheet (tab \`${p.sheetName?.value ?? '?'}\`, id from \`${String(p.documentId?.value ?? '').replace(/^=\{\{\s*|\s*\}\}$/g, '')}\`)`);
    if (t === 'httpRequest') {
      const u = String(p.url ?? '');
      const hs = u.match(/\/crm\/(?:v\d+|[\d-]+)\/objects\/(\w+)/); if (hs) w.add(`HubSpot ${hs[1]}`);
      if (/graph\.facebook\.com/.test(u)) w.add('WhatsApp message (Graph API)');
    }
    if (t === 'telegram') w.add('Telegram chat `$env.TELEGRAM_CHAT_ID`');
  }
  for (const x of w) r.delete(x);
  return { writes: [...w], reads: [...r] };
}

export function envAndCreds(wf) {
  const json = JSON.stringify(wf);
  const env = [...new Set([...json.matchAll(/\$env\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]))].sort();
  const creds = new Map();
  for (const n of wf.nodes) for (const [type, c] of Object.entries(n.credentials ?? {})) creds.set(c.name, type);
  return { env, creds: [...creds].map(([name, type]) => ({ name, type })) };
}

// ---------------------------------------------------------------- tiny markdown (README sections only)
export function section(md, heading) {
  const m = md.match(new RegExp(`^## ${heading}\\s*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm'));
  return m ? m[1].trim() : '';
}
const inline = (s) => esc(s)
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) => `<a href="${u}">${t}</a>`);
export function md2html(md) {
  const out = []; const lines = md.split('\n'); let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith('```')) { const b = []; i++; while (i < lines.length && !lines[i].startsWith('```')) b.push(lines[i++]); i++; out.push(`<pre><code>${esc(b.join('\n'))}</code></pre>`); continue; }
    if (/^\s*([-*]|\d+\.)\s/.test(l)) { const tag = /^\s*\d/.test(l) ? 'ol' : 'ul'; const b = []; while (i < lines.length && /^\s*([-*]|\d+\.)\s/.test(lines[i])) b.push(`<li>${inline(lines[i++].replace(/^\s*([-*]|\d+\.)\s/, ''))}</li>`); out.push(`<${tag}>${b.join('')}</${tag}>`); continue; }
    if (/^###\s/.test(l)) { out.push(`<h4>${inline(l.replace(/^###\s/, ''))}</h4>`); i++; continue; }
    if (!l.trim()) { i++; continue; }
    const b = []; while (i < lines.length && lines[i].trim() && !/^(```|###\s|\s*([-*]|\d+\.)\s)/.test(lines[i])) b.push(lines[i++]);
    out.push(`<p>${inline(b.join(' '))}</p>`);
  }
  return out.join('\n');
}
const firstParagraph = (md) => md.split(/\n\s*\n/)[0].replace(/\n/g, ' ').trim();

// ---------------------------------------------------------------- status from the root README table
export function statusFor(folder) {
  const md = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const rows = md.split('\n').filter((l) => l.startsWith('|'));
  const head = rows[0]?.split('|').map((c) => c.trim().toLowerCase()) ?? [];
  const row = rows.find((l) => l.includes(`](workflows/${folder}/`));
  return row ? row.split('|').map((c) => c.trim())[head.indexOf('status')] ?? '' : '';
}

// ---------------------------------------------------------------- page
const CSS = `
:root{--bg:#fbfbfa;--fg:#1d1d1f;--muted:#5d5d63;--line:#dcdcdf;--card:#fff;--accent:#2f5fd0;--code:#f1f1f3;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#141417;--fg:#ececef;--muted:#a3a3ad;--line:#34343a;--card:#1c1c20;--accent:#8fb0ff;--code:#26262c}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;overflow-wrap:anywhere}
main{max-width:980px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:1.75rem;line-height:1.25;margin:.2em 0 .3em}h2{font-size:1.35rem;margin:2.2em 0 .6em;padding-top:.6em;border-top:1px solid var(--line)}h3{font-size:1.1rem;margin:1.6em 0 .5em}h4{margin:1.2em 0 .3em}
a{color:var(--accent)}code{background:var(--code);padding:.1em .35em;border-radius:4px;font-size:.92em}
pre{background:var(--code);padding:12px 14px;border-radius:8px;overflow-x:auto;max-width:100%;font-size:14px;line-height:1.5}pre code{background:none;padding:0;white-space:pre}
.meta{color:var(--muted)}.badge{display:inline-block;padding:.1em .6em;border:1px solid var(--line);border-radius:99px;font-size:.9rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:12px 0}
.diagram{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px;text-align:center;overflow-x:auto}
.diagram svg{max-width:none!important;height:auto} /* natural size; a wide diagram scrolls inside its box, never the page */
table{width:100%;border-collapse:collapse;font-size:15px}th,td{text-align:left;vertical-align:top;padding:8px 10px;border-bottom:1px solid var(--line)}th{color:var(--muted);font-weight:600}
td.n{color:var(--muted);width:2.2em}
@media (max-width:700px){table,thead,tbody,tr,th,td{display:block}thead{display:none}tr{background:var(--card);border:1px solid var(--line);border-radius:10px;margin:10px 0;padding:6px 4px}td{border:0;padding:4px 10px}td::before{content:attr(data-label);display:block;color:var(--muted);font-size:.85rem;font-weight:600}td.n{width:auto}}
ul{padding-left:1.3em}`;

const page = (title, body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style></head>
<body><main>
${body}
</main>
<script type="module">
import mermaid from '${MERMAID}';
const dark = matchMedia('(prefers-color-scheme: dark)').matches;
mermaid.initialize({ startOnLoad: true, theme: dark ? 'dark' : 'default', securityLevel: 'strict', flowchart: { useMaxWidth: false, htmlLabels: true, wrappingWidth: 180 } });
</script>
</body></html>
`;

export function renderFolder(folder) {
  const dir = join(ROOT, 'workflows', folder);
  const readme = existsSync(join(dir, 'README.md')) ? readFileSync(join(dir, 'README.md'), 'utf8') : '';
  const title = (readme.match(/^# (.+)$/m)?.[1] ?? folder).trim();
  const files = readdirSync(dir).filter((f) => /^workflow-.*\.json$/.test(f)).sort();
  const workflows = files.map((f) => ({ file: f, wf: JSON.parse(readFileSync(join(dir, f), 'utf8')) }));
  const warnings = [];
  const sections = workflows.map(({ file, wf }) => {
    const order = executionOrder(wf);
    const { writes, reads } = dataStores(wf);
    const { env, creds } = envAndCreds(wf);
    const rows = order.map((n, i) => {
      if (!n.notes) warnings.push(`${folder}/${file}: node "${n.name}" has no notes`);
      return `<tr><td class="n" data-label="#">${i + 1}</td><td data-label="Node"><strong>${esc(n.name)}</strong></td><td data-label="Type">${esc(plainType(n))}</td><td data-label="What it does">${esc(n.notes ?? '')}</td><td data-label="On failure">${esc(onFailure(n, wf))}</td></tr>`;
    }).join('\n');
    const list = (xs) => (xs.length ? `<ul>${xs.map((x) => `<li>${inline(x)}</li>`).join('')}</ul>` : '<p class="meta">none</p>');
    return `<h2>${esc(wf.name)}</h2>
<p class="meta"><code>${esc(file)}</code>${wf.settings?.timezone ? ` · timezone <code>${esc(wf.settings.timezone)}</code>` : ''}${wf.settings?.errorWorkflow ? ` · error workflow <code>${esc(wf.settings.errorWorkflow)}</code>` : ''}</p>
<div class="diagram"><pre class="mermaid">${esc(mermaidFor(wf))}</pre></div>
<h3>Steps, in execution order</h3>
<table><thead><tr><th>#</th><th>Node</th><th>Type</th><th>What it does</th><th>On failure</th></tr></thead><tbody>
${rows}
</tbody></table>
<h3>Where data lives</h3>
<div class="card"><strong>Writes</strong>${list(writes)}<strong>Reads</strong>${list(reads)}</div>
<h3>Configuration (names only)</h3>
<div class="card"><strong>Env vars</strong>${list(env.map((e) => `\`${e}\``))}<strong>n8n credentials</strong>${list(creds.map((c) => `${c.name} (\`${c.type}\`)`))}</div>`;
  });
  const status = statusFor(folder);
  const summary = [firstParagraph(section(readme, 'Problem')), firstParagraph(section(readme, 'What it does'))].filter(Boolean);
  const html = page(`${title} · flow`, `<p class="meta"><a href="../../docs/index.html">All workflows</a> · <a href="README.md">README</a></p>
<h1>${esc(title)}</h1>
${status ? `<p><span class="badge">${esc(status)}</span></p>` : ''}
${summary.map((p) => `<p>${inline(p)}</p>`).join('\n')}
${sections.join('\n')}
<h2>How to test</h2>
${md2html(section(readme, 'How to test'))}
<p class="meta">Generated by <code>scripts/build-flow-html.mjs</code> from the workflow JSON and README. Do not edit by hand.</p>`);
  return { html, workflows, warnings, title, status };
}

export function folders() {
  return readdirSync(join(ROOT, 'workflows'), { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d\d-/.test(d.name)).map((d) => d.name).sort();
}

export function renderIndex(items) {
  const rows = items.map((x) => `<tr><td data-label="Workflow"><a href="../workflows/${x.folder}/flow.html"><strong>${esc(x.title)}</strong></a></td><td data-label="Status">${esc(x.status)}</td><td data-label="Workflows">${x.workflows.map((w) => esc(w.wf.name)).join('<br>')}</td></tr>`).join('\n');
  return page('ai-ops-workflows · flows', `<h1>ai-ops-workflows</h1>
<p>n8n workflows that solve problems from AI-automation job posts. Each page below is generated from the workflow JSON, so the diagram is the real workflow.</p>
<table><thead><tr><th>Workflow</th><th>Status</th><th>n8n workflows</th></tr></thead><tbody>
${rows}
</tbody></table>
<p class="meta">Generated by <code>scripts/build-flow-html.mjs</code>.</p>`).replace(/<script type="module">[\s\S]*?<\/script>\n/, '');
}

// ---------------------------------------------------------------- main
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const items = [];
  for (const folder of folders()) {
    const r = renderFolder(folder);
    writeFileSync(join(ROOT, 'workflows', folder, 'flow.html'), r.html);
    r.warnings.forEach((w) => console.warn('warn:', w));
    console.log(`workflows/${folder}/flow.html`);
    items.push({ folder, ...r });
  }
  writeFileSync(join(ROOT, 'docs', 'index.html'), renderIndex(items));
  console.log('docs/index.html');
}
