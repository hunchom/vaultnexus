# VaultNexus 12 — `reason_over_vault` Graph-BFS Backbone

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Build the pure-logic backbone for cited reasoning. Given a question, return an ordered citation chain produced by BFS over the wikilink graph plus a k-NN edge layer over chunk embeddings. **No LLM compose step** — the tool returns the verifiable chain; the natural-language answer is a separate, deferred layer that consumes this output.

**Why this shape:** The spec's load-bearing FP-safe guarantee for `reason_over_vault` is "every hop cites `path#heading^block` and the byte offsets are mechanically verifiable" (concept §4). The byte-offset contract is already enforced at chunk-time (Plan 02). The reasoning backbone reuses that invariant — a hop is valid iff its chunk has well-formed `{byteStart, byteEnd}`; the failure mode collapses to "incomplete chain," never "fabricated citation." This separates the deterministic chain-building work (this plan) from the future LLM compose work (its own plan, behind its own quality gate).

**Architecture:**
- `traceReasoning()` lives in `src/daemon/reason-trace.ts` as a pure function over a small index facade (chunks, normalized f32 vectors, note→links map, query function). It does not touch the embedder directly — seeds come from the existing hybrid `query()`.
- BFS frontier expands via two edge types:
  - **wikilink edge** — for current chunk on note A, queue every chunk on every note B where `B ∈ resolveLink(wikilinks(A))`.
  - **k-NN edge** — for current chunk vector `v`, queue the top-`knnPerHop` chunks (across all notes, excluding same-note) with `cosine(v, ·) ≥ simThreshold`.
- A hop is emitted exactly once per chunk id (dedupe by visited set). The first-arrival edge type + score + parent are what get recorded.
- `VaultIndex.trace(question, opts)` is a thin wrapper that builds the facade and calls the pure function.
- MCP surface: `vaultnexus_trace` returns `{ hops: ReasonHop[] }` where each hop is `{ step, fromChunkId?, toChunkId, edgeType: 'seed'|'wikilink'|'knn', score, chunk: IndexedChunk }`.

**Tech stack:** TS/ESM/NodeNext, vitest. No new deps — reuses `dotF32`, `resolveLink`, existing `VaultIndex.query`.

**Non-goals (later plans):**
- LLM compose (`reason_over_vault` natural-language answer) — separate plan, separate gate.
- Claim-Index sentence-tier chunking — Plan 02 deferred this; the backbone runs on the current paragraph-tier chunks.
- Counterfactual / what-if propagation (concept §4, Tier B, gated on §10 spike).
- Diversity / DPP at the seed step — current ranker is good enough on the validated 8-note corpus; revisit when the corpus grows (Plan 09 note).
- Bridges/graph memoization — bridges() rebuilds per call today; trace() may rebuild similarly on the same not-a-hot-path principle.

---

## File Structure

- Create `src/daemon/reason-trace.ts` — pure `traceReasoning()` + `ReasonHop` type.
- Modify `src/daemon/vault-index.ts` — `trace(question, opts)` method; expose minimal read-only facade getters used by the trace function (kept package-private via TS access).
- Modify `src/daemon/mcp-server.ts` — register `vaultnexus_trace` tool with zod schema.
- Create `test/daemon/reason-trace.test.ts` — unit tests on a hand-built `VaultIndex` w/ `FakeEmbedder`.
- Create `test/daemon/mcp-trace.test.ts` — e2e tool roundtrip (smoke).

---

## Task 1 — `ReasonHop` type + pure `traceReasoning()` with seed-only behavior

**Files:** Create `src/daemon/reason-trace.ts`; Create `test/daemon/reason-trace.test.ts`

- [ ] **Step 1:** Define the type + facade interface in `src/daemon/reason-trace.ts`:

```typescript
import type { IndexedChunk, SearchHit } from './vault-index.js';
import { dotF32 } from '../core/vectors.js';
import { resolveLink } from './note-graph.js';

export type EdgeType = 'seed' | 'wikilink' | 'knn';

export interface ReasonHop {
  step: number;
  fromChunkId: number | null;
  toChunkId: number;
  edgeType: EdgeType;
  score: number;
  chunk: IndexedChunk;
}

export interface TraceFacade {
  chunks: readonly IndexedChunk[];
  f32: readonly Float32Array[];
  noteLinks: ReadonlyMap<string, readonly string[]>;
  query: (text: string, k: number) => Promise<SearchHit[]>;
  /** Locate the chunk id of a SearchHit (by notePath + byteStart, unique). */
  chunkIdOf: (hit: SearchHit) => number;
}

export interface TraceOptions {
  maxDepth?: number;    // BFS levels past seed; default 2
  kSeeds?: number;      // initial hybrid-query top-k; default 5
  knnPerHop?: number;   // top-N kNN neighbors per expanded chunk; default 3
  simThreshold?: number;// cosine cutoff for kNN edges; default 0.5
  maxHops?: number;     // global cap on returned hops; default 30
}
```

