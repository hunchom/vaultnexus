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
    expect(low).toBeCloseTo(1 / Math.log2(3));
  });
  it('two relevant docs, ideal ordering → 1.0', () => {
    expect(ndcgAtK(['a', 'b', 'c'], new Set(['a', 'b']), 3)).toBeCloseTo(1);
  });
});
