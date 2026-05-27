# VaultNexus Plan 08 — FTS5 Keyword + RRF Hybrid Fusion

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** Make `vaultnexus_search` hybrid: combine BM25 lexical retrieval (SQLite FTS5) with the int8 vector retrieval via Reciprocal Rank Fusion. Lexical catches exact terms/rare tokens the embedder misses; semantic catches paraphrase. Fusion is the concept's §3 quality lever — and unlike the vector path (validated only with the non-semantic FakeEmbedder), FTS5 gives genuine lexical relevance testable offline.

**Architecture:** `core/fusion.ts` — pure RRF over ranked id-lists. `daemon/fts.ts` — `FtsIndex` over `better-sqlite3` `:memory:` FTS5 (chunk text keyed by the chunk's array index as rowid; `bm25()` ranking). `VaultIndex` holds an `FtsIndex` alongside the vector store; `query` runs both and fuses. The `vaultnexus_search` surface is unchanged (now hybrid under the hood).

**Tech Stack:** TS ESM/NodeNext, Node 22, vitest. `better-sqlite3` already a dep (FTS5 compiled in, verified Plan 01). Reuses Plans 03/05.

**Scope note:** Plan 08. Delivers FTS5 + RRF hybrid search. NOT: on-disk persistence (FTS still `:memory:`, rebuilt on startup), CC/TMM learned fusion (RRF is the cold-start; learned weights need eval labels → later), query-time field boosting. Builds on master (Plans 01–07).

**TOOLCHAIN:** every command under `export PATH=/opt/homebrew/opt/node@22/bin:$PATH`. Authoritative `pnpm typecheck`. Commits dev, no AI attribution. Branch `feat/hybrid-fusion` off master.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/core/fusion.ts` | pure `fuseRRF(lists, kRRF?)` → fused id ranking |
| `src/daemon/fts.ts` | `FtsIndex` — FTS5 add + bm25 search over chunk text |
| `src/daemon/vault-index.ts` (modify) | hold FtsIndex; `query` = vector ⊕ fts fused |
| `test/**` | RRF unit, FTS bm25 relevance, hybrid query |

---

## Task 1: pure Reciprocal Rank Fusion

**Files:** Create `src/core/fusion.ts`; Test `test/core/fusion.test.ts`

- [ ] **Step 1: Write the failing test**
```typescript
// test/core/fusion.test.ts
import { describe, it, expect } from 'vitest';
import { fuseRRF } from '../../src/core/fusion.js';

describe('fuseRRF', () => {
  it('an id ranked high in both lists wins', () => {
    const fused = fuseRRF([[1, 2, 3], [1, 4, 5]]);
    expect(fused[0]).toBe(1); // top of both
  });
  it('rewards consensus over a single-list top', () => {
    // 2 is 2nd in both; 9 is 1st in one list only and absent from the other
    const fused = fuseRRF([[9, 2, 3], [2, 7, 9]], 60);
    expect(fused.indexOf(2)).toBeLessThan(fused.indexOf(9));
  });
  it('handles disjoint lists (union, deterministic)', () => {
    const fused = fuseRRF([[1, 2], [3, 4]]);
    expect(fused.sort()).toEqual([1, 2, 3, 4]);
  });
  it('empty lists → empty', () => {
    expect(fuseRRF([])).toEqual([]);
    expect(fuseRRF([[], []])).toEqual([]);
  });
  it('kRRF dampens rank influence (smaller k = sharper)', () => {
    // with very small k, the rank-1 items dominate
    const fused = fuseRRF([[10, 11], [12, 13]], 1);
    expect(new Set([fused[0], fused[1]])).toEqual(new Set([10, 12]));
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement**
```typescript
// src/core/fusion.ts

/** Reciprocal Rank Fusion over ranked id-lists. score(id)=Σ 1/(kRRF+rank). Returns ids, fused desc. */
export function fuseRRF(lists: number[][], kRRF = 60): number[] {
  const score = new Map<number, number>();
  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const id = list[rank];
      score.set(id, (score.get(id) ?? 0) + 1 / (kRRF + rank + 1));
    }
  }
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0]) // stable tiebreak by id
    .map(([id]) => id);
}
```

- [ ] **Step 4: Run → PASS** (5). `pnpm typecheck` → 0.

- [ ] **Step 5: Commit**
```bash
git add src/core/fusion.ts test/core/fusion.test.ts
git commit -m "feat(core): reciprocal rank fusion"
```

---

## Task 2: `FtsIndex` — FTS5 keyword search

**Files:** Create `src/daemon/fts.ts`; Test `test/daemon/fts.test.ts`

- [ ] **Step 1: Write the failing test**
```typescript
// test/daemon/fts.test.ts
import { describe, it, expect } from 'vitest';
import { FtsIndex } from '../../src/daemon/fts.js';