- [ ] **Step 2: Failing test for seed-only behavior** in `test/daemon/reason-trace.test.ts`. Build a 1-note fixture, set `maxDepth: 0`, assert returned hops are all `edgeType: 'seed'`, length ≤ `kSeeds`, every `chunk` is the corresponding indexed chunk, scores are descending.

- [ ] **Step 3: Implement `traceReasoning(facade, question, opts)`** that:
  1. Calls `facade.query(question, kSeeds)`.
  2. For each seed hit, in score-descending order, emits a `seed` hop (`step: 0`, `fromChunkId: null`, `score: hit.score`, `toChunkId: chunkIdOf(hit)`).
  3. Marks each seed chunk visited; returns immediately if `maxDepth === 0`.
  4. (Step 4 below handles depth > 0.)

- [ ] **Step 4:** Run `pnpm test -- reason-trace`. Confirm green.

---

## Task 2 — BFS expansion via wikilink edges

**Files:** Modify `src/daemon/reason-trace.ts`; Extend `test/daemon/reason-trace.test.ts`

- [ ] **Step 1: Failing test.** Two-note fixture where `A.md` contains `[[B]]` and B has different text from A. With `maxDepth: 1`, assert at least one returned hop has `edgeType: 'wikilink'` and `chunk.notePath` is the B note. The hop's `fromChunkId` must be a chunk on A.md.

- [ ] **Step 2: Implement.** After seeds emit, BFS:
  - Maintain `visited: Set<number>` (chunk ids), `frontier: number[]` (current-depth ids), and `level = 1`.
  - While `level <= maxDepth` and `frontier.length > 0` and `output.length < maxHops`:
    - For each `fromId` in frontier (ordered by the score that put it there), resolve `note = chunks[fromId].notePath`.
    - For each `linkTarget` in `noteLinks.get(note) ?? []`, resolve to a path via `resolveLink(linkTarget, [...noteLinks.keys()])`. For each chunk whose `notePath === resolved`, if not visited, emit `{ step: level, fromChunkId: fromId, toChunkId, edgeType: 'wikilink', score: dotF32(f32[fromId], f32[toChunkId]), chunk }`, mark visited, push to next frontier.
  - Edge score is the cosine between source and target chunks (gives an honest similarity number even when the edge is a deliberate wikilink, not a semantic neighbor).

- [ ] **Step 3:** Confirm test green.

---

## Task 3 — BFS expansion via k-NN edges

**Files:** Modify `src/daemon/reason-trace.ts`; Extend `test/daemon/reason-trace.test.ts`

- [ ] **Step 1: Failing test.** Two-note fixture w/ NO wikilinks but text overlap that gives the FakeEmbedder a cosine ≥ `simThreshold` between them. With `maxDepth: 1, simThreshold: 0.3, knnPerHop: 2`, assert at least one returned hop has `edgeType: 'knn'` reaching the other note.

- [ ] **Step 2: Implement** the k-NN expansion inside the same BFS loop as Task 2's wikilink expansion, run after wikilink edges for each `fromId`:
  - Compute `cosines = f32.map((v, j) => ({ id: j, s: dotF32(f32[fromId], v) }))`.
  - Filter `id !== fromId`, `s >= simThreshold`, and `chunks[id].notePath !== chunks[fromId].notePath` (kNN only crosses notes — wikilinks already cover intra-note context; cross-note is the value).
  - Sort by `s` desc, take top `knnPerHop`.
  - For each, if not visited, emit `{ step: level, fromChunkId: fromId, toChunkId: id, edgeType: 'knn', score: s, chunk }`, mark visited, push to next frontier.

- [ ] **Step 3:** Confirm green.

---

## Task 4 — `VaultIndex.trace()` wrapper + facade exposure

**Files:** Modify `src/daemon/vault-index.ts`; Extend `test/daemon/reason-trace.test.ts`

- [ ] **Step 1: Failing integration test.** Build a 3-note vault (paragraph-chunked) through `VaultIndex.addNote()` w/ `FakeEmbedder`. Call `index.trace(question, opts)`. Assert: (a) hops length > 0, (b) every hop's chunk matches `index.size`-bounded chunk, (c) `step` values are monotonically non-decreasing.

- [ ] **Step 2: Implement.** Add to `VaultIndex`:

