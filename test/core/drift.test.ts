import { describe, it, expect } from 'vitest';
import { conviction, convictionSlope, supportingClaimSlope } from '../../src/core/drift.js';

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

describe('convictionSlope', () => {
  it('n < 2 → 0', () => {
    expect(convictionSlope([])).toBe(0);
    expect(convictionSlope([{ date: '2024-01-01', score: 0.5 }])).toBe(0);
  });

  it('linear rise over ~60 days → strictly positive, ≈ 0.0017/day ±10%', () => {
    const slope = convictionSlope([
      { date: '2024-01-01', score: 0.0 },
      { date: '2024-01-31', score: 0.05 },
      { date: '2024-03-02', score: 0.10 },
    ]);
    expect(slope).toBeGreaterThan(0);
    // 0.10 / 61 days ≈ 0.001639/day
    expect(slope).toBeGreaterThan(0.0017 * 0.9);
    expect(slope).toBeLessThan(0.0017 * 1.1);
  });

  it('flat line → slope 0 (float-tolerant)', () => {
    // IEEE 754: y_i - y_mean is sub-epsilon, not exact zero
    expect(convictionSlope([
      { date: '2024-01-01', score: 0.05 },
      { date: '2024-02-01', score: 0.05 },
      { date: '2024-03-01', score: 0.05 },
    ])).toBeCloseTo(0, 10);
  });

  it('decreasing sequence → negative slope', () => {
    const slope = convictionSlope([
      { date: '2024-01-01', score: 0.10 },
      { date: '2024-02-01', score: 0.05 },
      { date: '2024-03-01', score: 0.00 },
    ]);
    expect(slope).toBeLessThan(0);
  });

  it('all dates equal → slope 0 (div-by-zero guard)', () => {
    expect(convictionSlope([
      { date: '2024-01-01', score: 0.0 },
      { date: '2024-01-01', score: 0.5 },
      { date: '2024-01-01', score: 1.0 },
    ])).toBe(0);
  });
});

describe('supportingClaimSlope', () => {
  it('n < 2 → 0', () => {
    expect(supportingClaimSlope([])).toBe(0);
    expect(supportingClaimSlope([{ date: '2024-01-01', count: 3 }])).toBe(0);
  });

  it('rising counts → positive slope', () => {
    const slope = supportingClaimSlope([
      { date: '2024-01-01', count: 1 },
      { date: '2024-02-01', count: 3 },
      { date: '2024-03-01', count: 5 },
    ]);
    expect(slope).toBeGreaterThan(0);
  });

  it('flat counts → slope 0', () => {
    expect(supportingClaimSlope([
      { date: '2024-01-01', count: 2 },
      { date: '2024-02-01', count: 2 },
      { date: '2024-03-01', count: 2 },
    ])).toBe(0);
  });
});
