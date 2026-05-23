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
});
