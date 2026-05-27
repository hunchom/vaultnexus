# VaultNexus Plan 05 — VaultIndex + `vaultnexus_search` MCP tool

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** The first end-to-end semantic retrieval: a `VaultIndex` that ingests notes (chunk → embed → L2-normalize → calibrate+quantize → int8/f32 store) and answers queries (embed → search → cited hits), exposed as a `vaultnexus_search` MCP tool. In-memory, provider-agnostic (tested with `FakeEmbedder`).

**Architecture:** `VaultIndex` (daemon-side; does embedder I/O) composes Plan 02 chunking + Plan 04 embedder + Plan 03 quantize/search. It stores per-chunk metadata + a flat int8/f32 vector store (built lazily, calibrated over all vectors). Every hit carries `notePath` + `headingPath` + byte offsets → citable. `createMcpServer` is refactored to accept optional deps and registers `vaultnexus_search` when an index is provided (ping stays unconditional → Plan 01 test still green).

**Tech Stack:** TS ESM/NodeNext, Node 22, vitest, `zod` (MCP tool input schema). Reuses Plans 02–04.

**Scope note:** Plan 05 of the sequence. Delivers in-memory index + the search tool. NOT: vault-directory walk, daemon wiring/config, on-disk persistence (mmap), FTS5 keyword, fusion, read-time liveness (Plan 06). Vectors are L2-normalized in the index so cosine==dot regardless of provider.

**TOOLCHAIN:** every command under `export PATH=/opt/homebrew/opt/node@22/bin:$PATH`. Authoritative `pnpm typecheck`. Commits dev, no AI attribution. Branch `feat/vault-index` off master.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/daemon/vault-index.ts` | `VaultIndex` — ingest notes, answer queries with cited hits |
| `src/daemon/mcp-server.ts` (modify) | `createMcpServer(deps?)` + `vaultnexus_search` tool |
| `test/**` | index relevance (FakeEmbedder), search-tool via InMemoryTransport |

---

## Task 1: `VaultIndex` — ingest + query

**Files:** Create `src/daemon/vault-index.ts`; Test `test/daemon/vault-index.test.ts`

- [ ] **Step 1: Write the failing test** (FakeEmbedder gives deterministic relevance: identical text → identical vector → cosine 1.0)
```typescript
// test/daemon/vault-index.test.ts
import { describe, it, expect } from 'vitest';
import { VaultIndex } from '../../src/daemon/vault-index.js';
import { FakeEmbedder } from '../../src/core/embedder.js';

describe('VaultIndex', () => {
  it('returns [] before anything is indexed', async () => {
    const idx = new VaultIndex(new FakeEmbedder(64));
    expect(await idx.query('anything')).toEqual([]);
  });

  it('ranks the block whose text equals the query first, with its citation', async () => {
    const idx = new VaultIndex(new FakeEmbedder(64));
    await idx.addNote('notes/a.md', '# Heading\n\nthe quick brown fox\n\nlazy dog sleeps here\n');
    await idx.addNote('notes/b.md', '# Other\n\nunrelated content block\n');
    const hits = await idx.query('the quick brown fox', 3);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].text).toContain('the quick brown fox');
    expect(hits[0].notePath).toBe('notes/a.md');
    expect(hits[0].headingPath).toEqual(['Heading']);
    expect(hits[0].score).toBeCloseTo(1, 5); // identical text → cosine 1
    // citation offsets slice the source
    const src = '# Heading\n\nthe quick brown fox\n\nlazy dog sleeps here\n';
    expect(Buffer.from(src).subarray(hits[0].byteStart, hits[0].byteEnd).toString()).toBe(hits[0].text);
  });

  it('respects k', async () => {
    const idx = new VaultIndex(new FakeEmbedder(32));
    await idx.addNote('n.md', 'a block one\n\nb block two\n\nc block three\n\nd block four\n');
    expect((await idx.query('x', 2)).length).toBeLessThanOrEqual(2);
  });

  it('size reflects indexed block count', async () => {
    const idx = new VaultIndex(new FakeEmbedder(16));
    await idx.addNote('n.md', 'one\n\ntwo\n');
    expect(idx.size).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run → FAIL.** `pnpm vitest run test/daemon/vault-index.test.ts`

- [ ] **Step 3: Implement**
```typescript
// src/daemon/vault-index.ts
import type { Embedder } from '../core/embedder.js';
import { chunkDocument } from '../core/chunk.js';
import { l2normalize } from '../core/vectors.js';
import { calibrateScale, quantize } from '../core/quantize.js';
import { search } from '../core/search.js';

export interface IndexedChunk {
  notePath: string;
  headingPath: string[];
  text: string;
  byteStart: number;
  byteEnd: number;
}
export interface SearchHit extends IndexedChunk { score: number; }

/** In-memory semantic index over note block-chunks. Cosine via unit-norm vectors. */
export class VaultIndex {
  private chunks: IndexedChunk[] = [];
  private f32: Float32Array[] = [];
  private dims = 0;
  private flatInt8: Int8Array | null = null;
  private flatF32: Float32Array | null = null;
  private scale = 1;