```typescript
async trace(question: string, opts: TraceOptions = {}): Promise<ReasonHop[]> {
  if (this.chunks.length === 0) return [];
  if (!this.flatInt8) this.build();
  const facade: TraceFacade = {
    chunks: this.chunks,
    f32: this.f32,
    noteLinks: this.noteLinks,
    query: (text, k) => this.query(text, k),
    chunkIdOf: (hit) =>
      this.chunks.findIndex((c) => c.notePath === hit.notePath && c.byteStart === hit.byteStart),
  };
  return traceReasoning(facade, question, opts);
}
```

`(notePath, byteStart)` is unique per chunk by construction (Plan 02 invariant — block offsets are monotonic per note).

- [ ] **Step 3:** Confirm green.

---

## Task 5 — `vaultnexus_trace` MCP tool

**Files:** Modify `src/daemon/mcp-server.ts`; Create `test/daemon/mcp-trace.test.ts`

- [ ] **Step 1: Failing smoke test.** Connect to the in-memory MCP server with an indexed `VaultIndex`, call `vaultnexus_trace` with a query + `maxDepth: 1`, parse JSON response, assert `hops` is a non-empty array with hop-shaped objects.

- [ ] **Step 2: Implement.** Add to `createMcpServer`:

```typescript
server.registerTool(
  'vaultnexus_trace',
  {
    description:
      'Reasoning backbone: returns an ordered citation chain (seed→wikilink→knn hops) over the vault. Each hop cites notePath + byte offsets and carries the edge that introduced it. No LLM compose; the chain is the contract.',
    inputSchema: {
      question: z.string(),
      maxDepth: z.number().int().nonnegative().optional(),
      kSeeds: z.number().int().positive().optional(),
      knnPerHop: z.number().int().positive().optional(),
      simThreshold: z.number().optional(),
      maxHops: z.number().int().positive().optional(),
    },
  },
  async ({ question, maxDepth, kSeeds, knnPerHop, simThreshold, maxHops }) => {
    const hops = await index.trace(question, { maxDepth, kSeeds, knnPerHop, simThreshold, maxHops });
    return { content: [{ type: 'text', text: JSON.stringify({ hops }) }] };
  },
);
```

- [ ] **Step 3:** Confirm green.

---

## Task 6 — Verification + edge cases

**Files:** Extend `test/daemon/reason-trace.test.ts`

- [ ] **Step 1:** Empty index → `trace()` returns `[]`.
- [ ] **Step 2:** `maxHops` cap is honored (return length ≤ cap, even when more candidates exist).
- [ ] **Step 3:** Deterministic — run `trace()` twice with same inputs, assert deep equality.
- [ ] **Step 4:** Every returned chunk's `{byteStart, byteEnd}` satisfies `0 <= byteStart < byteEnd` and `byteEnd <= sourceByteLen` for that note (re-read source from the test fixture to confirm).
- [ ] **Step 5:** `pnpm typecheck && pnpm test && pnpm build` all green.

---

## Verification before completion

- [ ] `pnpm test` — all green incl. new tests.
- [ ] `pnpm typecheck` — zero errors.
- [ ] `pnpm build` — emits dist/ cleanly with shebang'd bins.
- [ ] No new deps added.
- [ ] Caveman-ULTRA on all source comments/docstrings written. No "Fix N:" prefaces, no essay blocks. ONE-line comments. Quoted strings + symbol names verbatim.
- [ ] No `Claude` / `Anthropic` / `Co-Authored-By` / `noreply@anthropic` strings in any new or modified file.
- [ ] Each task committed atomically on `feat/reason-over-vault` w/ author `Roger French <merihmengisteab@gmail.com>`.

---

## Decision log (validated-first hooks)

- **Why no LLM compose here:** the spec's FP-safe guarantee is the *chain*, not the *prose*. Returning the chain alone yields an immediately useful + mechanically-checkable surface (a Claude Code caller can compose with whatever model it wants), and ships before any quality-gate decision on a bundled judge model.
- **Why kNN edges in addition to wikilinks:** the daily-value claim is "convergence" — finding agreement across link silos. A reasoning chain that only follows wikilinks recapitulates the user's existing graph; kNN edges are where the engine adds value the user could not have produced by clicking links.
- **Why kNN cross-note only:** intra-note context is already covered by the seed chunk's siblings (block-tier chunks of the same note share heading-path); spending the budget on cross-note kNN is where reasoning becomes non-obvious.
- **Why no diversity/DPP here:** Plan 09's eval saturates at recall@10=1.0 on the current corpus; introducing DPP without an eval that can measure its lift is building unvalidatable complexity (memory: validated-first; no partial completion).
