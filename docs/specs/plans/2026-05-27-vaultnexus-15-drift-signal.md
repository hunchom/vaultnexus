# VaultNexus 15 — Confirmation-Drift Signal Computer

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Compute the **conviction-drift signal** described in concept §10.9 — the deterministic slope of a hedge/assertion lexicon-derived conviction score against the supporting-claim count, both measured over git-time on a note's revision history. This signal is the **input** to the §10.9 precision spike (the make-or-break experiment for the durability bet). Plan 15 ships the computation surface; the precision-gate spike comes later when real third-party owner-labeled vaults exist.

**Critical scope decision: NO MCP TOOL.** Per concept §10.9, the drift signal is "the one not-FP-safe Tier-A surface" — it ships to users **only** after the precision gate passes. Plan 15 produces the signal as a **CLI + pure library** for research / pre-registered validation. Wiring it to an MCP tool prematurely would defeat the gate. The MCP surface is a separate, post-spike plan.

**Architecture:**
- Pure, I/O-free `src/core/drift.ts`:
  - `conviction(text: string): number` — lexicon-based score: assertion-density minus hedge-density (both normalized by total word count). Range roughly `[-0.05, +0.10]`.
  - `convictionSlope(samples: Array<{ date: string; score: number }>): number` — least-squares slope of score against days-since-first.
  - `supportingClaimSlope(samples: Array<{ date: string; count: number }>): number` — least-squares slope of `count` against days-since-first.
  - `driftFlag(revisions, opts): DriftEvent | null` — returns a flag iff `convictionSlope ≥ opts.minConvictionSlope` AND `supportingClaimSlope ≤ opts.maxSupportingSlope` AND `revisions.length ≥ 3` (a meaningful slope needs ≥3 points).
- `src/eval/drift-check.ts` — CLI entry point: `pnpm drift <notePath> [vaultPath]`. Walks history via Plan 13's `noteRevisions` + `noteContentAt`, extracts wikilinks per revision (Plan 10's `extractWikilinks`), computes the signal, prints a structured JSON result. Exits 0 always — the signal is informational, never a build gate at this stage.
- `package.json` adds `"drift": "tsx src/eval/drift-check.ts"`.

**Lexicon design (committed to docs/specs/drift-lexicon.md — the pre-registered artifact):**
- **Hedge words (14):** `maybe`, `perhaps`, `might`, `could`, `seems`, `appears`, `possibly`, `somewhat`, `tentatively`, `arguably`, `roughly`, `apparently`, `probably`, `kind of`.
- **Strong-assertion words (12):** `definitely`, `clearly`, `obviously`, `certainly`, `must`, `always`, `never`, `only`, `every`, `essential`, `useless`, `impossible`.

Both lists are case-insensitive, word-bounded (`\b…\b`), counted in the note **body** (after frontmatter strip). Density = `count / totalWords`. The lexicon is **frozen at write time** — re-running the signal on the same revision must produce the same conviction score across machines. A change to the lexicon counts as a new signal version; Plan 15 commits version `v1`.

**Validated-first stance (concept §10.9):**

The drift signal's **known confound** is that conviction and supporting-claim count are *naturally* correlated — a knowledge worker who settles on a view tends to *both* assert it more strongly *and* stop adding new supporting evidence (because they're done thinking about it). So the signal will fire on **healthy settling** in addition to **pathological drift**. Plan 15 cannot solve this — that is what the §10.9 spike measures. What Plan 15 **must** do is:

1. **Fire on the canonical pathological case** — the Plan 14 stance-shift fixture (`gtd-effectiveness.md`), where conviction monotonically rises across 3 revisions AND the wikilink set is held flat by construction. This is the *minimum signal sensitivity* test.
2. **Not fire on a single-revision note** — by construction (`revisions.length < 3`).
3. **Run cleanly on a synthetic "healthy settling" case** (≥3 revisions where BOTH conviction and supporting-claim-count rise) — assert the signal *does fire* here too (because the rule is "conviction-up AND supporting-flat"; healthy-settling has supporting-up, so flag should be null). This is the *confound-discrimination* test — the rule's specificity-test before the spike measures its precision on real corpora.
4. **Run cleanly on a "noise" case** (≥3 revisions, conviction zigzags, supporting flat) — slope is near zero, flag null.