  constructor(private readonly embedder: Embedder) {}

  get size(): number { return this.chunks.length; }

  /** Chunk a note, embed its blocks, store (unit-norm) for search. */
  async addNote(notePath: string, source: string): Promise<void> {
    const blocks = chunkDocument(source).filter((c) => c.granularity === 'block');
    if (blocks.length === 0) return;
    const vecs = await this.embedder.embed(blocks.map((b) => b.text));
    blocks.forEach((b, i) => {
      this.chunks.push({ notePath, headingPath: b.headingPath, text: b.text, byteStart: b.byteStart, byteEnd: b.byteEnd });
      this.f32.push(l2normalize(vecs[i]));
    });
    this.dims = this.f32[0].length;
    this.flatInt8 = null; // new data → rebuild flat store on next query
  }

  private build(): void {
    const n = this.f32.length, d = this.dims;
    this.scale = calibrateScale(this.f32);
    const i8 = new Int8Array(n * d), f = new Float32Array(n * d);
    this.f32.forEach((v, i) => { i8.set(quantize(v, this.scale), i * d); f.set(v, i * d); });
    this.flatInt8 = i8; this.flatF32 = f;
  }

  /** Embed the query, search, return cited hits. */
  async query(text: string, k = 10): Promise<SearchHit[]> {
    if (this.chunks.length === 0) return [];
    if (!this.flatInt8) this.build();
    const [q] = await this.embedder.embed([text]);
    const res = search(l2normalize(q), {
      flatInt8: this.flatInt8!, flatF32: this.flatF32!,
      count: this.chunks.length, dims: this.dims, scale: this.scale, k,
    });
    return res.map((r) => ({ ...this.chunks[r.index], score: r.score }));
  }
}
```

- [ ] **Step 4: Run → PASS** (4). `pnpm typecheck` → 0.

- [ ] **Step 5: Commit**
```bash
git add src/daemon/vault-index.ts test/daemon/vault-index.test.ts
git commit -m "feat(daemon): in-memory VaultIndex (chunk+embed+search, cited hits)"
```

---

## Task 2: `createMcpServer(deps?)` + `vaultnexus_search` tool

**Files:** Modify `src/daemon/mcp-server.ts`; Test `test/daemon/search-tool.test.ts`

- [ ] **Step 1: Add zod** (MCP tool input schema)
```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
pnpm add zod
```

- [ ] **Step 2: Write the failing test**
```typescript
// test/daemon/search-tool.test.ts
import { describe, it, expect } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createMcpServer } from '../../src/daemon/mcp-server.js';
import { VaultIndex } from '../../src/daemon/vault-index.js';
import { FakeEmbedder } from '../../src/core/embedder.js';

async function connect(server: ReturnType<typeof createMcpServer>) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: 't', version: '0' });
  await client.connect(ct);
  return client;
}

