import { describe, it, expect } from 'vitest';
import { perturbations } from '../../src/core/lexicon-perturb.js';
import { HEDGE_WORDS_V1, ASSERTION_WORDS_V1 } from '../../src/core/drift.js';

const BASE_HEDGE = [...HEDGE_WORDS_V1];
const BASE_ASSERTION = [...ASSERTION_WORDS_V1];

describe('perturbations()', () => {
  it('includes a baseline (id "v1") that equals the input lexicons', () => {
    const list = perturbations(BASE_HEDGE, BASE_ASSERTION);
    const baseline = list.find((p) => p.id === 'v1');
    expect(baseline).toBeDefined();
    expect(baseline!.hedge).toEqual(BASE_HEDGE);
    expect(baseline!.assertion).toEqual(BASE_ASSERTION);
  });

  it('deterministic — same input twice yields identical perturbation list', () => {
    const a = perturbations(BASE_HEDGE, BASE_ASSERTION);
    const b = perturbations(BASE_HEDGE, BASE_ASSERTION);
    expect(a).toEqual(b);
  });

  it('n=5 → exactly 5 perturbations returned', () => {
    const list = perturbations(BASE_HEDGE, BASE_ASSERTION, 5);
    expect(list).toHaveLength(5);
  });

  it('default n is 10 or less', () => {
    const list = perturbations(BASE_HEDGE, BASE_ASSERTION);
    expect(list.length).toBeGreaterThan(0);
    expect(list.length).toBeLessThanOrEqual(10);
  });

  it('drop-one variants each remove exactly one lexicon word from baseline', () => {
    const list = perturbations(BASE_HEDGE, BASE_ASSERTION);
    const drops = list.filter((p) => p.id.startsWith('drop-'));
    expect(drops.length).toBeGreaterThan(0);
    for (const d of drops) {
      const hedgeDelta = BASE_HEDGE.length - d.hedge.length;
      const assertionDelta = BASE_ASSERTION.length - d.assertion.length;
      // each drop removes exactly one word from one lexicon
      expect(hedgeDelta + assertionDelta).toBe(1);
    }
  });

  it('all perturbation ids are unique', () => {
    const list = perturbations(BASE_HEDGE, BASE_ASSERTION);
    const ids = list.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('swap-synonym variants change at least one word from baseline lexicons', () => {
    const list = perturbations(BASE_HEDGE, BASE_ASSERTION);
    const swaps = list.filter((p) => p.id.startsWith('swap-'));
    // widen baselines → string[] so .includes accepts arbitrary perturbed words
    const hedgeBase: string[] = BASE_HEDGE;
    const assertionBase: string[] = BASE_ASSERTION;
    for (const s of swaps) {
      const hedgeChanged = s.hedge.some((w) => !hedgeBase.includes(w))
        || hedgeBase.some((w) => !s.hedge.includes(w));
      const assertionChanged = s.assertion.some((w) => !assertionBase.includes(w))
        || assertionBase.some((w) => !s.assertion.includes(w));
      expect(hedgeChanged || assertionChanged).toBe(true);
    }
  });
});
