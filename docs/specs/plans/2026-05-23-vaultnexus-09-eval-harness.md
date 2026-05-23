# VaultNexus 09 — Eval Harness + Real-Embedder Validation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Prove the hybrid retrieval stack retrieves the *right* notes on *real semantics* — not just the non-semantic FakeEmbedder — by building an IR eval harness (recall@k / nDCG@k / MRR) over a labeled paraphrase gold set, and a gated test that demonstrates a real embedder beats FakeEmbedder on queries that share no keywords with their targets.

**Architecture:** Pure IR-metric functions (`src/eval/metrics.ts`) over ranked note-paths vs a relevant set. A harness (`src/eval/harness.ts`) builds a `VaultIndex` from a corpus dir + an `Embedder`, runs each gold query, aggregates metrics. A CLI runner (`src/eval/run.ts`) selects the embedder via existing `selectEmbedder()` (real Voyage/OpenAI-compatible if `VAULTNEXUS_EMBED_*` env set, else Fake), prints a metrics table, and exits nonzero below threshold. Offline suite stays green: the real-embedder validation test is `skipIf`-gated on env.

**Tech Stack:** TypeScript / ESM / NodeNext, vitest, the existing `VaultIndex`/`selectEmbedder`/`OpenAIEmbedder`. No new deps.

**Why now:** Every prior green test uses a hash-based non-semantic embedder — plumbing is proven, retrieval quality is not. This plan is the measuring instrument every later enhancement (wikilink graph, two-lane router, `input_type`, chunk tuning) gets judged against.

**Real embedder available (validated in env):** `https://api.voyageai.com/v1`, model `voyage-code-3`, 1024-dim, `/embeddings` returns OpenAI-shape `data:[{index,embedding}]` (http 200 confirmed). The existing `OpenAIEmbedder` works unmodified; only env-var mapping is needed at run time (`VAULTNEXUS_EMBED_URL=$GITNEXUS_EMBEDDING_URL`, `_KEY=$GITNEXUS_EMBEDDING_API_KEY`, `_MODEL=$GITNEXUS_EMBEDDING_MODEL`). The key is the user's secret — env-only, NEVER commit it or print it.

---

## File Structure

- Create `src/eval/metrics.ts` — `recallAtK`, `ndcgAtK`, `reciprocalRank` over `(ranked: string[], relevant: Set<string>, k)`.
- Create `src/eval/gold.ts` — typed gold-set loader + the labeled query list (`GoldQuery[]`).
- Create `eval/corpus/*.md` — 8 short prose notes, distinct topics.
- Create `src/eval/harness.ts` — `runEval(corpusDir, embedder, queries, k)` → `EvalResult` (per-query + aggregate).
- Create `src/eval/run.ts` — CLI: select embedder, run, print table, threshold gate. `#!/usr/bin/env node`.
- Create `test/eval/metrics.test.ts`, `test/eval/harness.test.ts`, `test/eval/real-embedder.test.ts`.
- Modify `package.json` — add `"eval": "tsx src/eval/run.ts"` script.

---

## Task 1: IR metrics module

**Files:** Create `src/eval/metrics.ts`; Test `test/eval/metrics.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/eval/metrics.test.ts
import { describe, it, expect } from 'vitest';
import { recallAtK, ndcgAtK, reciprocalRank } from '../../src/eval/metrics.js';

describe('recallAtK', () => {
  it('fraction of relevant found in top k', () => {
    const ranked = ['a', 'b', 'c', 'd'];
    expect(recallAtK(ranked, new Set(['b', 'd']), 4)).toBe(1);
    expect(recallAtK(ranked, new Set(['b', 'd']), 2)).toBe(0.5);
    expect(recallAtK(ranked, new Set(['z']), 4)).toBe(0);
  });
  it('empty relevant set → 0 (no credit, no NaN)', () => {
    expect(recallAtK(['a'], new Set(), 1)).toBe(0);
  });
});

describe('reciprocalRank', () => {
  it('1/rank of first relevant (1-indexed)', () => {
    expect(reciprocalRank(['a', 'b', 'c'], new Set(['b']))).toBeCloseTo(1 / 2);
    expect(reciprocalRank(['a', 'b'], new Set(['a']))).toBe(1);
    expect(reciprocalRank(['a', 'b'], new Set(['z']))).toBe(0);
  });
});

describe('ndcgAtK', () => {
  it('1.0 when the only relevant doc is ranked first', () => {
    expect(ndcgAtK(['a', 'b', 'c'], new Set(['a']), 3)).toBeCloseTo(1);
  });
  it('discounts a relevant doc ranked lower', () => {
    const top = ndcgAtK(['a', 'b'], new Set(['a']), 2);
    const low = ndcgAtK(['b', 'a'], new Set(['a']), 2);
    expect(low).toBeLessThan(top);
    expect(low).toBeCloseTo(1 / Math.log2(3)); // gain at rank 2 / ideal gain at rank 1
  });
  it('two relevant docs, ideal ordering → 1.0', () => {
    expect(ndcgAtK(['a', 'b', 'c'], new Set(['a', 'b']), 3)).toBeCloseTo(1);
  });
});
```

