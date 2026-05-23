# VaultNexus Plan 07 — Convergence/Bridges + Seeded Demo Vault

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** The headline convergence surface — find chunk pairs that are semantically similar but live in *different notes* ("notes that secretly agree"), ranked by similarity, exposed as `vaultnexus_bridges`. Plus a bundled **demo vault** so a fresh install demonstrates search + bridges immediately. This completes the demoable MLP surface.

**Architecture:** `VaultIndex.bridges()` does an O(N²) cross-note cosine pass over the stored unit f32 vectors (fine at MLP/demo scale; heap/ANN optimization later), returns top-N pairs above a similarity floor. FP-safe by construction — a suggested connection costs the reader three seconds, never trust — so no precision gate. Exposed via `createMcpServer` deps as `vaultnexus_bridges`. A `demo-vault/` of small thematically-overlapping notes ships in-repo for the cold-start demo.

**Tech Stack:** TS ESM/NodeNext, Node 22, vitest. Reuses Plans 02–06 (`dotF32`, `VaultIndex`, `createMcpServer`, `indexVault`, `FakeEmbedder`).

**Scope note:** Plan 07. Delivers convergence v1 + demo vault. Convergence v1 = cross-note high-similarity pairs (FP-safe). DEFERRED (noted, needs wikilink extraction + Louvain — a later plan): excluding already-wikilinked pairs, cross-community ranking, Bayesian-surprise weighting, the §10.6 owner-rated insight bar. Also deferred: eval harness (most meaningful with a real embedder — Plan 08). Builds on master (Plans 01–06).

**TOOLCHAIN:** every command under `export PATH=/opt/homebrew/opt/node@22/bin:$PATH`. Authoritative `pnpm typecheck`. Commits Roger French, no AI attribution. Branch `feat/bridges-demo` off master.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/daemon/vault-index.ts` (modify) | add `Bridge` type + `bridges(topN, minSimilarity)` |
| `src/daemon/mcp-server.ts` (modify) | add `vaultnexus_bridges` tool |
| `demo-vault/*.md` | bundled sample notes (cold-start demo) |
| `test/**` | bridges relevance, the bridges tool, demo-vault integration |

---

## Task 1: `VaultIndex.bridges()` — cross-note convergence

**Files:** Modify `src/daemon/vault-index.ts`; Test `test/daemon/bridges.test.ts`

- [ ] **Step 1: Write the failing test** (FakeEmbedder: identical text in two notes → cross-note similarity 1.0 → top bridge)
```typescript
// test/daemon/bridges.test.ts
import { describe, it, expect } from 'vitest';
import { VaultIndex } from '../../src/daemon/vault-index.js';
import { FakeEmbedder } from '../../src/core/embedder.js';

describe('VaultIndex.bridges', () => {
  it('returns [] with fewer than 2 chunks', async () => {
    const idx = new VaultIndex(new FakeEmbedder(64));
    await idx.addNote('a.md', '# A\n\nlone block\n');
    expect(idx.bridges()).toEqual([]);
  });

  it('surfaces a high-similarity pair across different notes, not same-note pairs', async () => {
    const idx = new VaultIndex(new FakeEmbedder(64));
    // identical paragraph in two different notes → cross-note similarity 1.0
    await idx.addNote('a.md', '# A\n\nshared insight about systems\n\nfiller one\n');
    await idx.addNote('b.md', '# B\n\nshared insight about systems\n\nfiller two\n');
    const bridges = idx.bridges(10, 0.5);
    expect(bridges.length).toBeGreaterThan(0);
    const top = bridges[0];
    expect(top.similarity).toBeCloseTo(1, 5);
    // the bridge connects the two DIFFERENT notes
    expect(top.a.notePath).not.toBe(top.b.notePath);
    expect([top.a.notePath, top.b.notePath].sort()).toEqual(['a.md', 'b.md']);
    expect(top.a.text).toContain('shared insight about systems');
  });

  it('never bridges a note to itself', async () => {
    const idx = new VaultIndex(new FakeEmbedder(32));
    await idx.addNote('a.md', 'p one\n\np two\n\np three\n');
    await idx.addNote('b.md', 'q one\n\nq two\n');
    for (const br of idx.bridges(50, -1)) expect(br.a.notePath).not.toBe(br.b.notePath);
  });

  it('respects the similarity floor and topN', async () => {
    const idx = new VaultIndex(new FakeEmbedder(32));
    await idx.addNote('a.md', 'alpha block\n\nbeta block\n');
    await idx.addNote('b.md', 'gamma block\n\ndelta block\n');
    const all = idx.bridges(100, -1);
    const sorted = [...all].every((b, i, arr) => i === 0 || arr[i - 1].similarity >= b.similarity);
    expect(sorted).toBe(true); // descending
    expect(idx.bridges(1, -1).length).toBeLessThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Modify `vault-index.ts`** — add the `Bridge` export and a `bridges()` method. Add `import { dotF32 } from '../core/vectors.js';` (alongside the existing `l2normalize` import). Add the type near `SearchHit`:
```typescript
export interface Bridge { a: IndexedChunk; b: IndexedChunk; similarity: number; }
```
And add this method to the `VaultIndex` class (it reuses the lazily-built `flatF32`):
```typescript
  /** Cross-note high-similarity chunk pairs ("notes that secretly agree"), top-N descending. FP-safe. */
  bridges(topN = 20, minSimilarity = 0.5): Bridge[] {
    const n = this.chunks.length;
    if (n < 2) return [];
    if (!this.flatInt8) this.build();
    const f = this.flatF32!;
    const d = this.dims;
    const out: Bridge[] = [];
    for (let i = 0; i < n; i++) {
      const vi = f.subarray(i * d, (i + 1) * d);
      for (let j = i + 1; j < n; j++) {
        if (this.chunks[i].notePath === this.chunks[j].notePath) continue;
        const s = dotF32(vi, f.subarray(j * d, (j + 1) * d));
        if (s >= minSimilarity) out.push({ a: this.chunks[i], b: this.chunks[j], similarity: s });
      }
    }
    out.sort((x, y) => y.similarity - x.similarity);
    return out.slice(0, topN);
  }
