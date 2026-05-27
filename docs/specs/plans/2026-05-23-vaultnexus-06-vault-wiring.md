# VaultNexus Plan 06 — Vault Indexing + Daemon Wiring (real end-to-end retrieval)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** Point the daemon at a real vault directory: walk its `.md` files, build a `VaultIndex` at startup, and serve `vaultnexus_search` over it end-to-end (Claude Code → bridge → daemon → real hits from real files). Embedder selected from env (offline `FakeEmbedder` default; OpenAI-compatible when configured).

**Architecture:** `indexer.ts` walks a vault dir (skipping dotfiles/`.obsidian`/`.git`) and feeds each note to `VaultIndex.addNote`. `select-embedder.ts` picks the provider from env. `main.ts` builds one shared index at startup, indexes the configured vault before signalling readiness, and passes the index to `createMcpServer` per connection. No vault configured → ping-only (Plan 01 behavior preserved).

**Tech Stack:** TS ESM/NodeNext, Node 22, vitest. Reuses Plans 02–05. `node:fs/promises` for the walk; undici MockAgent for the embedder-selection test.

**Scope note:** Plan 06 of the sequence. Delivers real-vault end-to-end vector retrieval. NOT: on-disk persistence/mmap (re-index on startup for now), FTS5 keyword + fusion, two-lane router/diversity, file-watching/incremental reindex, background indexing (index synchronously before readiness — fine for MLP-scale vaults). Builds on master (Plans 01–05).

**TOOLCHAIN:** every command under `export PATH=/opt/homebrew/opt/node@22/bin:$PATH`. Authoritative `pnpm typecheck`. Commits dev, no AI attribution. Branch `feat/vault-wiring` off master.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/daemon/indexer.ts` | `walkMarkdown(dir)`, `indexVault(dir, index)` |
| `src/daemon/select-embedder.ts` | `selectEmbedder(env)` — provider from env (Fake default) |
| `src/daemon/main.ts` (modify) | build shared index + index vault at startup, inject into `createMcpServer` |
| `test/**` | walk/index over a temp vault, embedder selection, full e2e over a temp vault |

---

## Task 1: `indexer` — walk + index a vault directory

**Files:** Create `src/daemon/indexer.ts`; Test `test/daemon/indexer.test.ts`

- [ ] **Step 1: Write the failing test**
```typescript
// test/daemon/indexer.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { walkMarkdown, indexVault } from '../../src/daemon/indexer.js';
import { VaultIndex } from '../../src/daemon/vault-index.js';
import { FakeEmbedder } from '../../src/core/embedder.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vn-vault-'));
  await writeFile(join(dir, 'a.md'), '# A\n\nalpha content here\n');
  await mkdir(join(dir, 'sub'));
  await writeFile(join(dir, 'sub', 'b.md'), '# B\n\nbeta content here\n');
  await mkdir(join(dir, '.obsidian'));
  await writeFile(join(dir, '.obsidian', 'config.md'), 'should be skipped\n');
  await writeFile(join(dir, 'notes.txt'), 'not markdown\n');
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('indexer', () => {
  it('walks .md files recursively, skipping dotdirs and non-md', async () => {
    const files = await walkMarkdown(dir);
    const rels = files.map((f) => f.replace(dir, '').replace(/^[/\\]/, ''));
    expect(rels.sort()).toEqual(['a.md', join('sub', 'b.md')].sort());
  });
  it('indexes every note into a VaultIndex (relative paths)', async () => {
    const idx = new VaultIndex(new FakeEmbedder(64));
    const n = await indexVault(dir, idx);
    expect(n).toBe(2);
    const hits = await idx.query('beta content here', 3);
    expect(hits[0].notePath).toBe(join('sub', 'b.md'));
    expect(hits[0].text).toContain('beta content here');
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement**
```typescript
// src/daemon/indexer.ts
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, extname } from 'node:path';
import type { VaultIndex } from './vault-index.js';

/** Absolute paths of .md files under dir, recursive; skips dotfiles/dotdirs (.git, .obsidian). */
export async function walkMarkdown(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function rec(d: string): Promise<void> {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) await rec(p);
      else if (e.isFile() && extname(e.name).toLowerCase() === '.md') out.push(p);
    }
  }
  await rec(dir);
  return out.sort();
}

