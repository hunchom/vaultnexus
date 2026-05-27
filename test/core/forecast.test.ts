import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseForecast, parseResolved, brierScore } from '../../src/core/forecast.js';
import type { ResolvedForecast } from '../../src/core/forecast.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');

describe('parseForecast', () => {
  it('parses full forecast frontmatter → Forecast object w/ default probability 0.5', () => {
    const src = [
      '---',
      'forecast:',
      '  claim: "X happens"',
      '  by: 2027-01-01',
      '  marked_at: 2024-11-01',
      '---',
      '',
      '# body',
    ].join('\n');
    const got = parseForecast(src, 'notes/x.md');
    // YAML date scalars → Date → full ISO (consistent shape across all timestamps)
    expect(got).toEqual({
      notePath: 'notes/x.md',
      claim: 'X happens',
      by: '2027-01-01T00:00:00.000Z',
      markedAt: '2024-11-01T00:00:00.000Z',
      probability: 0.5,
    });
  });

  it('parses explicit probability when present', () => {
    const src = [
      '---',
      'forecast:',
      '  claim: "Y happens"',
      '  by: 2027-01-01',
      '  marked_at: 2024-11-01',
      '  probability: 0.8',
      '---',
      '',
      'body',
    ].join('\n');
    const got = parseForecast(src, 'n.md');
    expect(got?.probability).toBe(0.8);
  });

  it('no frontmatter → undefined', () => {
    expect(parseForecast('# just a heading\n', 'a.md')).toBeUndefined();
  });

  it('frontmatter present but no forecast key → undefined', () => {
    const src = ['---', 'title: foo', 'date: 2024-01-01', '---', '', 'body'].join('\n');
    expect(parseForecast(src, 'a.md')).toBeUndefined();
  });

  it('forecast missing required fields (no claim) → undefined', () => {
    const src = ['---', 'forecast:', '  by: 2027-01-01', '---', '', 'body'].join('\n');
    expect(parseForecast(src, 'a.md')).toBeUndefined();
  });

  it('clamps out-of-range probability to [0,1] via undefined (treated as invalid → default)', () => {
    const src = [
      '---',
      'forecast:',
      '  claim: "Z"',
      '  by: 2027-01-01',
      '  marked_at: 2024-11-01',
      '  probability: 1.5',
      '---',
    ].join('\n');
    const got = parseForecast(src, 'a.md');
    expect(got?.probability).toBe(0.5);
  });

  it('Plan 14 demo note parses without error', () => {
    const src = readFileSync(
      join(REPO_ROOT, 'demo-vault-seeded/notes/decisions/ai-capabilities-2027.md'),
      'utf8',
    );
    const got = parseForecast(src, 'notes/decisions/ai-capabilities-2027.md');
    expect(got).toBeDefined();
    expect(got!.claim.startsWith('By end of 2027')).toBe(true);
    expect(got!.probability).toBe(0.5);
  });

  // probability bounds — invalid types/values → default 0.5 (max uncertainty)
  describe('probability bounds → defaults to 0.5', () => {
    const base = (probLine: string) =>
      [
        '---',
        'forecast:',
        '  claim: "X"',
        '  by: 2027-01-01',
        '  marked_at: 2024-11-01',
        `  probability: ${probLine}`,
        '---',
      ].join('\n');

    it.each([
      ['null', 'null'],
      ['string ("high")', '"high"'],
      ['negative (-0.2)', '-0.2'],
      ['above 1 (1.5)', '1.5'],
      ['NaN (.nan)', '.nan'],
    ])('%s → 0.5', (_label, yamlVal) => {
      const got = parseForecast(base(yamlVal), 'a.md');
      expect(got?.probability).toBe(0.5);
    });
  });

  it('extra frontmatter keys (tags, confidence) parse cleanly', () => {
    const src = [
      '---',
      'tags: [foo, bar]',
      'confidence: high',
      'forecast:',
      '  claim: "Z"',
      '  by: 2027-01-01',
      '  marked_at: 2024-11-01',
      '  probability: 0.7',
      '---',
      '',
      'body',
    ].join('\n');
    const got = parseForecast(src, 'a.md');
    expect(got).toEqual({
      notePath: 'a.md',
      claim: 'Z',
      by: '2027-01-01T00:00:00.000Z',
      markedAt: '2024-11-01T00:00:00.000Z',
      probability: 0.7,
    });
  });

  it('empty claim ("") → undefined', () => {
    const src = [
      '---',
      'forecast:',
      '  claim: ""',
      '  by: 2027-01-01',
      '  marked_at: 2024-11-01',
      '---',
    ].join('\n');
    expect(parseForecast(src, 'a.md')).toBeUndefined();
  });

  it('YAML date scalar → full ISO timestamp (not date-only)', () => {
    // YAML '2027-12-31' → Date → '2027-12-31T00:00:00.000Z' (full ISO)
    const src = [
      '---',
      'forecast:',
      '  claim: "X"',
      '  by: 2027-12-31',
      '  marked_at: 2024-11-01',
      '---',
    ].join('\n');
    const got = parseForecast(src, 'a.md');
    expect(got?.by).toBe('2027-12-31T00:00:00.000Z');
  });
});

