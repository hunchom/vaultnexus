import { describe, it, expect } from 'vitest';
import {
  conviction,
  convictionSlope,
  supportingClaimSlope,
  driftFlag,
  type DriftRevision,
} from '../../src/core/drift.js';

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

describe('driftFlag', () => {
  // 100 filler words ('word' repeated) → conviction = (assertions - hedges) / 100
  // → adding N assertion words yields ≈ N/100 conviction (assertions are 1 word each in count)
  const FILLER = 'word '.repeat(100).trim();

  /** Synthesize text targeting a given conviction density via assertion-word count. */
  function textWithConviction(density: number): string {
    // 100 filler words + K assertion words → (K - 0) / (100 + K)
    // Solve: density = K / (100 + K) → K = 100 * density / (1 - density). Round to nearest int.
    const k = Math.max(0, Math.round((100 * density) / Math.max(1e-9, 1 - density)));
    const assertions = Array.from({ length: k }, () => 'definitely').join(' ');
    return assertions ? `${assertions} ${FILLER}` : FILLER;
  }

  // Pathological: conviction climbs (≈0.01 → 0.04 → 0.08), supporting flat at 1.
  it('pathological case → fires with conviction-up-supporting-flat', () => {
    const revisions: DriftRevision[] = [
      { date: '2024-01-01', content: textWithConviction(0.01), supportingClaimCount: 1 },
      { date: '2024-02-01', content: textWithConviction(0.04), supportingClaimCount: 1 },
      { date: '2024-03-01', content: textWithConviction(0.08), supportingClaimCount: 1 },
    ];
    const flag = driftFlag('notes/x.md', revisions, {
      minConvictionSlope: 0.0005,
      maxSupportingSlope: 0.005,
    });
    expect(flag).not.toBeNull();
    expect(flag!.reason).toBe('conviction-up-supporting-flat');
    expect(flag!.notePath).toBe('notes/x.md');
    expect(flag!.convictionSlope).toBeGreaterThan(0.0005);
    expect(flag!.supportingClaimSlope).toBeLessThanOrEqual(0.005);
    expect(flag!.samples).toHaveLength(3);
  });

  // Confound-discrimination: healthy settling = both rise → must NOT fire.
  // LOAD-BEARING: prior session's killed claim was that drift would fail its own gate
  // due to conviction↔evidence-count natural correlation. AND-with-tolerance rule
  // discriminates: supporting rising (≥0.05/day) above maxSupportingSlope tolerance → null.
  it('healthy-settling confound case → null (supporting also rises)', () => {
    const revisions: DriftRevision[] = [
      { date: '2024-01-01', content: textWithConviction(0.01), supportingClaimCount: 1 },
      { date: '2024-02-01', content: textWithConviction(0.04), supportingClaimCount: 3 },
      { date: '2024-03-01', content: textWithConviction(0.08), supportingClaimCount: 5 },
    ];
    const flag = driftFlag('notes/x.md', revisions, {
      minConvictionSlope: 0.0005,
      maxSupportingSlope: 0.005,
    });
    expect(flag).toBeNull();
  });

  it('noise case → null (conviction zigzags below threshold)', () => {
    const revisions: DriftRevision[] = [
      { date: '2024-01-01', content: textWithConviction(0.02), supportingClaimCount: 1 },
      { date: '2024-02-01', content: textWithConviction(0.03), supportingClaimCount: 1 },
      { date: '2024-03-01', content: textWithConviction(0.02), supportingClaimCount: 1 },
    ];
    const flag = driftFlag('notes/x.md', revisions, {
      minConvictionSlope: 0.0005,
      maxSupportingSlope: 0.005,
    });
    expect(flag).toBeNull();
  });

  it('too-few-revisions case → null regardless of slopes', () => {
    const revisions: DriftRevision[] = [
      { date: '2024-01-01', content: textWithConviction(0.01), supportingClaimCount: 1 },
      { date: '2024-03-01', content: textWithConviction(0.08), supportingClaimCount: 1 },
    ];
    expect(driftFlag('notes/x.md', revisions)).toBeNull();
    expect(driftFlag('notes/x.md', [])).toBeNull();
    expect(driftFlag('notes/x.md', [revisions[0]])).toBeNull();
  });

  it('uses default thresholds when opts omitted', () => {
    // Same pathological case, default opts → must still fire
    const revisions: DriftRevision[] = [
      { date: '2024-01-01', content: textWithConviction(0.01), supportingClaimCount: 1 },
      { date: '2024-02-01', content: textWithConviction(0.04), supportingClaimCount: 1 },
      { date: '2024-03-01', content: textWithConviction(0.08), supportingClaimCount: 1 },
    ];
    expect(driftFlag('notes/x.md', revisions)).not.toBeNull();
  });
});