- [ ] **Step 2: Run → FAIL** (`pnpm vitest run test/eval/metrics.test.ts`) — "Cannot find module metrics.js".

- [ ] **Step 3: Implement**

```typescript
// src/eval/metrics.ts
/** IR metrics over a ranked id list vs a relevant-id set. ids = note paths. */

/** Fraction of relevant ids appearing in the top-k of ranked. 0 if relevant empty. */
export function recallAtK(ranked: string[], relevant: Set<string>, k: number): number {
  if (relevant.size === 0) return 0;
  let hit = 0;
  for (const id of ranked.slice(0, k)) if (relevant.has(id)) hit++;
  return hit / relevant.size;
}

/** 1/rank of first relevant id (1-indexed), 0 if none. */
export function reciprocalRank(ranked: string[], relevant: Set<string>): number {
  for (let i = 0; i < ranked.length; i++) if (relevant.has(ranked[i])) return 1 / (i + 1);
  return 0;
}

/** nDCG@k with binary relevance. gain 1 per relevant, discount 1/log2(rank+1). */
export function ndcgAtK(ranked: string[], relevant: Set<string>, k: number): number {
  if (relevant.size === 0) return 0;
  let dcg = 0;
  ranked.slice(0, k).forEach((id, i) => { if (relevant.has(id)) dcg += 1 / Math.log2(i + 2); });
  let idcg = 0;
  for (let i = 0; i < Math.min(relevant.size, k); i++) idcg += 1 / Math.log2(i + 2);
  return idcg === 0 ? 0 : dcg / idcg;
}
```

- [ ] **Step 4: Run → PASS.** `pnpm vitest run test/eval/metrics.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/eval/metrics.ts test/eval/metrics.test.ts
git commit -m "feat(eval): IR metrics — recall@k, nDCG@k, reciprocal rank"
```

---

## Task 2: Gold corpus + labeled paraphrase queries

**Files:** Create `eval/corpus/*.md` (8 notes); Create `src/eval/gold.ts`

The corpus is short prose on distinct topics. Queries are **paraphrased** — minimal lexical overlap with their target note — so only true semantics (not BM25 keyword overlap, not the FNV hash) retrieves them. This is what makes the real-embedder lift in Task 5 meaningful.

- [ ] **Step 1: Write the 8 corpus notes** (exact content):

`eval/corpus/compounding.md`
```markdown
# Compounding

Small consistent gains accumulate multiplicatively over long horizons. Reinvested
returns themselves earn returns, so the curve bends sharply upward late. The earlier
the start, the more cycles of accumulation occur before the end date.
```

`eval/corpus/sleep.md`
```markdown
# Sleep and memory

During deep slow-wave sleep the hippocampus replays the day's experiences and
transfers them to the neocortex for long-term storage. Skimping on rest the night
after learning measurably weakens what is retained.
```

`eval/corpus/photosynthesis.md`
```markdown
# Photosynthesis

Chloroplasts capture photons and drive a reaction that fixes carbon dioxide into
sugar, releasing oxygen as a byproduct. The plant stores the resulting glucose as
chemical energy for later metabolic use.
```

