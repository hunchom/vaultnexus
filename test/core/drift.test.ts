import { describe, it, expect } from 'vitest';
import { conviction } from '../../src/core/drift.js';

describe('conviction', () => {
  it('empty string → 0', () => {
    expect(conviction('')).toBe(0);
    expect(conviction('   ')).toBe(0);
  });

  it('pure hedge → negative density', () => {
    // 3 hedges / 3 words = -1
    expect(conviction('maybe maybe maybe')).toBe(-1);
    // mixed hedge words still negative
    expect(conviction('perhaps the answer might be wrong')).toBeLessThan(0);
  });

  it('pure assertion → positive density', () => {
    // 3 assertions / 3 words = +1
    expect(conviction('definitely always never')).toBe(1);
    expect(conviction('this is clearly essential')).toBeGreaterThan(0);
  });

  it('balanced mix → near zero', () => {
    // 1 hedge + 1 assertion / 2 words = 0
    expect(conviction('maybe definitely')).toBe(0);
  });

  it('case-insensitive matching', () => {
    expect(conviction('Maybe MAYBE')).toBe(-1);
    expect(conviction('DEFINITELY')).toBe(1);
  });

  it('word-bounded — substrings do not match', () => {
    // 'mustard' must not count as 'must'
    expect(conviction('mustard is delicious')).toBe(0);
    // 'maybesomething' must not match 'maybe'
    expect(conviction('maybesomething happened')).toBe(0);
  });

  it('multi-word phrase "kind of" counts as ONE hedge, not zero', () => {
    // 3 words, 1 hedge phrase → -1/3
    expect(conviction('kind of working')).toBeCloseTo(-1 / 3, 5);
  });

  it('multi-word phrase does not double-count constituent words', () => {
    // 'kind' alone is not in lexicon; only the 'kind of' phrase counts
    expect(conviction('kind people')).toBe(0);
  });
});