/** Index every .md note under dir into the VaultIndex (notePath = path relative to dir). Returns count. */
export async function indexVault(dir: string, index: VaultIndex): Promise<number> {
  const files = await walkMarkdown(dir);
  for (const abs of files) {
    const source = await readFile(abs, 'utf8');
    await index.addNote(relative(dir, abs), source);
  }
  return files.length;
}
```

- [ ] **Step 4: Run → PASS** (2). `pnpm typecheck` → 0.

- [ ] **Step 5: Commit**
```bash
git add src/daemon/indexer.ts test/daemon/indexer.test.ts
git commit -m "feat(daemon): vault directory walk + index"
```

---

## Task 2: `selectEmbedder` — provider from env (Fake default)

**Files:** Create `src/daemon/select-embedder.ts`; Test `test/daemon/select-embedder.test.ts`

- [ ] **Step 1: Write the failing test**
```typescript
// test/daemon/select-embedder.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from 'undici';
import { selectEmbedder } from '../../src/daemon/select-embedder.js';
import { FakeEmbedder } from '../../src/core/embedder.js';
import { OpenAIEmbedder } from '../../src/daemon/openai-embedder.js';

let prev: Dispatcher; let mock: MockAgent;
beforeEach(() => { prev = getGlobalDispatcher(); mock = new MockAgent(); mock.disableNetConnect(); setGlobalDispatcher(mock); });
afterEach(() => { setGlobalDispatcher(prev); });