`eval/corpus/habits.md`
```markdown
# Habit formation

A behavior becomes automatic through a loop of cue, routine, and reward. Repeating
the loop in a stable context strengthens the association until the action fires with
little conscious effort.
```

`eval/corpus/consensus.md`
```markdown
# Distributed consensus

Replicas reach agreement on a single value even when some nodes crash or messages
are delayed. Quorum protocols require a majority to acknowledge before a decision is
committed, trading availability for consistency under partition.
```

`eval/corpus/maillard.md`
```markdown
# The Maillard reaction

When proteins and sugars are heated together above roughly 140C, amino acids and
reducing sugars react to form hundreds of new aroma compounds and brown pigments.
This is why a seared crust tastes far deeper than boiled meat.
```

`eval/corpus/spaced-repetition.md`
```markdown
# Spaced repetition

Recall is strongest when reviews are scheduled at expanding gaps timed to just
before predicted forgetting. Each successful retrieval flattens the forgetting curve
and pushes the next optimal review further out.
```

`eval/corpus/negotiation.md`
```markdown
# Negotiation leverage

Your strongest source of power at the table is the quality of your walk-away
alternative. The better your fallback if no agreement is reached, the less pressure
you feel to accept poor terms.
```

- [ ] **Step 2: Write the gold loader + labeled queries** (exact content):

```typescript
// src/eval/gold.ts
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface GoldQuery { query: string; relevant: string[]; } // relevant = corpus note paths

/** Labeled queries — paraphrased to share few keywords with their target note. */
export const GOLD_QUERIES: GoldQuery[] = [
  { query: 'why investing early in life pays off so disproportionately', relevant: ['compounding.md'] },
  { query: 'what the brain does overnight to lock in things you studied', relevant: ['sleep.md'] },
  { query: 'how a leaf turns light into stored fuel', relevant: ['photosynthesis.md'] },
  { query: 'the cue routine reward loop that makes actions automatic', relevant: ['habits.md'] },
  { query: 'how unreliable machines agree on one value when some fail', relevant: ['consensus.md'] },
  { query: 'why a seared crust tastes richer than boiled meat', relevant: ['maillard.md'] },
  { query: 'the best schedule of reviews so you stop forgetting material', relevant: ['spaced-repetition.md'] },
  { query: 'your fallback if a deal falls through and the power it gives you', relevant: ['negotiation.md'] },
  { query: 'ways to make studied information stick for the long term', relevant: ['sleep.md', 'spaced-repetition.md'] },
  { query: 'biological process that converts sunlight into chemical energy', relevant: ['photosynthesis.md'] },
  { query: 'tradeoff between staying available and staying consistent during a network split', relevant: ['consensus.md'] },
  { query: 'chemistry behind brown flavorful crust on roasted food', relevant: ['maillard.md'] },
];

/** Read corpus dir → map of notePath → source. */
export function loadCorpus(dir: string): Array<{ path: string; source: string }> {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => ({ path: f, source: readFileSync(join(dir, f), 'utf8') }));
}
```

- [ ] **Step 3: No test yet** (data only; exercised in Task 3). Commit:

```bash
git add eval/corpus src/eval/gold.ts
git commit -m "feat(eval): gold corpus + paraphrased labeled queries"
```

---

## Task 3: Eval harness

**Files:** Create `src/eval/harness.ts`; Test `test/eval/harness.test.ts`

- [ ] **Step 1: Write the failing test** (FakeEmbedder, deterministic — uses exact-substring queries so Fake scores well, asserting harness plumbing + aggregation are correct, independent of semantics):

