#!/usr/bin/env node
// Manual MCP smoke over the stdio bridge → daemon.
// Run: node scripts/mcp-smoke.mjs   (requires a daemon running on :38473)
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BRIDGE = join(__dirname, '..', 'dist', 'bridge', 'main.js');

const child = spawn(process.execPath, [BRIDGE], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '';
const pending = new Map();

child.stdout.on('data', (b) => {
  buf += b.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      const cb = pending.get(msg.id);
      if (cb) { pending.delete(msg.id); cb(msg); }
    } catch (e) {
      console.error('parse err:', e.message, line.slice(0, 200));
    }
  }
});

let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout ${method}`)); } }, 15000);
  });
}

function show(label, ok, detail) {
  const mark = ok ? '✓' : '✗';
  console.log(`${mark} ${label.padEnd(40)} ${detail ?? ''}`);
}

const summarize = (r) => {
  if (r.error) return `ERROR: ${r.error.message ?? JSON.stringify(r.error).slice(0, 100)}`;
  const c = r.result?.content?.[0];
  if (!c) return 'no content';
  if (r.result?.isError) return `TOOL ERROR: ${c.text?.slice(0, 120) ?? '?'}`;
  return `${c.type} · ${(c.text ?? '').length}b`;
};
const ok = (r) => !r.error && !r.result?.isError;

let failures = 0;
function tally(b) { if (!b) failures += 1; }

(async () => {
  try {
    const init = await rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'vn-smoke', version: '0' },
    });
    tally(!!init.result);
    show('initialize', !!init.result, `server=${init.result?.serverInfo?.name}`);

    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

    const tools = await rpc('tools/list');
    const names = (tools.result?.tools ?? []).map((t) => t.name);
    tally(names.length === 8);
    show('tools/list', names.length === 8, `(${names.length}) ${names.join(', ')}`);

    const callTool = (name, args) => rpc('tools/call', { name, arguments: args });

    const ping = await callTool('vaultnexus_ping', {});
    tally(ok(ping)); show('vaultnexus_ping', ok(ping), summarize(ping));

    const search = await callTool('vaultnexus_search', { query: 'index', k: 3 });
    tally(ok(search)); show('vaultnexus_search', ok(search), summarize(search));

    const bridges = await callTool('vaultnexus_bridges', { topN: 3 });
    tally(ok(bridges)); show('vaultnexus_bridges', ok(bridges), summarize(bridges));

    const trace = await callTool('vaultnexus_trace', { question: 'what is this vault about?' });
    tally(ok(trace)); show('vaultnexus_trace', ok(trace), summarize(trace));

    const reason = await callTool('vaultnexus_reason', { question: 'summarize key themes' });
    tally(ok(reason)); show('vaultnexus_reason', ok(reason), summarize(reason));

    const hist = await callTool('vaultnexus_history', { notePath: 'nonexistent.md', maxRevisions: 3 });
    tally(ok(hist)); show('vaultnexus_history', ok(hist), summarize(hist));

    const rh = await callTool('vaultnexus_recall_history', { notePath: 'nonexistent.md' });
    tally(ok(rh)); show('vaultnexus_recall_history', ok(rh), summarize(rh));

    const fc = await callTool('vaultnexus_forecasts', {});
    tally(ok(fc)); show('vaultnexus_forecasts', ok(fc), summarize(fc));

    console.log(`\n${failures === 0 ? '✓ all checks passed' : `✗ ${failures} failure(s)`}`);
  } catch (e) {
    console.error('FATAL:', e.message);
    process.exitCode = 1;
  } finally {
    child.stdin.end();
    setTimeout(() => process.exit(failures === 0 ? 0 : 1), 500);
  }
})();
