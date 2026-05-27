import { describe, it, expect } from 'vitest';
import { fuseRRF } from '../../src/core/fusion.js';

describe('fuseRRF', () => {
  it('an id ranked high in both lists wins', () => {
    const fused = fuseRRF([[1, 2, 3], [1, 4, 5]]);
    expect(fused[0]).toBe(1);
  });
  it('rewards consensus over a single-list top', () => {
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
    const fused = fuseRRF([[10, 11], [12, 13]], 1);
    expect(new Set([fused[0], fused[1]])).toEqual(new Set([10, 12]));
  });
  it('on a fused-score tie, prefers the earlier (more-trusted) list', () => {
    // 5 rank-0 in list 0, 2 rank-0 in list 1 → both score 1/61; semantic (first) list wins
    expect(fuseRRF([[5, 6, 7], [2, 8, 9]])[0]).toBe(5);
  });

  describe('weighted (Plan 25)', () => {
    it('no weights arg → identical to unweighted default (backwards-compat)', () => {
      const lists = [[1, 2, 3], [4, 1, 5], [6, 2, 7]];
      expect(fuseRRF(lists, 60)).toEqual(fuseRRF(lists, 60, [1, 1, 1]));
    });
    it('weight 2 on list A → A-only ids beat B-only at same rank', () => {
      // A id=10 rank-0 contributes 2/61; B id=20 rank-0 contributes 1/61 → 10 wins.
      const fused = fuseRRF([[10], [20]], 60, [2, 1]);
      expect(fused[0]).toBe(10);
      expect(fused[1]).toBe(20);
    });
    it('weight 0 on FTS list → fused == vector list order', () => {
      const vec = [11, 12, 13];
      const fts = [20, 21, 22];
      const fused = fuseRRF([vec, fts], 60, [1, 0]);
      expect(fused).toEqual(vec); // fts ids absent (weight 0 → no contribution)
    });
    it('balanced weights 1.0/1.0 == unweighted', () => {
      const lists = [[7, 8, 9], [9, 10, 7]];
      expect(fuseRRF(lists, 60, [1, 1])).toEqual(fuseRRF(lists, 60));
    });
    it('mismatched weights.length → throws', () => {
      expect(() => fuseRRF([[1], [2]], 60, [1])).toThrow(/weights\.length/);
    });
    it('fractional weights work (router specific 1.0/0.4)', () => {
      // vec ranks id=5 first (1.0/61); fts ranks id=6 first (0.4/61) → 5 wins.
      const fused = fuseRRF([[5], [6]], 60, [1.0, 0.4]);
      expect(fused[0]).toBe(5);
    });
  });
});