```typescript
// test/eval/harness.test.ts
import { describe, it, expect } from 'vitest';
import { runEval } from '../../src/eval/harness.js';
import { FakeEmbedder } from '../../src/core/embedder.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function tinyCorpus(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vn-eval-'));
  writeFileSync(join(dir, 'cats.md'), '# Cats\n\nthe quick brown fox jumps\n');
  writeFileSync(join(dir, 'dogs.md'), '# Dogs\n\nlazy hounds sleep all day\n');
  return dir;
}

describe('runEval', () => {
  it('aggregates metrics over queries and corpus', async () => {
    const dir = tinyCorpus();
    const r = await runEval(dir, new FakeEmbedder(64), [
      { query: 'the quick brown fox jumps', relevant: ['cats.md'] },
      { query: 'lazy hounds sleep all day', relevant: ['dogs.md'] },
    ], 5);
    expect(r.queries).toBe(2);
    expect(r.recallAt10).toBeCloseTo(1); // exact text → Fake nails both
    expect(r.mrr).toBeCloseTo(1);
    expect(r.perQuery[0].rankedNotes[0]).toBe('cats.md');
  });
  it('reports a miss as recall 0 for that query', async () => {
    const dir = tinyCorpus();
    const r = await runEval(dir, new FakeEmbedder(64), [
      { query: 'completely unrelated nonexistent words xyzzy', relevant: ['cats.md'] },
    ], 5);
    expect(r.perQuery[0].recall).toBe(0);
  });
});
```

- [ ] **Step 2: Run → FAIL** (`pnpm vitest run test/eval/harness.test.ts`).

- [ ] **Step 3: Implement**

```typescript
// src/eval/harness.ts
import { VaultIndex } from '../daemon/vault-index.js';
import type { Embedder } from '../core/embedder.js';
import { loadCorpus, type GoldQuery } from './gold.js';
import { recallAtK, ndcgAtK, reciprocalRank } from './metrics.js';

export interface PerQuery {
  query: string;
  relevant: string[];
  rankedNotes: string[];
  recall: number;
  ndcg: number;
  rr: number;
}
export interface EvalResult {
  queries: number;
  recallAt10: number;
  ndcgAt10: number;
  mrr: number;
  perQuery: PerQuery[];
}

/** dedupe note paths preserving first-seen order (chunk hits → note ranking). */
function rankedNotes(hits: { notePath: string }[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const h of hits) if (!seen.has(h.notePath)) { seen.add(h.notePath); out.push(h.notePath); }
  return out;
}

/** Build index from corpus, run each query, aggregate IR metrics @k. */
export async function runEval(corpusDir: string, embedder: Embedder, queries: GoldQuery[], k = 10): Promise<EvalResult> {
  const idx = new VaultIndex(embedder);
  for (const { path, source } of loadCorpus(corpusDir)) await idx.addNote(path, source);

  const perQuery: PerQuery[] = [];
  for (const q of queries) {
    const hits = await idx.query(q.query, k * 4); // over-fetch chunks → dedupe to notes
    const ranked = rankedNotes(hits);
    const rel = new Set(q.relevant);
    perQuery.push({
      query: q.query, relevant: q.relevant, rankedNotes: ranked,
      recall: recallAtK(ranked, rel, k), ndcg: ndcgAtK(ranked, rel, k), rr: reciprocalRank(ranked, rel),
    });
  }
  const mean = (f: (p: PerQuery) => number) => perQuery.reduce((s, p) => s + f(p), 0) / (perQuery.length || 1);
  return {
    queries: perQuery.length,
    recallAt10: mean((p) => p.recall), ndcgAt10: mean((p) => p.ndcg), mrr: mean((p) => p.rr),
    perQuery,
  };
}
```

- [ ] **Step 4: Run → PASS.** `pnpm vitest run test/eval/harness.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/eval/harness.ts test/eval/harness.test.ts
git commit -m "feat(eval): harness builds index, runs gold queries, aggregates metrics"
```

---

## Task 4: CLI runner + npm script

**Files:** Create `src/eval/run.ts`; Modify `package.json`

- [ ] **Step 1: Implement the runner**