describe('FtsIndex', () => {
  it('returns rowids of chunks matching query terms, bm25-ranked', () => {
    const fts = new FtsIndex();
    fts.add(0, 'feedback loops are the heart of every durable system');
    fts.add(1, 'spaced repetition exploits the forgetting curve');
    fts.add(2, 'optimize the system not the goal');
    const ids = fts.search('feedback loops', 5).map((r) => r.id);
    expect(ids[0]).toBe(0); // best lexical match
    expect(ids).not.toContain(1); // no shared terms
  });
  it('ranks a doc with more query-term hits higher', () => {
    const fts = new FtsIndex();
    fts.add(0, 'system');
    fts.add(1, 'system system feedback system');
    const ids = fts.search('system feedback', 5).map((r) => r.id);
    expect(ids[0]).toBe(1);
  });
  it('returns [] for no match and tolerates FTS-special characters', () => {
    const fts = new FtsIndex();
    fts.add(0, 'plain words here');
    expect(fts.search('zzzznomatch', 5)).toEqual([]);
    expect(() => fts.search('a "quote" and (paren) OR *', 5)).not.toThrow();
  });
  it('respects k', () => {
    const fts = new FtsIndex();
    for (let i = 0; i < 10; i++) fts.add(i, 'common term repeated');
    expect(fts.search('common', 3).length).toBeLessThanOrEqual(3);
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement**
```typescript
// src/daemon/fts.ts
import Database from 'better-sqlite3';

export interface FtsHit { id: number; score: number; } // score: higher = better

/** In-memory FTS5 keyword index over chunk text, keyed by integer id (chunk array index). */
export class FtsIndex {
  private readonly db: Database.Database;
  private readonly insert: Database.Statement;

  constructor() {
    this.db = new Database(':memory:');
    // external-content-free FTS5 table; rowid = our chunk id
    this.db.exec("CREATE VIRTUAL TABLE chunks USING fts5(text, tokenize='unicode61');");
    this.insert = this.db.prepare('INSERT INTO chunks(rowid, text) VALUES (?, ?)');
  }

  /** Add a chunk's text under its integer id. */
  add(id: number, text: string): void {
    this.insert.run(id, text);
  }

  /** Sanitize free text → an FTS5 MATCH query of quoted terms (avoids syntax errors). */
  private toMatch(query: string): string {
    const terms = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    return terms.map((t) => `"${t}"`).join(' OR ');
  }

  /** bm25-ranked rowids for the query; higher score = better. */
  search(query: string, k: number): FtsHit[] {
    const match = this.toMatch(query);
    if (!match) return [];
    // bm25() returns lower=better → negate for higher=better
    const rows = this.db
      .prepare('SELECT rowid AS id, -bm25(chunks) AS score FROM chunks WHERE chunks MATCH ? ORDER BY bm25(chunks) LIMIT ?')
      .all(match, k) as Array<{ id: number; score: number }>;
    return rows;
  }
}
```

- [ ] **Step 4: Run → PASS** (4). `pnpm typecheck` → 0.
  - If `better-sqlite3` types need `import Database from 'better-sqlite3'` vs `import * as`, adapt to the installed `@types`/d.ts; FTS5 is compiled into better-sqlite3's bundled SQLite (verified Plan 01). Keep behavior.

- [ ] **Step 5: Commit**
```bash
git add src/daemon/fts.ts test/daemon/fts.test.ts
git commit -m "feat(daemon): FTS5 keyword index (bm25)"
```

---

## Task 3: hybrid `VaultIndex.query` (vector ⊕ FTS, fused)

**Files:** Modify `src/daemon/vault-index.ts`; Test `test/daemon/hybrid.test.ts`

- [ ] **Step 1: Write the failing test**
```typescript
// test/daemon/hybrid.test.ts
import { describe, it, expect } from 'vitest';
import { VaultIndex } from '../../src/daemon/vault-index.js';
import { FakeEmbedder } from '../../src/core/embedder.js';

describe('hybrid query', () => {
  it('still returns the exact-text match on top (vector cosine 1.0 + lexical)', async () => {
    const idx = new VaultIndex(new FakeEmbedder(64));
    await idx.addNote('a.md', '# A\n\nthe quick brown fox\n\nlazy dog sleeps here\n');
    await idx.addNote('b.md', '# B\n\nunrelated content block\n');
    const hits = await idx.query('the quick brown fox', 3);
    expect(hits[0].text).toContain('the quick brown fox');
    expect(hits[0].notePath).toBe('a.md');
  });

  it('surfaces a lexical match the non-semantic embedder would miss', async () => {
    // FakeEmbedder is hash-based → no semantic similarity. Only FTS can connect
    // a query to a paraphrase-free keyword overlap. Query shares the rare term
    // "photosynthesis" with exactly one block.
    const idx = new VaultIndex(new FakeEmbedder(64));
    await idx.addNote('bio.md', '# Bio\n\nphotosynthesis converts light to chemical energy\n');
    await idx.addNote('misc.md', '# Misc\n\ntotally different words about finance\n\nmore filler text here\n');
    const hits = await idx.query('how does photosynthesis work', 3);
    expect(hits.some((h) => h.text.includes('photosynthesis'))).toBe(true);
    expect(hits[0].notePath).toBe('bio.md');
  });

  it('returns [] before indexing', async () => {
    expect(await new VaultIndex(new FakeEmbedder(16)).query('x')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run → FAIL** (the photosynthesis test fails with pure vector search — FakeEmbedder can't connect query to the keyword block; only fusion with FTS surfaces it).

- [ ] **Step 3: Modify `src/daemon/vault-index.ts`**
  - import: `import { FtsIndex } from './fts.js';` and `import { fuseRRF } from '../core/fusion.js';`
  - add a field `private readonly fts = new FtsIndex();`
  - in `addNote`, when pushing each block chunk, also add it to FTS using the chunk's array index as the id:
    ```typescript
    blocks.forEach((b, i) => {
      const id = this.chunks.length; // index this chunk will occupy
      this.chunks.push({ notePath, headingPath: b.headingPath, text: b.text, byteStart: b.byteStart, byteEnd: b.byteEnd });
      this.f32.push(l2normalize(vecs[i]));
      this.fts.add(id, b.text);
    });
    ```
    (Replace the existing forEach body; keep `this.dims`/`this.flatInt8 = null` after the loop.)
  - rewrite `query` to fuse vector + FTS:
    ```typescript
    async query(text: string, k = 10): Promise<SearchHit[]> {
      if (this.chunks.length === 0) return [];
      if (!this.flatInt8) this.build();
      const [qe] = await this.embedder.embed([text]);
      const want = k * 8;
      const vec = search(l2normalize(qe), {
        flatInt8: this.flatInt8!, flatF32: this.flatF32!,
        count: this.chunks.length, dims: this.dims, scale: this.scale, k: want,
      });
      const lex = this.fts.search(text, want);
      const fused = fuseRRF([vec.map((r) => r.index), lex.map((r) => r.id)]).slice(0, k);
      // score field = exact f32 cosine for display/threshold
      const cos = new Map(vec.map((r) => [r.index, r.score]));
      return fused.map((index) => ({ ...this.chunks[index], score: cos.get(index) ?? 0 }));
    }
    ```

- [ ] **Step 4: Run → PASS** (3). ALSO run the existing `test/daemon/vault-index.test.ts`, `test/daemon/search-tool.test.ts`, `test/daemon/vault-e2e.test.ts`, `test/daemon/demo-vault.test.ts` → still PASS (the exact-text-on-top behavior holds: an exact match wins BOTH vector and lexical, so fusion keeps it #1). `pnpm typecheck` → 0.
  - If any prior test now orders differently because fusion changed ranking, inspect: an exact-text query should still rank its block #1 (top of both lists). If a demo/search assertion was relying on pure-vector order for a NON-exact query, update that assertion to the correct hybrid expectation — but DO NOT weaken the exact-match-on-top guarantee.

- [ ] **Step 5: Full suite + typecheck + build.** `pnpm test`, `pnpm typecheck` (0), `pnpm build` (0).

- [ ] **Step 6: Commit**
```bash
git add src/daemon/vault-index.ts test/daemon/hybrid.test.ts
git commit -m "feat(daemon): hybrid vector+FTS5 search via RRF fusion"
```

---

## Self-Review (completed during authoring)

**Spec coverage (concept §3 fusion):** BM25 keyword (FTS5) ✓ Task 2; vector ⊕ keyword fusion ✓ Task 3 (RRF, the stated cold-start); hybrid `vaultnexus_search` ✓ (surface unchanged, fused under the hood). The photosynthesis test proves fusion adds lexical recall the non-semantic FakeEmbedder cannot. Deferred (noted): CC/TMM learned-weight fusion (needs eval labels), on-disk FTS persistence, field boosting, two-lane router/diversity.

**Placeholder scan:** none — code + tests complete. Task 3 Step 4 has a guarded note for re-ordering of non-exact-query assertions; the exact-match-on-top guarantee is the invariant.

**Type consistency:** `fuseRRF(lists, kRRF?)` (Task 1) used Task 3; `FtsIndex.add/search` + `FtsHit` (Task 2) used Task 3; reuses `search`/`l2normalize` (P03), `SearchHit`/`IndexedChunk` (P05). FTS rowid == chunk array index (the join key) — set BEFORE pushing so it matches the final position.

**Known risk:** FTS rowid must equal the chunk's array index — the impl computes `id = this.chunks.length` before `push`, guaranteeing alignment. `:memory:` FTS rebuilds per process (re-index on startup) — persistence is a later plan. `toMatch` quotes terms so user queries with FTS operators/punctuation never throw.
