# VaultNexus Plan 03 — int8 Search Engine (calibration + numkong i8 top-k + exact f32 rescore)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** The exact-top-k vector search core: symmetric single-scale int8 calibration, an int8 dot-product top-k scan via the `numkong` i8 SIMD kernel (oversampling candidates), then an exact f32 cosine rescore of those candidates — recovering true top-k at ~32× less memory than f32. Pure typed-array math, in-memory (mmap persistence is Plan 05). Verified on synthetic vectors: int8+rescore must recover the brute-force f32 top-k.

**Architecture:** All `core/`, pure, I/O-free, operating on `Float32Array`/`Int8Array`. Vectors are L2-normalized so cosine ranking == dot ranking. Calibration is **symmetric single-scale** (`s = max|x| / 127`) — the only scheme that composes with numkong's integer i8 dot kernel (per-dimension/asymmetric would corrupt distances). The two-stage search (int8 coarse rank → f32 exact rescore of the top candidates) is the concept's §3 engine, minus persistence.

**Tech Stack:** TypeScript ESM/NodeNext, Node 22, vitest. New dep: `numkong` (i8 SIMD kernels; `@numkong/darwin-arm64` prebuilt; the maintained successor to `simsimd`).

**Scope note:** Plan 03 of the sequence (concept §3). Delivers ONLY the in-memory search math + calibration. No embeddings (Plan 04), no mmap/LMDB/FTS5 persistence (Plan 05), no fusion/lookup pipeline (Plan 06). Builds on master (Plans 01–02).

**TOOLCHAIN:** every command under `export PATH=/opt/homebrew/opt/node@22/bin:$PATH`. Authoritative type-check `pnpm typecheck`. Commits dev, no AI attribution. Branch `feat/search-engine` off master.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/core/vectors.ts` | `l2normalize`, `dotF32` — pure f32 helpers |
| `src/core/quantize.ts` | `calibrateScale`, `quantize` — symmetric single-scale int8 |
| `src/core/search.ts` | `int8TopK` (numkong i8 scan), `rescoreF32`, `search` (combined), `recallAtK` |
| `test/core/*` | synthetic-vector unit + the recall/exactness contract |

---

## Task 1: numkong dependency + i8 kernel probe + f32 vector helpers

**Files:** Modify `package.json`; Create `src/core/vectors.ts`; Test `test/core/vectors.test.ts`, `test/core/numkong-probe.test.ts`

- [ ] **Step 1: Install numkong**
```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
pnpm add numkong
node -e "const n=require('numkong'); console.log(Object.keys(n))"   # inspect exports
```
Expected: install succeeds (`@numkong/darwin-arm64` prebuilt resolves); the log prints numkong's export names (note them — likely include `dot`, `inner`, `sqeuclidean`, possibly `DType`). If `require` fails because numkong is ESM-only, use `node --input-type=module -e "import('numkong').then(n=>console.log(Object.keys(n)))"`.

- [ ] **Step 2: Write the numkong i8 probe test** (verifies the i8 dot kernel does what we need)
```typescript
// test/core/numkong-probe.test.ts
import { describe, it, expect } from 'vitest';
import { int8Dot } from '../../src/core/search.js';

describe('numkong i8 dot kernel', () => {
  it('computes the integer dot product of two Int8Arrays', () => {
    const a = Int8Array.from([1, 2, 3, -4]);
    const b = Int8Array.from([5, 6, 7, 8]);
    // 1*5 + 2*6 + 3*7 + (-4)*8 = 5+12+21-32 = 6
    expect(int8Dot(a, b)).toBe(6);
  });
});
```
(This test imports from `search.ts` — created in Task 3. For Task 1, you may instead inline a tiny probe in `numkong-probe.test.ts` that calls numkong directly to CONFIRM the API shape, then delete it once `search.ts` exists. The key outcome of Task 1 is: you have CONFIRMED, from numkong's installed `.d.ts` / a runtime probe, the exact export and call that yields the integer i8 dot product. Document it in your report.)

- [ ] **Step 3: Write `vectors.ts` test**
```typescript
// test/core/vectors.test.ts
import { describe, it, expect } from 'vitest';
import { l2normalize, dotF32 } from '../../src/core/vectors.js';

describe('vectors', () => {
  it('l2normalize yields unit length', () => {
    const v = l2normalize(Float32Array.from([3, 4]));
    expect(Math.hypot(v[0], v[1])).toBeCloseTo(1, 6);
    expect(v[0]).toBeCloseTo(0.6, 6);
  });
  it('dotF32 of two unit vectors is their cosine', () => {
    const a = l2normalize(Float32Array.from([1, 0]));
    const b = l2normalize(Float32Array.from([1, 1]));
    expect(dotF32(a, b)).toBeCloseTo(Math.SQRT1_2, 6);
  });
  it('l2normalize of a zero vector returns zeros (no NaN)', () => {
    const v = l2normalize(Float32Array.from([0, 0]));
    expect(v[0]).toBe(0); expect(v[1]).toBe(0);
  });
});
```

- [ ] **Step 4: Implement `vectors.ts`**
```typescript
// src/core/vectors.ts

/** L2-normalize → unit vector (zero vector → zeros, no NaN). */
export function l2normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  const norm = Math.sqrt(sum);
  const out = new Float32Array(v.length);
  if (norm === 0) return out;
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

