#!/usr/bin/env node
// MCP smoke for the 26-tool surface over the stdio bridge.
// Read tools tested against the live vault; write tools confined to a sandbox subfolder.
// Run: node scripts/mcp-smoke.mjs   (requires a daemon running on :38473)
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BRIDGE = join(__dirname, '..', 'dist', 'bridge', 'main.js');
const SANDBOX = '_vn_smoke';

const child = spawn(process.execPath, [BRIDGE], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '';
const pending = new Map();
child.stdout.on('data', (b) => {
  buf += b.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const m = JSON.parse(line);
      const cb = pending.get(m.id);
      if (cb) { pending.delete(m.id); cb(m); }
    } catch (e) { /* keep streaming */ }
  }
});

let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout ${method}`)); } }, 30000);
  });
}
const call = (name, args) => rpc('tools/call', { name, arguments: args });
const ok = (r) => !r.error && !r.result?.isError;
const summarize = (r) => {
  if (r.error) return `RPC ERR: ${r.error.message}`;
  const c = r.result?.content?.[0];
  if (r.result?.isError) return `TOOL ERR: ${c?.text?.slice(0, 120) ?? '?'}`;
  return `${c?.type} · ${(c?.text ?? '').length}b`;
};

let pass = 0, fail = 0;
const log = (label, r) => {
  const o = ok(r);
  console.log(`${o ? '✓' : '✗'} ${label.padEnd(36)} ${summarize(r)}`);
  if (o) pass++; else fail++;
};

(async () => {
  try {
    await rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'vn-smoke', version: '0' },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

    const list = await rpc('tools/list');
    const names = (list.result?.tools ?? []).map((t) => t.name);
    console.log(`tools/list → ${names.length} tools`);

    // READ
    log('vaultnexus_ping',           await call('vaultnexus_ping', {}));
    log('vaultnexus_list',           await call('vaultnexus_list', {}));
    log('vaultnexus_stats',          await call('vaultnexus_stats', {}));
    log('vaultnexus_tags',           await call('vaultnexus_tags', { limit: 5 }));
    log('vaultnexus_recent',         await call('vaultnexus_recent', { limit: 3 }));
    log('vaultnexus_orphans',        await call('vaultnexus_orphans', {}));
    log('vaultnexus_search',         await call('vaultnexus_search', { query: 'a', k: 2 }));
    log('vaultnexus_bridges',        await call('vaultnexus_bridges', { topN: 2 }));

    const listR = await call('vaultnexus_list', {});
    const listed = JSON.parse(listR.result.content[0].text);
    const firstNote = listed.notes?.[0] ?? null;
    if (firstNote) {
      log('vaultnexus_read_page',  await call('vaultnexus_read_page', { notePath: firstNote, byteStart: 0, byteEnd: 200 }));
      log('vaultnexus_outline',    await call('vaultnexus_outline', { notePath: firstNote }));
      log('vaultnexus_link_graph', await call('vaultnexus_link_graph', { notePath: firstNote }));
      log('vaultnexus_neighbors',  await call('vaultnexus_neighbors', { notePath: firstNote, k: 3 }));
    } else {
      console.log('  (no top-level note → read/outline/link_graph/neighbors skipped)');
    }

    // WRITE — confined to SANDBOX/
    log('create_folder',            await call('vaultnexus_create_folder', { folderPath: SANDBOX }));
    log('create_page',              await call('vaultnexus_create_page', { notePath: `${SANDBOX}/hello.md`, content: '# hello\n\nworld\n' }));
    log('append_to_page',           await call('vaultnexus_append_to_page', { notePath: `${SANDBOX}/hello.md`, text: '\n## extras\n\nappended.\n' }));
    log('insert_after_heading',     await call('vaultnexus_insert_after_heading', { notePath: `${SANDBOX}/hello.md`, heading: 'extras', insertion: 'inserted line.' }));
    log('replace_in_page',          await call('vaultnexus_replace_in_page', { notePath: `${SANDBOX}/hello.md`, find: 'world', replace: 'WORLD' }));
    log('copy_page',                await call('vaultnexus_copy_page', { from: `${SANDBOX}/hello.md`, to: `${SANDBOX}/hello-copy.md` }));
    log('move',                     await call('vaultnexus_move', { from: `${SANDBOX}/hello-copy.md`, to: `${SANDBOX}/hello-moved.md` }));
    log('delete_page',              await call('vaultnexus_delete_page', { notePath: `${SANDBOX}/hello-moved.md` }));
    log('delete_page#2',            await call('vaultnexus_delete_page', { notePath: `${SANDBOX}/hello.md` }));
    log('delete_folder',            await call('vaultnexus_delete_folder', { folderPath: SANDBOX }));

    // HISTORY + FORECASTS — no-op on non-git note + empty ledger ok
    log('history',                  await call('vaultnexus_history', { notePath: 'nonexistent.md', maxRevisions: 3 }));
    log('recall_history',           await call('vaultnexus_recall_history', { notePath: 'nonexistent.md' }));
    log('forecasts',                await call('vaultnexus_forecasts', {}));

    // REASONING
    log('trace',                    await call('vaultnexus_trace', { question: 'hello world', maxHops: 1 }));
    log('reason',                   await call('vaultnexus_reason', { question: 'summarize' }));

    console.log(`\n${fail === 0 ? '✓ all checks passed' : `✗ ${fail} failure(s)`} · ${pass} pass`);
  } catch (e) {
    console.error('FATAL:', e.message);
    process.exitCode = 1;
  } finally {
    child.stdin.end();
    setTimeout(() => process.exit(fail === 0 ? 0 : 1), 500);
  }
})();