These four properties are the contract the tests assert. The signal's *precision on real owner-labeled drift events* is **not** Plan 15's job — that is concept §10.9's job.

**Tech stack:** TS/ESM/NodeNext, vitest. **No new deps.** Reuses `extractWikilinks`, `parseMarkdown`, `noteRevisions`, `noteContentAt`.

**Non-goals:**
- Owner-labeled precision validation (concept §10.9; needs real vaults + recruited labelers).
- Lexicon-perturbation pass (§10.9a; needs a labeled set first to measure stability against).
- MCP tool surface (gated on §10.9 spike).
- Multilingual lexicons (English-only v1; spec's target user writes in English per concept's assumption).
- Per-paragraph drift granularity (whole-note level; the chunks layer could later refine this).

---

## File Structure

- Create `src/core/drift.ts` — pure conviction/slope/flag functions + `DriftEvent` type.
- Create `docs/specs/drift-lexicon.md` — the v1 lexicon, frozen.
- Create `src/eval/drift-check.ts` — CLI: walk history + compute signal + print JSON.
- Create `test/core/drift.test.ts` — unit tests for conviction + slopes + flag rule.
- Create `test/eval/drift-check.test.ts` — integration test against Plan 14's seeded vault fixture (the canonical pathological case).
- Modify `package.json` — add `"drift": "tsx src/eval/drift-check.ts"`.

---

## Task 1 — `conviction(text)` lexicon scoring

**Files:** Create `src/core/drift.ts`; Create `docs/specs/drift-lexicon.md`; Create `test/core/drift.test.ts`

- [ ] **Step 1:** Write `docs/specs/drift-lexicon.md` documenting the v1 hedge and strong-assertion lists exactly as in the spec above (one-line each, plus the case-insensitive + word-bounded rule). Frame it as the pre-registered artifact for §10.9.

- [ ] **Step 2:** Define types + lexicon constants in `src/core/drift.ts`:

```typescript
export const HEDGE_WORDS_V1 = [
  'maybe','perhaps','might','could','seems','appears','possibly',
  'somewhat','tentatively','arguably','roughly','apparently','probably','kind of',
] as const;

export const ASSERTION_WORDS_V1 = [
  'definitely','clearly','obviously','certainly','must','always','never',
  'only','every','essential','useless','impossible',
] as const;

export interface DriftEvent {
  notePath: string;
  convictionSlope: number;   // points/day
  supportingClaimSlope: number; // links/day
  samples: Array<{ date: string; conviction: number; supportingClaims: number }>;
  reason: 'conviction-up-supporting-flat';
}
```

- [ ] **Step 3: Failing test** for `conviction(text)`:
  - Empty string → 0.
  - Pure hedge ("maybe maybe maybe") → negative density.
  - Pure assertion ("definitely always never") → positive density.
  - Mixed ("maybe definitely") → near zero.

- [ ] **Step 4: Implement** `conviction(text: string): number`:
  - Lowercase + split on `/[^a-z']+/` to get word tokens.
  - For each lexicon term, count case-insensitive whole-word matches (multi-word terms like `'kind of'` need a small extra pass over the lowercased original text via regex `/\bkind of\b/g`).
  - `convictionScore = (assertionCount - hedgeCount) / max(1, totalWords)`.
  - Return the score.

- [ ] **Step 5:** Run `pnpm test -- drift`. Confirm green.

---

## Task 2 — `convictionSlope` + `supportingClaimSlope` (least-squares)

**Files:** Modify `src/core/drift.ts`; Extend `test/core/drift.test.ts`

- [ ] **Step 1: Failing test** — given `[{date:'2024-01-01', score:0.0}, {date:'2024-01-31', score:0.05}, {date:'2024-03-02', score:0.10}]`, `convictionSlope` returns a strictly positive number close to `0.0017/day` (linear over ~60 days). Tolerance ±10%.