```

- [ ] **Step 4: Run → PASS** (4). `pnpm typecheck` → 0.

- [ ] **Step 5: Commit**
```bash
git add src/daemon/vault-index.ts test/daemon/bridges.test.ts
git commit -m "feat(daemon): cross-note convergence bridges"
```

---

## Task 2: `vaultnexus_bridges` MCP tool

**Files:** Modify `src/daemon/mcp-server.ts`; Test `test/daemon/bridges-tool.test.ts`

- [ ] **Step 1: Write the failing test**
```typescript
// test/daemon/bridges-tool.test.ts
import { describe, it, expect } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createMcpServer } from '../../src/daemon/mcp-server.js';
import { VaultIndex } from '../../src/daemon/vault-index.js';
import { FakeEmbedder } from '../../src/core/embedder.js';

async function connect(server: ReturnType<typeof createMcpServer>) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const c = new Client({ name: 't', version: '0' });
  await c.connect(ct);
  return c;
}

describe('vaultnexus_bridges tool', () => {
  it('absent without an index; present with one', async () => {
    expect((await (await connect(createMcpServer())).listTools()).tools.map((t) => t.name))
      .not.toContain('vaultnexus_bridges');
    const idx = new VaultIndex(new FakeEmbedder(32));
    await idx.addNote('a.md', 'x\n');
    expect((await (await connect(createMcpServer({ index: idx }))).listTools()).tools.map((t) => t.name))
      .toContain('vaultnexus_bridges');
  });

  it('returns cross-note bridges as JSON', async () => {
    const idx = new VaultIndex(new FakeEmbedder(64));
    await idx.addNote('a.md', '# A\n\nshared insight about systems\n\nfiller one\n');
    await idx.addNote('b.md', '# B\n\nshared insight about systems\n\nfiller two\n');
    const client = await connect(createMcpServer({ index: idx }));
    const res = await client.callTool({ name: 'vaultnexus_bridges', arguments: { topN: 5 } });
    const bridges = JSON.parse((res.content as Array<{ type: string; text: string }>)[0].text);
    expect(bridges.length).toBeGreaterThan(0);
    expect(bridges[0].a.notePath).not.toBe(bridges[0].b.notePath);
    await client.close();
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Modify `mcp-server.ts`** — inside the `if (index) {` block (after the `vaultnexus_search` registration), add:
```typescript
    server.registerTool(
      'vaultnexus_bridges',
      {
        description: 'Surface chunk pairs that are semantically similar but in different notes (hidden connections). Suggestions, not assertions.',
        inputSchema: { topN: z.number().int().positive().optional(), minSimilarity: z.number().optional() },
      },
      async ({ topN, minSimilarity }) => {
        const bridges = index.bridges(topN ?? 20, minSimilarity ?? 0.5);
        return { content: [{ type: 'text', text: JSON.stringify(bridges) }] };
      },
    );
```

- [ ] **Step 4: Run → PASS** (2). Plan 05 `search-tool.test.ts` + Plan 01 ping test still PASS. `pnpm typecheck` → 0.

- [ ] **Step 5: Commit**
```bash
git add src/daemon/mcp-server.ts test/daemon/bridges-tool.test.ts
git commit -m "feat(daemon): vaultnexus_bridges MCP tool"
```

---

## Task 3: seeded demo vault + integration

**Files:** Create `demo-vault/*.md` (5 notes); Test `test/daemon/demo-vault.test.ts`

- [ ] **Step 1: Create the demo vault** — 5 small notes with deliberate cross-note thematic overlap so search AND bridges both demo well. Create these files verbatim:

`demo-vault/compounding.md`:
```markdown
# Compounding

Small advantages repeated over time produce outsized results. The key insight is that consistency beats intensity when the horizon is long.

Reinvesting gains is what separates linear growth from exponential growth.
```

`demo-vault/habits.md`:
```markdown
# Habits

Consistency beats intensity when the horizon is long. A small daily practice compounds into mastery.

Identity-based habits stick because they change who you believe you are.
```

`demo-vault/learning.md`:
```markdown
# Learning

Spaced repetition exploits the forgetting curve. Reviewing just before you forget is the most efficient schedule.

A small daily practice compounds into mastery over months.
```

`demo-vault/systems.md`:
```markdown
# Systems

Optimize the system, not the goal. Goals set direction; systems produce progress.

Feedback loops are the heart of every durable system.
```

`demo-vault/decisions.md`:
```markdown
# Decisions

Reversible decisions should be made fast; irreversible ones deserve deliberation. Most decisions are more reversible than they feel.

Feedback loops are the heart of every durable system, including how you decide.
```

- [ ] **Step 2: Write the integration test**
```typescript
// test/daemon/demo-vault.test.ts
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { VaultIndex } from '../../src/daemon/vault-index.js';
import { indexVault } from '../../src/daemon/indexer.js';
import { FakeEmbedder } from '../../src/core/embedder.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const demoDir = join(repoRoot, 'demo-vault');

describe('demo vault', () => {
  it('indexes the 5 bundled notes', async () => {
    const idx = new VaultIndex(new FakeEmbedder(128));
    const n = await indexVault(demoDir, idx);
    expect(n).toBe(5);
    expect(idx.size).toBeGreaterThanOrEqual(5);
  });

  it('exact-text search finds the source note', async () => {
    const idx = new VaultIndex(new FakeEmbedder(128));
    await indexVault(demoDir, idx);
    const hits = await idx.query('Feedback loops are the heart of every durable system.', 3);
    expect(['systems.md', 'decisions.md']).toContain(hits[0].notePath);
  });

  it('bridges connect notes sharing a repeated line, across different files', async () => {
    const idx = new VaultIndex(new FakeEmbedder(128));
    await indexVault(demoDir, idx);
    const bridges = idx.bridges(20, 0.99); // repeated identical lines → ~1.0
    expect(bridges.length).toBeGreaterThan(0);
    for (const b of bridges) expect(b.a.notePath).not.toBe(b.b.notePath);
    // e.g. "Feedback loops..." appears in systems.md and decisions.md
    const pairs = bridges.map((b) => [b.a.notePath, b.b.notePath].sort().join('+'));
    expect(pairs).toContain('decisions.md+systems.md');
  });
});
```

- [ ] **Step 3: Run.** `pnpm vitest run test/daemon/demo-vault.test.ts` → PASS (3).
  - The bridges test relies on the verbatim repeated line "Feedback loops are the heart of every durable system" appearing in BOTH `systems.md` and `decisions.md` → with FakeEmbedder that block pair has cosine ~1.0. If chunk granularity merges that line with neighbors so the two blocks differ, lower the floor or assert the pair appears among bridges at high similarity rather than requiring exactly 1.0 — but keep the cross-note assertion. (The index uses per-paragraph blocks, so the repeated single-line paragraph should match exactly.)

- [ ] **Step 4: Full suite + typecheck + build.** `pnpm test` (all green), `pnpm typecheck` (0), `pnpm build` (0).

- [ ] **Step 5: Commit**
```bash
git add demo-vault test/daemon/demo-vault.test.ts
git commit -m "feat: seeded demo vault (search + bridges cold-start demo)"
```

---

## Self-Review (completed during authoring)

**Spec coverage:** convergence/bridges (cross-note high-similarity, FP-safe, ranked) ✓ Task 1; MCP surface ✓ Task 2; seeded demo vault for cold-start ✓ Task 3; demo exercises both search + bridges ✓. Deferred (noted): wikilink-aware exclusion + Louvain cross-community ranking + Bayesian-surprise + the §10.6 insight bar (need wikilink extraction first); eval harness (Plan 08, needs real embedder).

**Placeholder scan:** none — code, tests, demo notes all concrete. Task 3 Step 3 has a fallback note for the bridges-floor assertion if chunk granularity surprises, keeping the cross-note guarantee.

**Type consistency:** `Bridge` defined Task 1, used Task 2; `bridges(topN, minSimilarity)` signature consistent across Tasks 1–3; reuses `dotF32`/`IndexedChunk` (P05), `createMcpServer({index})` (P05), `indexVault` (P06), `FakeEmbedder` (P04).

**Known risk:** O(N²) bridges is fine for the demo/MLP (hundreds of chunks) but quadratic at scale — a top-N heap + ANN-neighbor candidate generation is the noted later optimization. Bridges read the lazily-built `flatF32` (built on first `query`/`bridges`); calling `bridges()` before any `query` triggers `build()` which is correct.
