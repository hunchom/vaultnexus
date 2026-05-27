import { describe, it, expect } from 'vitest';
import { dppSelect, type DppItem } from '../../src/core/dpp.js';
import { l2normalize } from '../../src/core/vectors.js';

/** Build a unit-norm vec from raw axis-aligned values. */
function vec(...x: number[]): Float32Array {
  return l2normalize(new Float32Array(x));
}

describe('dppSelect', () => {
  it('empty input → empty output', () => {
    expect(dppSelect([], 5, 0.5)).toEqual([]);
  });

  it('k=0 → empty', () => {
    const items: DppItem[] = [{ id: 1, score: 1, vec: vec(1, 0) }];
    expect(dppSelect(items, 0, 0.5)).toEqual([]);
  });

  it('returns ≤ k items even when items.length < k', () => {
    const items: DppItem[] = [
      { id: 1, score: 1, vec: vec(1, 0) },
      { id: 2, score: 0.5, vec: vec(0, 1) },
    ];
    expect(dppSelect(items, 5, 0.5).length).toBe(2);
  });

  it('λ=1 (pure relevance) → score-desc order', () => {
    const items: DppItem[] = [
      { id: 10, score: 0.3, vec: vec(1, 0) },
      { id: 20, score: 0.9, vec: vec(0, 1) },
      { id: 30, score: 0.6, vec: vec(0, 0, 1) },
    ];
    expect(dppSelect(items, 3, 1.0)).toEqual([20, 30, 10]);
  });

  it('λ=0 (pure diversity after first pick) → spreads picks across vec space', () => {
    // Three items: 10 highest-score is along x; two near-duplicates of 10 (also along x)
    // and an orthogonal item along y. λ=0 → after 10, the orthogonal y should win
    // over the near-duplicate x because it has higher dist-to-picked.
    const items: DppItem[] = [
      { id: 10, score: 0.9, vec: vec(1, 0) },       // pick #1 (highest score)
      { id: 11, score: 0.85, vec: vec(0.99, 0.01) },// near-dup of 10 → low diversity
      { id: 12, score: 0.85, vec: vec(0, 1) },      // orthogonal → high diversity
    ];
    const picked = dppSelect(items, 2, 0.0);
    expect(picked[0]).toBe(10); // relevance breaks the first-slot tie (minDist=1 for all)
    expect(picked[1]).toBe(12); // pure-diversity: orthogonal beats near-dup
  });

  it('λ=0.5 (balanced) → relevance + diversity both matter', () => {
    const items: DppItem[] = [
      { id: 1, score: 1.0, vec: vec(1, 0, 0) },
      { id: 2, score: 0.95, vec: vec(0.99, 0.1, 0) }, // near-dup of 1, slightly less score
      { id: 3, score: 0.6, vec: vec(0, 1, 0) },       // very diverse, lower score
    ];
    const picked = dppSelect(items, 2, 0.5);
    expect(picked[0]).toBe(1);
    // 2nd slot: id=3 has (rel=0, dist≈1) → 0.5*0 + 0.5*1 = 0.5
    //          id=2 has (rel≈0.875, dist≈small) → 0.5*0.875 + 0.5*~0.01 ≈ 0.44
    // → 3 wins
    expect(picked[1]).toBe(3);
  });

  it('two identical vectors with same score → λ=0 picks one then the other (no infinite loop)', () => {
    const items: DppItem[] = [
      { id: 1, score: 1, vec: vec(1, 0) },
      { id: 2, score: 1, vec: vec(1, 0) }, // exact duplicate
    ];
    const picked = dppSelect(items, 2, 0.0);
    expect(picked.length).toBe(2);
    expect(new Set(picked)).toEqual(new Set([1, 2]));
  });

  it('duplicate-vec demotion: λ=0.3 prefers diverse item over near-dup at slot 2', () => {
    // The plain "λ=1" baseline would pick 10,11,12 (all near-x). DPP at λ=0.3 should
    // surface the orthogonal one earlier.
    const items: DppItem[] = [
      { id: 10, score: 1.0, vec: vec(1, 0) },
      { id: 11, score: 0.95, vec: vec(1, 0.01) }, // dup of 10
      { id: 12, score: 0.9, vec: vec(1, 0.02) },  // dup of 10
      { id: 13, score: 0.5, vec: vec(0, 1) },     // orthogonal, lower score
    ];
    const baseline = dppSelect(items, 3, 1.0);
    const diverse = dppSelect(items, 3, 0.3);
    expect(baseline).toEqual([10, 11, 12]);            // pure relevance keeps all dups
    expect(diverse[0]).toBe(10);
    expect(diverse).toContain(13);                     // diverse pulls 13 into top-3
    expect(diverse.indexOf(13)).toBeLessThan(diverse.indexOf(11));
  });

  it('all-equal scores → λ=1 yields stable id-asc order (via normalize-collapse to 1)', () => {
    const items: DppItem[] = [
      { id: 30, score: 0.5, vec: vec(1, 0) },
      { id: 10, score: 0.5, vec: vec(1, 0) },
      { id: 20, score: 0.5, vec: vec(1, 0) },
    ];
    // λ=1 → val = 1 for all; tie-break: lower id first
    expect(dppSelect(items, 3, 1.0)).toEqual([10, 20, 30]);
  });
});