/** Exact f32 dot product. */
export function dotF32(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
```

- [ ] **Step 5: Run** `pnpm vitest run test/core/vectors.test.ts` → PASS (3). (numkong-probe runs after Task 3.) `pnpm typecheck` → 0.

- [ ] **Step 6: Commit**
```bash
git add package.json pnpm-lock.yaml src/core/vectors.ts test/core/vectors.test.ts test/core/numkong-probe.test.ts
git commit -m "feat(core): numkong dep + f32 vector helpers"
```

---

## Task 2: symmetric single-scale int8 quantization

**Files:** Create `src/core/quantize.ts`; Test `test/core/quantize.test.ts`

- [ ] **Step 1: Write the failing test**
```typescript
// test/core/quantize.test.ts
import { describe, it, expect } from 'vitest';
import { calibrateScale, quantize } from '../../src/core/quantize.js';
import { l2normalize } from '../../src/core/vectors.js';

describe('quantize (symmetric single-scale)', () => {
  it('scale is max|x|/127 over the sample', () => {
    const sample = [Float32Array.from([0.5, -1.0, 0.25]), Float32Array.from([0.1, 0.2, 0.8])];
    expect(calibrateScale(sample)).toBeCloseTo(1.0 / 127, 9);
  });
  it('quantizes into int8 range and round-trips approximately', () => {
    const v = l2normalize(Float32Array.from([0.2, -0.5, 0.3, 0.8]));
    const scale = calibrateScale([v]);
    const q = quantize(v, scale);
    expect(q).toBeInstanceOf(Int8Array);
    for (const x of q) { expect(x).toBeGreaterThanOrEqual(-127); expect(x).toBeLessThanOrEqual(127); }
    // dequant(q) ≈ v
    for (let i = 0; i < v.length; i++) expect(q[i] * scale).toBeCloseTo(v[i], 2);
  });
  it('clamps out-of-range values to [-127,127]', () => {
    const q = quantize(Float32Array.from([10, -10]), 1 / 127); // huge relative to scale
    expect(q[0]).toBe(127); expect(q[1]).toBe(-127);
  });
});
```

- [ ] **Step 2: Run → FAIL.** `pnpm vitest run test/core/quantize.test.ts`

- [ ] **Step 3: Implement**
```typescript
// src/core/quantize.ts

/** Symmetric single-scale: s = max|x| / 127 over a calibration sample. */
export function calibrateScale(sample: Float32Array[]): number {
  let maxAbs = 0;
  for (const v of sample) for (let i = 0; i < v.length; i++) {
    const a = Math.abs(v[i]);
    if (a > maxAbs) maxAbs = a;
  }
  return maxAbs === 0 ? 1 : maxAbs / 127;
}

/** Quantize f32 → int8 with one symmetric scale; clamps to [-127,127]. */
export function quantize(v: Float32Array, scale: number): Int8Array {
  const out = new Int8Array(v.length);
  for (let i = 0; i < v.length; i++) {
    const q = Math.round(v[i] / scale);
    out[i] = q > 127 ? 127 : q < -127 ? -127 : q;
  }
  return out;
}
```

- [ ] **Step 4: Run → PASS** (3). `pnpm typecheck` → 0.

- [ ] **Step 5: Commit**
```bash
git add src/core/quantize.ts test/core/quantize.test.ts
git commit -m "feat(core): symmetric single-scale int8 quantization"
```

---

## Task 3: int8 top-k scan (numkong) + exact f32 rescore + combined search

**Files:** Create `src/core/search.ts`; Test `test/core/search.test.ts`

`int8Dot` wraps numkong's i8 kernel (confirmed in Task 1). The scan computes `int8Dot(query, dataset[i])` for all i, keeps the top `oversample*k` candidates by int8 dot, then `rescoreF32` computes exact cosine (`dotF32` of unit f32 vectors) on just those candidates and returns the true top-k. Dataset is one flat typed array; vector i is `arr.subarray(i*dims, (i+1)*dims)`.

- [ ] **Step 1: Write the failing tests** (synthetic vectors; the recall+exactness contract)
```typescript
// test/core/search.test.ts
import { describe, it, expect } from 'vitest';
import { int8Dot, rescoreF32, search, type SearchResult } from '../../src/core/search.js';
import { l2normalize, dotF32 } from '../../src/core/vectors.js';
import { calibrateScale, quantize } from '../../src/core/quantize.js';

function randUnit(dims: number, rng: () => number): Float32Array {
  const v = new Float32Array(dims);
  for (let i = 0; i < dims; i++) v[i] = rng() * 2 - 1;
  return l2normalize(v);
}
// deterministic PRNG
function mulberry32(seed: number) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function bruteForceTopK(query: Float32Array, vecs: Float32Array[], k: number): number[] {
  return vecs.map((v, i) => [i, dotF32(query, v)] as [number, number])
    .sort((a, b) => b[1] - a[1]).slice(0, k).map(([i]) => i);
}

describe('search engine', () => {
  it('int8Dot is the integer dot product', () => {
    expect(int8Dot(Int8Array.from([1, 2, 3, -4]), Int8Array.from([5, 6, 7, 8]))).toBe(6);
  });

  it('int8 + f32 rescore recovers the exact f32 top-k (recall@10 >= 0.95)', () => {
    const rng = mulberry32(42);
    const dims = 256, N = 2000, k = 10;
    const vecs: Float32Array[] = Array.from({ length: N }, () => randUnit(dims, rng));
    const scale = calibrateScale(vecs);
    const flatInt8 = new Int8Array(N * dims);
    const flatF32 = new Float32Array(N * dims);
    vecs.forEach((v, i) => { flatInt8.set(quantize(v, scale), i * dims); flatF32.set(v, i * dims); });

    let hits = 0; const trials = 50;
    for (let t = 0; t < trials; t++) {
      const q = randUnit(dims, rng);
      const got: SearchResult[] = search(q, { flatInt8, flatF32, count: N, dims, scale, k, oversample: 8 });
      const truth = new Set(bruteForceTopK(q, vecs, k));
      hits += got.filter((r) => truth.has(r.index)).length;
    }
    expect(hits / (trials * k)).toBeGreaterThanOrEqual(0.95);
  });

  it('rescore scores equal exact f32 cosine for the returned indices', () => {
    const rng = mulberry32(7);
    const dims = 64, N = 200, k = 5;
    const vecs = Array.from({ length: N }, () => randUnit(dims, rng));
    const scale = calibrateScale(vecs);
    const flatInt8 = new Int8Array(N * dims); const flatF32 = new Float32Array(N * dims);
    vecs.forEach((v, i) => { flatInt8.set(quantize(v, scale), i * dims); flatF32.set(v, i * dims); });
    const q = randUnit(dims, rng);
    const got = search(q, { flatInt8, flatF32, count: N, dims, scale, k, oversample: 8 });
    for (const r of got) expect(r.score).toBeCloseTo(dotF32(q, vecs[r.index]), 5);
    // sorted descending by score
    for (let i = 1; i < got.length; i++) expect(got[i - 1].score).toBeGreaterThanOrEqual(got[i].score);
  });
});
```

- [ ] **Step 2: Run → FAIL.** `pnpm vitest run test/core/search.test.ts`

- [ ] **Step 3: Implement**
```typescript
// src/core/search.ts
import { dot as numkongDot } from 'numkong'; // ADAPT: confirm export name/shape from numkong .d.ts (Task 1)
import { dotF32 } from './vectors.js';

export interface SearchResult { index: number; score: number; }

export interface SearchParams {
  flatInt8: Int8Array;   // N*dims int8 vectors
  flatF32: Float32Array; // N*dims f32 vectors (same order)
  count: number;         // N
  dims: number;
  scale: number;         // int8 scale (unused for ranking — dot order is scale-invariant)
  k: number;
  oversample?: number;   // candidate multiplier before rescore (default 8)
}

/** Integer dot of two int8 vectors via numkong's i8 kernel. */
export function int8Dot(a: Int8Array, b: Int8Array): number {
  return Number(numkongDot(a, b));
}

/** Coarse int8 top-(oversample*k) candidate indices by int8 dot, descending. */
export function int8TopK(query: Int8Array, flatInt8: Int8Array, count: number, dims: number, want: number): number[] {
  const scored: Array<[number, number]> = new Array(count);
  for (let i = 0; i < count; i++) {
    const v = flatInt8.subarray(i * dims, (i + 1) * dims);
    scored[i] = [i, int8Dot(query, v)];
  }
  scored.sort((a, b) => b[1] - a[1]);
  return scored.slice(0, want).map(([i]) => i);
}

/** Exact f32 cosine rescore of candidate indices → top-k descending. */
export function rescoreF32(candidates: number[], query: Float32Array, flatF32: Float32Array, dims: number, k: number): SearchResult[] {
  const res = candidates.map((index) => ({
    index,
    score: dotF32(query, flatF32.subarray(index * dims, (index + 1) * dims)),
  }));
  res.sort((a, b) => b.score - a.score);
  return res.slice(0, k);
}

/** Two-stage exact top-k: int8 coarse rank → f32 exact rescore. Query must be unit-norm f32. */
export function search(queryF32: Float32Array, p: SearchParams): SearchResult[] {
  const oversample = p.oversample ?? 8;
  const want = Math.min(p.count, p.k * oversample);
  // quantize the query with the same symmetric scale
  const qInt8 = new Int8Array(p.dims);
  for (let i = 0; i < p.dims; i++) {
    const q = Math.round(queryF32[i] / p.scale);
    qInt8[i] = q > 127 ? 127 : q < -127 ? -127 : q;
  }
  const candidates = int8TopK(qInt8, p.flatInt8, p.count, p.dims, want);
  return rescoreF32(candidates, queryF32, p.flatF32, p.dims, p.k);
}

/** Recall@k of a result set vs a ground-truth index set. */
export function recallAtK(got: SearchResult[], truth: Set<number>): number {
  if (truth.size === 0) return 1;
  const k = got.length;
  return got.filter((r) => truth.has(r.index)).length / Math.min(k, truth.size);
}
```

- [ ] **Step 4: Run → PASS.** `pnpm vitest run test/core/search.test.ts` AND `pnpm vitest run test/core/numkong-probe.test.ts`.
  - The recall test is the load-bearing contract: int8 coarse + f32 rescore must recover ≥95% of the brute-force f32 top-10 at oversample 8. If recall is low, the likely cause is the numkong i8 call returning something other than the plain integer dot (e.g. a distance, or a normalized value) — FIX `int8Dot` to yield the integer dot product (read numkong's `.d.ts`; it may be `inner`, or `dot` may return a distance you must convert). Do NOT lower the 0.95 bar. If numkong only exposes a *distance* (e.g. `sqeuclidean`), rank by ascending distance instead — but for unit vectors, max dot == min sqeuclidean, so adapt `int8TopK`'s ordering accordingly and keep the test green.

- [ ] **Step 5: Run full suite + typecheck.** `pnpm test` (all green incl Plans 01–02) and `pnpm typecheck` (0).

- [ ] **Step 6: Commit**
```bash
git add src/core/search.ts test/core/search.test.ts
git commit -m "feat(core): int8 top-k scan (numkong) + exact f32 rescore"
```

---

## Self-Review (completed during authoring)

**Spec coverage (concept §3 engine, minus persistence):** symmetric single-scale int8 calibration ✓ Task 2; numkong i8 dot scan ✓ Tasks 1,3; exact f32 rescore over oversampled candidates ✓ Task 3; recall self-check ✓ Task 3 (the ≥0.95 contract); L2-normalize so dot==cosine ✓ Task 1. Deferred (later plans, noted): mmap persistence, worker-thread sharding, dim-floor auto-disable + per-model recall gate at registration (Plan 05/04), embeddings (Plan 04).

**Placeholder scan:** none — code + tests complete. The numkong-API adaptation (Task 1 probe + Task 3 `int8Dot`/ordering note) is guidance; the recall+exactness tests are the hard contract.

**Type consistency:** `SearchResult`/`SearchParams` defined in Task 3, used in its tests; `l2normalize`/`dotF32` from Task 1 used in Tasks 2–3 tests; `calibrateScale`/`quantize` from Task 2 used in Task 3 tests. `search(queryF32, params)` signature consistent.

**Known risk:** numkong's exact i8 export name/return semantics are confirmed at implementation time (Task 1 probe) — the plan's `import { dot as numkongDot }` is the expected shape; the implementer adapts to the installed `.d.ts` and the recall test proves correctness regardless. The O(N) full scan is correct and fine for in-memory ≤ a few M vectors (concept's target); sharding/mmap are later optimizations.