- [ ] **Step 2: Implement** `convictionSlope(samples)`:
  - If `samples.length < 2`, return 0.
  - Convert dates to `t_i = (Date.parse(samples[i].date) - Date.parse(samples[0].date)) / 86_400_000` (days since first).
  - Compute least-squares slope: `slope = sum((t_i - t_mean)(y_i - y_mean)) / sum((t_i - t_mean)^2)`.
  - Return the slope.

- [ ] **Step 3:** Implement `supportingClaimSlope(samples)` with the same shape but `samples[i].count` instead of `.score`.

- [ ] **Step 4: Failing test** — flat-line (all same score) → slope 0. Decreasing sequence → negative slope.

- [ ] **Step 5:** Confirm green.

---

## Task 3 — `driftFlag(revisions, opts)`

**Files:** Modify `src/core/drift.ts`; Extend `test/core/drift.test.ts`

- [ ] **Step 1: Failing test** — three synthetic revisions:
  - **Pathological case:** conviction 0.01 → 0.04 → 0.08; supporting 1 → 1 → 1. With `opts: { minConvictionSlope: 0.0005, maxSupportingSlope: 0.005 }`, `driftFlag` returns a non-null `DriftEvent` whose `reason === 'conviction-up-supporting-flat'`.
  - **Healthy-settling (confound) case:** conviction 0.01 → 0.04 → 0.08; supporting 1 → 3 → 5. With the same opts, `driftFlag` returns **null** (supporting-slope above the tolerance).
  - **Noise case:** conviction 0.02 → 0.03 → 0.02; supporting 1 → 1 → 1. With the same opts, `driftFlag` returns **null** (conviction-slope below the threshold).
  - **Too-few-revisions case:** 2 revisions only → `null` regardless of slopes.

- [ ] **Step 2: Implement** `driftFlag(revisions, opts)`:

```typescript
export interface DriftRevision { date: string; content: string; supportingClaimCount: number; }
export interface DriftOpts {
  minConvictionSlope?: number;   // default 0.0005 points/day
  maxSupportingSlope?: number;   // default 0.005 links/day
}

export function driftFlag(notePath: string, revisions: DriftRevision[], opts: DriftOpts = {}): DriftEvent | null {
  if (revisions.length < 3) return null;
  const minCS = opts.minConvictionSlope ?? 0.0005;
  const maxSS = opts.maxSupportingSlope ?? 0.005;
  const samples = revisions.map((r) => ({
    date: r.date,
    conviction: conviction(r.content),
    supportingClaims: r.supportingClaimCount,
  }));
  const csSamples = samples.map((s) => ({ date: s.date, score: s.conviction }));
  const ssSamples = samples.map((s) => ({ date: s.date, count: s.supportingClaims }));
  const cs = convictionSlope(csSamples);
  const ss = supportingClaimSlope(ssSamples);
  if (cs >= minCS && ss <= maxSS) {
    return { notePath, convictionSlope: cs, supportingClaimSlope: ss, samples, reason: 'conviction-up-supporting-flat' };
  }
  return null;
}
```

- [ ] **Step 3:** Confirm green.

---

## Task 4 — CLI `drift-check.ts` + integration test on Plan 14 fixture

**Files:** Create `src/eval/drift-check.ts`; Modify `package.json`; Create `test/eval/drift-check.test.ts`

- [ ] **Step 1:** Implement CLI:

