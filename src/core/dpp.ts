/** Plan 25 — greedy DPP-style diversity reranker over fusion top-K.
 *
 *  Motivation: when several chunks of the same note rank similarly under hybrid
 *  fusion, top-K becomes redundant. A Determinantal Point Process prefers SUBSETS
 *  with both high relevance AND high pairwise diversity.
 *
 *  This is the greedy approximation (not exact MAP-DPP — exact is NP-hard at
 *  scale). Iteratively pick the item maximizing:
 *    score(item) = λ * relevance(item) + (1 - λ) * minDist(item, selected)
 *  where:
 *    - relevance ∈ [0,1] (normalized from fusion ranks)
 *    - minDist(item, S) = min over s∈S of (1 - cos(item.vec, s.vec))   for S non-empty
 *    - minDist(item, ∅) = 1                                            (any item is fully diverse against ∅)
 *
 *  λ controls relevance↔diversity trade-off:
 *    λ=1.0 → pure relevance (DPP no-op, returns score-desc order)
 *    λ=0.0 → pure diversity ignoring relevance after pick #1
 *    λ=0.5 → balanced
 *
 *  Contract:
 *    - Items must have unit-norm `vec` (caller's responsibility — VaultIndex already enforces).
 *    - Returns ≤ k ids in pick order (the relevance winner is always first).
 *    - Stable: when ties exist, lower id wins.
 *    - O(n*k) time, O(k) extra memory. */

import { dotF32 } from './vectors.js';

export interface DppItem {
  id: number;
  score: number;        // relevance, higher = better (cosine, or normalized rank score)
  vec: Float32Array;    // unit-norm
}

/** Normalize scores to [0,1] across items. Min→0, max→1. Single-item → 1. */
function normalize(items: DppItem[]): number[] {
  if (items.length === 0) return [];
  if (items.length === 1) return [1];
  let min = Infinity, max = -Infinity;
  for (const it of items) {
    if (it.score < min) min = it.score;
    if (it.score > max) max = it.score;
  }
  const range = max - min;
  if (range === 0) return items.map(() => 1); // all equal → treat as fully relevant
  return items.map((it) => (it.score - min) / range);
}

/** cosine = dot of unit vectors; distance = 1 - cosine ∈ [0, 2]. Clamped ≥0. */
function distance(a: Float32Array, b: Float32Array): number {
  const d = 1 - dotF32(a, b);
  return d < 0 ? 0 : d; // FP guard; theoretically d ∈ [0,2]
}

export function dppSelect(items: DppItem[], k: number, lambda: number): number[] {
  if (k <= 0 || items.length === 0) return [];
  const want = Math.min(k, items.length);
  const rel = normalize(items);
  const picked: number[] = [];        // indices into items[]
  const minDist: number[] = items.map(() => 1); // distance to nearest already-picked; init 1 (∅)
  const taken = new Uint8Array(items.length);

  for (let slot = 0; slot < want; slot++) {
    let bestIdx = -1;
    let bestVal = -Infinity;
    for (let i = 0; i < items.length; i++) {
      if (taken[i]) continue;
      const val = lambda * rel[i] + (1 - lambda) * minDist[i];
      // ties → lower id first (deterministic, matches fuseRRF convention)
      if (val > bestVal || (val === bestVal && bestIdx >= 0 && items[i].id < items[bestIdx].id)) {
        bestVal = val;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) break;
    picked.push(items[bestIdx].id);
    taken[bestIdx] = 1;
    // update minDist for remaining: shrink to min(prev, dist-to-newly-picked)
    const pickedVec = items[bestIdx].vec;
    for (let i = 0; i < items.length; i++) {
      if (taken[i]) continue;
      const d = distance(items[i].vec, pickedVec);
      if (d < minDist[i]) minDist[i] = d;
    }
  }
  return picked;
}