describe('vaultnexus_search tool', () => {
  it('is absent when no index is provided (ping still present)', async () => {
    const client = await connect(createMcpServer());
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('vaultnexus_ping');
    expect(names).not.toContain('vaultnexus_search');
    await client.close();
  });

  it('searches the injected index and returns cited hits', async () => {
    const idx = new VaultIndex(new FakeEmbedder(64));
    await idx.addNote('notes/a.md', '# H\n\nthe quick brown fox\n\nlazy dog\n');
    const client = await connect(createMcpServer({ index: idx }));

    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('vaultnexus_search');

    const res = await client.callTool({ name: 'vaultnexus_search', arguments: { query: 'the quick brown fox', k: 3 } });
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    const hits = JSON.parse(text) as Array<{ notePath: string; text: string; score: number }>;
    expect(hits[0].notePath).toBe('notes/a.md');
    expect(hits[0].text).toContain('the quick brown fox');
    await client.close();
  });
});
```

- [ ] **Step 3: Modify `createMcpServer`** (keep ping unconditional; add search when an index is present)
```typescript
// src/daemon/mcp-server.ts
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { health } from '../core/health.js';
import type { VaultIndex } from './vault-index.js';

export interface McpServerDeps { index?: VaultIndex; }

/** Build the VaultNexus MCP server. ping always; search when an index is injected. */
export function createMcpServer(deps: McpServerDeps = {}): McpServer {
  const server = new McpServer({ name: 'vaultnexus', version: health().version });

  server.registerTool(
    'vaultnexus_ping',
    { description: 'Health and version probe for the VaultNexus daemon.' },
    async () => ({ content: [{ type: 'text', text: JSON.stringify(health()) }] }),
  );

  const index = deps.index;
  if (index) {
    server.registerTool(
      'vaultnexus_search',
      {
        description: 'Semantic search over the vault. Returns cited block hits (notePath, headingPath, byte offsets, score).',
        inputSchema: { query: z.string(), k: z.number().int().positive().optional() },
      },
      async ({ query, k }) => {
        const hits = await index.query(query, k ?? 10);
        return { content: [{ type: 'text', text: JSON.stringify(hits) }] };
      },
    );
  }

  return server;
}
```

- [ ] **Step 4: Run → PASS** (2). Also run Plan 01's `test/daemon/mcp-server.test.ts` → still PASS (ping unchanged). `pnpm typecheck` → 0.
  - If `registerTool` with `inputSchema` as a zod raw shape doesn't typecheck against the installed SDK, read `node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.d.ts` and adapt to the real shape (raw shape vs `z.object(...)`), keeping tool name + behavior. The handler args destructure `{ query, k }`.

- [ ] **Step 5: Full suite + typecheck.** `pnpm test` (all green incl Plans 01–04) and `pnpm typecheck` (0).

- [ ] **Step 6: Commit**
```bash
git add package.json pnpm-lock.yaml src/daemon/mcp-server.ts test/daemon/search-tool.test.ts
git commit -m "feat(daemon): vaultnexus_search MCP tool over VaultIndex"
```

---

## Self-Review (completed during authoring)

**Spec coverage (concept §3 lookup, in-memory):** ingest (chunk+embed+quantize+store) ✓ Task 1; query (embed+search) with cited hits (notePath+headingPath+offsets) ✓ Task 1; MCP search surface ✓ Task 2; provider-agnostic (FakeEmbedder in tests, any `Embedder`) ✓; L2-normalize → cosine ✓. Deferred (noted): vault-dir walk + daemon wiring + config (Plan 06), on-disk mmap persistence, FTS5 keyword + fusion + read-time liveness (Plan 06), two-lane router/diversity gate (Plan 06).

**Placeholder scan:** none. The registerTool-inputSchema adaptation (Task 2 Step 4) is guidance; the two tool tests are the contract. Plan 01's ping test must stay green (createMcpServer() with no deps).

**Type consistency:** `VaultIndex`/`SearchHit`/`IndexedChunk` defined Task 1, used Task 2; `createMcpServer(deps?)` is backward-compatible (default `{}`) so Plan 01's `createMcpServer()` call and test still hold; reuses `chunkDocument` (P02), `Embedder`/`FakeEmbedder` (P04), `calibrateScale`/`quantize`/`search`/`l2normalize` (P03).

**Design note:** the flat store rebuilds lazily on first query after any `addNote` (calibration must see all vectors). Fine for batch-index-then-query (the MLP path); incremental re-query after each add re-builds — acceptable at this scale, optimized later. `VaultIndex` lives in `daemon/` (embedder I/O), not `core/`.