```typescript
// src/eval/run.ts
#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { selectEmbedder } from '../daemon/select-embedder.js';
import { runEval } from './harness.js';
import { GOLD_QUERIES } from './gold.js';

const THRESHOLD = Number(process.env.VAULTNEXUS_EVAL_MIN_RECALL ?? 0); // gate only when set >0

async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const corpusDir = join(here, '../../eval/corpus'); // repo-root/eval/corpus
  const embedder = await selectEmbedder();
  const isFake = embedder.constructor.name === 'FakeEmbedder';
  process.stderr.write(`eval: embedder=${embedder.constructor.name} dims=${embedder.dimensions}\n`);

  const r = await runEval(corpusDir, embedder, GOLD_QUERIES, 10);
  process.stdout.write(
    `\nqueries=${r.queries}  recall@10=${r.recallAt10.toFixed(3)}  nDCG@10=${r.ndcgAt10.toFixed(3)}  MRR=${r.mrr.toFixed(3)}\n\n`,
  );
  for (const p of r.perQuery) {
    const ok = p.recall > 0 ? 'HIT ' : 'MISS';
    process.stdout.write(`  ${ok} rr=${p.rr.toFixed(2)}  ${p.query}\n        → ${p.rankedNotes.slice(0, 3).join(', ')}\n`);
  }
  if (isFake) process.stderr.write('\neval: FakeEmbedder is non-semantic — paraphrase recall is expected to be low. Set VAULTNEXUS_EMBED_* for a real run.\n');
  if (THRESHOLD > 0 && r.recallAt10 < THRESHOLD) {
    process.stderr.write(`\neval: recall@10 ${r.recallAt10.toFixed(3)} < threshold ${THRESHOLD}\n`);
    process.exit(1);
  }
}
main().catch((e) => { process.stderr.write(`eval: fatal ${String(e)}\n`); process.exit(1); });
```

- [ ] **Step 2: Add the npm script** to `package.json` `scripts`:

```json
"eval": "tsx src/eval/run.ts"
```

- [ ] **Step 3: Smoke-run with Fake** (no gate; just confirm it runs end-to-end and prints a table):