describe('selectEmbedder', () => {
  it('defaults to FakeEmbedder when no embed env is set', async () => {
    const e = await selectEmbedder({});
    expect(e).toBeInstanceOf(FakeEmbedder);
    expect(e.dimensions).toBeGreaterThan(0);
  });
  it('honors VAULTNEXUS_FAKE_DIMS', async () => {
    const e = await selectEmbedder({ VAULTNEXUS_FAKE_DIMS: '128' });
    expect(e.dimensions).toBe(128);
  });
  it('builds an OpenAIEmbedder and probes dims when embed env is set', async () => {
    mock.get('https://api.example.com').intercept({ path: '/v1/embeddings', method: 'POST' })
      .reply(200, { data: [{ index: 0, embedding: [0, 1, 2, 3] }] });
    const e = await selectEmbedder({
      VAULTNEXUS_EMBED_URL: 'https://api.example.com/v1',
      VAULTNEXUS_EMBED_KEY: 'k', VAULTNEXUS_EMBED_MODEL: 'm',
    });
    expect(e).toBeInstanceOf(OpenAIEmbedder);
    expect(e.dimensions).toBe(4); // probed
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement**
```typescript
// src/daemon/select-embedder.ts
import { FakeEmbedder, type Embedder } from '../core/embedder.js';
import { OpenAIEmbedder } from './openai-embedder.js';

type Env = Record<string, string | undefined>;

/** Pick the embedder from env: OpenAI-compatible if URL+KEY+MODEL set, else offline FakeEmbedder. */
export async function selectEmbedder(env: Env = process.env): Promise<Embedder> {
  const baseURL = env.VAULTNEXUS_EMBED_URL;
  const apiKey = env.VAULTNEXUS_EMBED_KEY;
  const model = env.VAULTNEXUS_EMBED_MODEL;
  if (baseURL && apiKey && model) {
    const e = new OpenAIEmbedder({ baseURL, apiKey, model });
    await e.probe(); // set true dimension
    return e;
  }
  const dims = Number(env.VAULTNEXUS_FAKE_DIMS ?? 256);
  return new FakeEmbedder(Number.isFinite(dims) && dims > 0 ? dims : 256);
}
```

- [ ] **Step 4: Run → PASS** (3). `pnpm typecheck` → 0.

- [ ] **Step 5: Commit**
```bash
git add src/daemon/select-embedder.ts test/daemon/select-embedder.test.ts
git commit -m "feat(daemon): env-based embedder selection (Fake default)"
```

---

## Task 3: wire the vault index into the daemon + full e2e

**Files:** Modify `src/daemon/main.ts`; Test `test/daemon/vault-e2e.test.ts`

`main.ts` builds one shared `VaultIndex` at startup; if `VAULTNEXUS_VAULT` is set, indexes it (synchronously, before `VAULTNEXUS_READY`); passes the index to `createMcpServer({ index })` per connection. No vault → no index → ping-only (Plan 01 e2e preserved).

- [ ] **Step 1: Write the failing e2e test**
```typescript
// test/daemon/vault-e2e.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const sock = join(tmpdir(), `vn-vault-e2e-${process.pid}.sock`);
const lock = join(tmpdir(), `vn-vault-e2e-${process.pid}.lock`);
let daemon: ChildProcess | undefined; let vault: string;

beforeEach(async () => {
  vault = await mkdtemp(join(tmpdir(), 'vn-e2e-vault-'));
  await writeFile(join(vault, 'fox.md'), '# Animals\n\nthe quick brown fox jumps\n');
  await writeFile(join(vault, 'sea.md'), '# Ocean\n\nblue whales sing deep songs\n');
  const env = { ...process.env, VAULTNEXUS_SOCKET: sock, VAULTNEXUS_LOCK: lock, VAULTNEXUS_HTTP_PORT: '38475', VAULTNEXUS_VAULT: vault };
  daemon = spawn(process.execPath, ['--import', 'tsx', 'src/daemon/main.ts'], { env });
  await new Promise<void>((resolve, reject) => {
    let buf = '';
    daemon!.stderr!.on('data', (d: Buffer) => { buf += d.toString(); if (buf.includes('VAULTNEXUS_READY')) resolve(); });
    daemon!.on('exit', (c) => reject(new Error(`daemon exited: ${c}\n${buf}`)));
  });
});
afterEach(async () => {
  daemon?.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 200));
  for (const p of [sock, lock]) { try { rmSync(p); } catch { /* ignore */ } }
  await rm(vault, { recursive: true, force: true });
});

describe('vault e2e: search a real directory through the bridge', () => {
  it('returns a cited hit from the matching note', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath, args: ['--import', 'tsx', 'src/bridge/main.ts'],
      env: { PATH: process.env.PATH ?? '', VAULTNEXUS_SOCKET: sock },
    });
    const client = new Client({ name: 'e2e', version: '0' });
    await client.connect(transport);
    const res = await client.callTool({ name: 'vaultnexus_search', arguments: { query: 'the quick brown fox jumps', k: 2 } });
    const hits = JSON.parse((res.content as Array<{ type: string; text: string }>)[0].text);
    expect(hits[0].notePath).toBe('fox.md');
    expect(hits[0].text).toContain('quick brown fox');
    await client.close();
  });
});
```

- [ ] **Step 2: Run → FAIL** (search tool not wired / no index).

- [ ] **Step 3: Modify `main.ts`** — build embedder + index, index the vault before readiness, inject per connection. Apply this diff to the existing `main()`:
  - add imports: `import { selectEmbedder } from './select-embedder.js';` `import { VaultIndex } from './vault-index.js';` `import { indexVault } from './indexer.js';`
  - after acquiring the lock and unlinking the stale socket, BEFORE creating the socket server, build the index:
```typescript
  const embedder = await selectEmbedder();
  const index = new VaultIndex(embedder);
  const vaultDir = process.env.VAULTNEXUS_VAULT;
  if (vaultDir) {
    const n = await indexVault(vaultDir, index);
    process.stderr.write(`vaultnexus: indexed ${n} notes from ${vaultDir}\n`);
  }
```
  - change the connection handler from `const mcp = createMcpServer();` to `const mcp = createMcpServer({ index: vaultDir ? index : undefined });`
  - keep everything else (lock, loopback HTTP, shutdown, `VAULTNEXUS_READY` last) identical. Readiness is printed AFTER indexing completes.

- [ ] **Step 4: Run → PASS.** `pnpm vitest run test/daemon/vault-e2e.test.ts` (1). ALSO run `pnpm vitest run test/bridge/e2e.test.ts` (Plan 01 e2e, no vault → ping path) → still PASS. `pnpm typecheck` → 0.

- [ ] **Step 5: Full suite + typecheck + build.** `pnpm test` (all green incl Plans 01–05), `pnpm typecheck` (0), `pnpm build` (emits dist, bins shebang'd).

- [ ] **Step 6: Commit**
```bash
git add src/daemon/main.ts test/daemon/vault-e2e.test.ts
git commit -m "feat(daemon): index a configured vault + serve search end-to-end"
```

---

## Self-Review (completed during authoring)

**Spec coverage:** vault-dir walk (skip dotdirs) ✓ Task 1; provider selection (offline default, real when configured) ✓ Task 2; daemon serves search over a real vault end-to-end ✓ Task 3; readiness after index ✓ Task 3; ping-only when no vault (Plan 01 preserved) ✓ Task 3. Deferred (noted): on-disk persistence (re-index on startup for now), FTS5+fusion, two-lane router/diversity, file-watch/incremental, background indexing.

**Placeholder scan:** none — code + tests complete. Task 3 is a diff against the existing `main.ts`; the implementer applies it preserving lock/HTTP/shutdown/readiness order.

**Type consistency:** `walkMarkdown`/`indexVault` (Task 1) used in Task 3; `selectEmbedder` (Task 2) → `Embedder` used by `VaultIndex` (P05); `createMcpServer({index})` (P05) injected in Task 3; reuses `VaultIndex` (P05), `FakeEmbedder`/`OpenAIEmbedder` (P04).

**Known risk:** synchronous index-before-readiness means a large vault delays `VAULTNEXUS_READY` (and the e2e/integration tests use tiny vaults so they're fast). Background indexing + a progress signal is a noted later refinement; for MLP-scale vaults and tests, synchronous is correct and simplest. The shared index is built once and only read during connections (no concurrent-write hazard).