```typescript
#!/usr/bin/env node
import { argv, stdout } from 'node:process';
import { noteRevisions, noteContentAt } from '../daemon/git-history.js';
import { extractWikilinks } from '../core/wikilinks.js';
import { driftFlag } from '../core/drift.js';

async function main() {
  const notePath = argv[2];
  const vaultPath = argv[3] ?? process.cwd();
  if (!notePath) { console.error('usage: drift-check <notePath> [vaultPath]'); process.exit(2); }
  const revs = await noteRevisions(vaultPath, notePath);
  if (revs.length === 0) { console.log(JSON.stringify({ flag: null, revisions: 0 })); return; }
  const driftRevs = await Promise.all(revs.map(async (r) => {
    const content = (await noteContentAt(vaultPath, r.sha, notePath)) ?? '';
    return { date: r.commitDate, content, supportingClaimCount: extractWikilinks(content).length };
  }));
  const flag = driftFlag(notePath, driftRevs);
  stdout.write(JSON.stringify({ flag, revisions: driftRevs.length }) + '\n');
}
main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2:** Add to `package.json` scripts:
  ```json
  "drift": "tsx src/eval/drift-check.ts"
  ```

- [ ] **Step 3: Integration test** in `test/eval/drift-check.test.ts`:
  - Seed Plan 14's demo vault into a `mkdtempSync` target via the existing seeder (programmatically import `scripts/seed-demo-vault.ts`'s entry function, OR shell out to `pnpm seed:demo <target>`; the former is cleaner).
  - Run the drift-check function (extract the CLI logic into a callable + a thin CLI shim so tests don't need a subprocess).
  - Assert: for `notes/productivity/gtd-effectiveness.md`, the result has `flag !== null` and `flag.reason === 'conviction-up-supporting-flat'`.
  - Assert: for `notes/productivity/gtd-overview.md` (single revision in the timeline), result has `flag === null` and `revisions === 1`.

- [ ] **Step 4:** Run `pnpm test`. Confirm green (expect ~163 tests; baseline 156 + ~7 new).

---

## Task 5 — Verification

- [ ] **Step 1:** `pnpm typecheck` — 0 errors.
- [ ] **Step 2:** `pnpm test` — all green.
- [ ] **Step 3:** `pnpm build` — clean.
- [ ] **Step 4:** Manual sanity: `pnpm seed:demo /tmp/vn-drift-$RANDOM && pnpm drift notes/productivity/gtd-effectiveness.md /tmp/vn-drift-...` should print a JSON line with `flag.reason === 'conviction-up-supporting-flat'`.
- [ ] **Step 5:** Confirm author identity (`git log master..HEAD --pretty='%h %an <%ae>'` all `dev`) and `.claude/` exclusion (`git log master..HEAD --stat | grep '.claude/'` empty).

---

## Verification before completion

- [ ] `pnpm test` — green, ~163 tests.
- [ ] `pnpm typecheck` — 0 errors.
- [ ] `pnpm build` — clean.
- [ ] No new deps added.
- [ ] No MCP tool registered for drift — research surface only until §10.9 spike passes.
- [ ] Lexicon doc committed at `docs/specs/drift-lexicon.md` as the pre-registered v1 artifact.
- [ ] Caveman-ULTRA on code comments.
- [ ] All commits authored as `dev <dev@localhost>`.
- [ ] **Do NOT rewrite history.** **Do NOT `git add -A`.**

---

## Decision log

- **Why no MCP tool yet:** the signal's precision on real owner-labeled events is unproven. Shipping it to users via MCP before the §10.9 spike validates it would be exactly the false-positive shipping risk the gate exists to prevent. The CLI exists for the spike harness to call, not for end-users.
- **Why lexicon is frozen at v1:** §10.9a requires lexicon-perturbation stability (Jaccard ≥ threshold across small lexicon shuffles). Freezing v1 lets that test exist; later versions ship behind their own gate.
- **Why least-squares over simple difference:** ≥3 revisions in a real note give a noisy slope; least-squares is the lowest-variance unbiased estimator under the linear-trend assumption. Falls back gracefully to single-pair slope at n=2 (returns 0 at n<2 by the early-return).
- **Why `revisions.length < 3` returns null:** a 2-point slope is just a difference; the §10.9 spike requires "meaningful trajectory" — 3 is the minimum non-trivial trend.
- **Why both conditions (conviction-up AND supporting-flat) rather than ratio:** the confound IS the natural correlation; a ratio would amplify it. The AND-with-tolerance lets the spike calibrate thresholds against owner labels.
- **Why test the healthy-settling confound case:** without this test, "drift fires whenever conviction rises" — which is the prior session's killed claim about why drift might fail its own gate (memory: `KILLED claims` — "the conviction↔evidence-count confound"). The confound test bakes the discrimination requirement into Plan 15 even though the §10.9 spike has the final word.