Run: `pnpm eval`
Expected: prints `queries=12  recall@10=...` and 12 HIT/MISS lines, exit 0. (Fake recall will be low — that's the point; the real run in Task 6 is the contrast.)

- [ ] **Step 4: Commit**

```bash
git add src/eval/run.ts package.json
git commit -m "feat(eval): CLI runner with metrics table and optional recall gate"
```

---

## Task 5: Gated real-embedder validation test (the semantic-lift proof)

**Files:** Create `test/eval/real-embedder.test.ts`

This is the load-bearing test: when real-embedder env is present it proves (a) the real embedder hits a recall@10 floor on the paraphrase set, and (b) it clearly beats FakeEmbedder on the *same* queries. It `skipIf`-skips offline so the default suite stays green.

- [ ] **Step 1: Write the gated test**

```typescript
// test/eval/real-embedder.test.ts
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { runEval } from '../../src/eval/harness.js';
import { GOLD_QUERIES } from '../../src/eval/gold.js';
import { FakeEmbedder } from '../../src/core/embedder.js';
import { selectEmbedder } from '../../src/daemon/select-embedder.js';

const hasReal = !!(process.env.VAULTNEXUS_EMBED_URL && process.env.VAULTNEXUS_EMBED_KEY && process.env.VAULTNEXUS_EMBED_MODEL);
const corpusDir = join(process.cwd(), 'eval/corpus');

describe.skipIf(!hasReal)('real embedder semantic lift', () => {
  it('beats FakeEmbedder on paraphrased queries and clears the recall floor', async () => {
    const real = await selectEmbedder(); // real because env set
    const realR = await runEval(corpusDir, real, GOLD_QUERIES, 10);
    const fakeR = await runEval(corpusDir, new FakeEmbedder(256), GOLD_QUERIES, 10);

    process.stderr.write(`real recall@10=${realR.recallAt10.toFixed(3)} fake=${fakeR.recallAt10.toFixed(3)}\n`);
    expect(realR.recallAt10).toBeGreaterThanOrEqual(0.8);
    expect(realR.recallAt10).toBeGreaterThan(fakeR.recallAt10 + 0.2);
    expect(realR.mrr).toBeGreaterThan(fakeR.mrr);
  }, 60_000); // network — generous timeout
});
```

- [ ] **Step 2: Run gated test offline → SKIPPED.** `pnpm vitest run test/eval/real-embedder.test.ts` → 1 skipped, exit 0.

- [ ] **Step 3: Commit**

```bash
git add test/eval/real-embedder.test.ts
git commit -m "test(eval): gated real-embedder semantic-lift validation"
```

---

## Task 6: Run for real + record numbers

Not a code change — execute the validation against Voyage and record the result in the plan + project memory.

- [ ] **Step 1: Full offline suite green** (gated test skipped): `pnpm test` → all pass, typecheck 0.

- [ ] **Step 2: Real run** (env mapped from the validated GitNexus/Voyage vars; key stays in env, never printed/committed):

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
export VAULTNEXUS_EMBED_URL="$GITNEXUS_EMBEDDING_URL"
export VAULTNEXUS_EMBED_KEY="$GITNEXUS_EMBEDDING_API_KEY"
export VAULTNEXUS_EMBED_MODEL="$GITNEXUS_EMBEDDING_MODEL"
pnpm eval                                           # prints real recall@10 / nDCG@10 / MRR table
pnpm vitest run test/eval/real-embedder.test.ts     # gated test now RUNS → must pass
```

- [ ] **Step 3: Record** the real recall@10 / nDCG@10 / MRR (and Fake baseline) at the bottom of this file under "## Results", and update `project_vaultnexus.md`.

- [ ] **Step 4:** If recall@10 < 0.8: do NOT lower the bar. Diagnose (likely levers, in order): (a) Voyage `input_type: "query"|"document"` asymmetric embedding — add an optional `inputType` to `buildEmbedBody`/`OpenAIEmbedder`; (b) chunk granularity (per-paragraph vs per-note) in `addNote`; (c) RRF weighting / `kRRF`. Each lever is a follow-up plan, re-measured here. Validated-first: the harness decides, not intuition.

---

## Self-Review

- **Spec coverage:** metrics (T1) ✓, gold data (T2) ✓, harness (T3) ✓, runner+gate (T4) ✓, gated real validation (T5) ✓, execute+record (T6) ✓.
- **Placeholders:** none — all code complete, corpus + queries literal.
- **Type consistency:** `GoldQuery{query,relevant}` defined in `gold.ts`, consumed identically in harness/run/tests. `EvalResult`/`PerQuery` defined in harness, consumed in run. `recallAtK/ndcgAtK/reciprocalRank` signatures `(string[], Set<string>, k?)` consistent across metrics + harness. `selectEmbedder()` reads `VAULTNEXUS_EMBED_*` (existing) — matches the env mapping in T6 and the gate in T5.
- **Offline safety:** real test `skipIf(!hasReal)` → default suite unaffected; runner gate inert unless `VAULTNEXUS_EVAL_MIN_RECALL>0`.
- **Secret hygiene:** key only via env, never committed, never printed by runner (prints embedder class + dims only).

---

## Results (run 2026-05-23, Voyage `/v1/embeddings`, 1024-dim, 8-note corpus, 12 paraphrase queries)

| metric | FakeEmbedder (baseline) | voyage-code-3 | **voyage-3-large** |
|---|---|---|---|
| recall@1 | 0.250 | 0.875 | **0.958** |
| recall@3 | 0.500 | 1.000 | **1.000** |
| recall@10 | 0.542 | 1.000 | **1.000** |
| nDCG@10 | 0.417 | 0.958 | **1.000** |
| MRR | 0.378 | 0.944 | **1.000** |

**Conclusion:** the hybrid (vector⊕FTS5⊕RRF) retrieval stack works excellently on real semantics. `voyage-3-large` ranks a relevant note **#1 on every query** (recall@1=0.958 is the lone 2-relevant query where only one note can hold #1; MRR=1.000). Semantic lift over the non-semantic baseline: **recall@1 +0.71, MRR +0.62** — unambiguous. Gated test `real-embedder.test.ts` PASSES with these (floor recall@1≥0.8, lift>+0.3).

**recall@10 saturates to 1.000** on this corpus (only 8 docs, modern embeddings anisotropic → all cosines positive) → it proves nothing here; **recall@1 / MRR carry the conclusion** (rank-sensitive, corpus-size-immune). This is why the harness reports recall@1.

**Model choice:** `voyage-3-large` > `voyage-code-3` for prose (code model missed the CAP-theorem paraphrase, ranking it #3). Use `voyage-3-large` for the prose-note default; `voyage-code-3` only for code-heavy vaults.

**Levers NOT yet needed (recall@1 already 0.958):** weighted-RRF, Voyage `input_type` query/document asymmetry, chunk-granularity tuning. Re-measure here if a larger/harder corpus drops recall@1.