describe('parseResolved', () => {
  it('parses resolved frontmatter → { outcome, resolvedAt }', () => {
    const src = [
      '---',
      'forecast:',
      '  claim: "X"',
      '  by: 2027-01-01',
      '  marked_at: 2024-11-01',
      'resolved:',
      '  outcome: true',
      '  resolved_at: 2024-12-01',
      '---',
    ].join('\n');
    expect(parseResolved(src)).toEqual({ outcome: true, resolvedAt: '2024-12-01T00:00:00.000Z' });
  });

  it('no resolved key → undefined', () => {
    const src = ['---', 'forecast:', '  claim: "X"', '---'].join('\n');
    expect(parseResolved(src)).toBeUndefined();
  });

  it('resolved missing outcome → undefined', () => {
    const src = ['---', 'resolved:', '  resolved_at: 2024-12-01', '---'].join('\n');
    expect(parseResolved(src)).toBeUndefined();
  });

  it('non-bool outcome → undefined', () => {
    const src = [
      '---',
      'resolved:',
      '  outcome: maybe',
      '  resolved_at: 2024-12-01',
      '---',
    ].join('\n');
    expect(parseResolved(src)).toBeUndefined();
  });

  it('Plan 14 demo note has no resolved frontmatter', () => {
    const src = readFileSync(
      join(REPO_ROOT, 'demo-vault-seeded/notes/decisions/personal-blog-growth.md'),
      'utf8',
    );
    expect(parseResolved(src)).toBeUndefined();
  });
});

describe('brierScore', () => {
  it('empty array → null', () => {
    expect(brierScore([])).toBeNull();
  });

  it('single perfect prediction → 0', () => {
    const f: ResolvedForecast = {
      notePath: 'a.md',
      claim: 'x',
      by: '2027-01-01',
      markedAt: '2024-01-01',
      probability: 1,
      outcome: true,
      resolvedAt: '2024-12-01',
    };
    expect(brierScore([f])).toBe(0);
  });

  it('single {p:0.8, outcome:true} → 0.04', () => {
    const f: ResolvedForecast = {
      notePath: 'a.md',
      claim: 'x',
      by: '2027-01-01',
      markedAt: '2024-01-01',
      probability: 0.8,
      outcome: true,
      resolvedAt: '2024-12-01',
    };
    expect(brierScore([f])).toBeCloseTo(0.04, 10);
  });

  it('mixed: {p:0.7,true} + {p:0.3,false} → 0.09', () => {
    const a: ResolvedForecast = {
      notePath: 'a.md', claim: 'a', by: '2027-01-01', markedAt: '2024-01-01',
      probability: 0.7, outcome: true, resolvedAt: '2024-12-01',
    };
    const b: ResolvedForecast = {
      notePath: 'b.md', claim: 'b', by: '2027-01-01', markedAt: '2024-01-01',
      probability: 0.3, outcome: false, resolvedAt: '2024-12-01',
    };
    expect(brierScore([a, b])).toBeCloseTo(0.09, 10);
  });
});
