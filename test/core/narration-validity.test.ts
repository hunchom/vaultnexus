import { describe, it, expect } from 'vitest';
import {
  extractShaCitations,
  validateShaCitations,
} from '../../src/core/narration-validity.js';
import type { Revision } from '../../src/daemon/git-history.js';

// minimal revision builder → only sha matters for prefix validation
function rev(sha: string): Revision {
  return { sha, commitDate: '2024-01-01T00:00:00Z', message: 'm', authorEmail: 'a@b' };
}

describe('extractShaCitations', () => {
  it('extracts three citations from mixed prose', () => {
    const got = extractShaCitations(
      'Started [sha:abc1234 @ 2024-03-15] then [sha:def5678 @ 2024-06-10] then [sha:badbeef @ 2024-10-22]',
    );
    expect(got).toEqual([
      { raw: '[sha:abc1234 @ 2024-03-15]', sha: 'abc1234', date: '2024-03-15' },
      { raw: '[sha:def5678 @ 2024-06-10]', sha: 'def5678', date: '2024-06-10' },
      { raw: '[sha:badbeef @ 2024-10-22]', sha: 'badbeef', date: '2024-10-22' },
    ]);
  });

  it('empty array when no citations present', () => {
    expect(extractShaCitations('no citations')).toEqual([]);
  });

  it('tolerates ISO timestamp w/ time component', () => {
    const got = extractShaCitations('[sha:1234567 @ 2024-03-15T10:30:00Z]');
    expect(got).toEqual([
      { raw: '[sha:1234567 @ 2024-03-15T10:30:00Z]', sha: '1234567', date: '2024-03-15T10:30:00Z' },
    ]);
  });

  it('no-whitespace variant matches', () => {
    const got = extractShaCitations('[sha:abc1234@2024-03-15]');
    expect(got).toEqual([
      { raw: '[sha:abc1234@2024-03-15]', sha: 'abc1234', date: '2024-03-15' },
    ]);
  });

  it('SHA shorter than 7 chars → no match', () => {
    expect(extractShaCitations('[sha:abc12 @ 2024-03-15]')).toEqual([]);
  });

  it('full 40-char SHA matches', () => {
    const full = 'a'.repeat(40);
    const got = extractShaCitations(`[sha:${full} @ 2024-03-15]`);
    expect(got.length).toBe(1);
    expect(got[0].sha).toBe(full);
  });
});

describe('validateShaCitations', () => {
  it('prefix-matches short SHA against full revision SHA', () => {
    const revs = [rev('abc1234deadbeef0000000000000000000000000'), rev('def5678cafebabe0000000000000000000000000')];
    const citations = extractShaCitations('[sha:abc1234 @ 2024-03-15] [sha:def5678 @ 2024-06-10]');
    const { valid, invalid } = validateShaCitations(citations, revs);
    expect(valid.map((c) => c.raw)).toEqual([
      '[sha:abc1234 @ 2024-03-15]',
      '[sha:def5678 @ 2024-06-10]',
    ]);
    expect(invalid).toEqual([]);
  });

  it('partitions valid vs invalid by SHA-prefix', () => {
    const revs = [rev('abc1234deadbeef0000000000000000000000000')];
    const citations = extractShaCitations(
      '[sha:abc1234 @ 2024-03-15] [sha:badbeef @ 2024-10-22]',
    );
    const { valid, invalid } = validateShaCitations(citations, revs);
    expect(valid.map((c) => c.sha)).toEqual(['abc1234']);
    expect(invalid.map((c) => c.sha)).toEqual(['badbeef']);
  });

  it('empty citations → empty partitions', () => {
    expect(validateShaCitations([], [rev('abc1234deadbeef0000000000000000000000000')]))
      .toEqual({ valid: [], invalid: [] });
  });

  it('empty revisions → all citations invalid', () => {
    const cs = extractShaCitations('[sha:abc1234 @ 2024-03-15]');
    const { valid, invalid } = validateShaCitations(cs, []);
    expect(valid).toEqual([]);
    expect(invalid.length).toBe(1);
  });

  it('full-SHA citation also matches (startsWith is reflexive)', () => {
    const full = 'a'.repeat(40);
    const revs = [rev(full)];
    const cs = extractShaCitations(`[sha:${full} @ 2024-03-15]`);
    const { valid } = validateShaCitations(cs, revs);
    expect(valid.length).toBe(1);
  });

  it('ambiguous prefix (2+ revisions share it) → invalid', () => {
    // two revs share the prefix 'abc1234' → cannot disambiguate
    const revs = [
      rev('abc1234deadbeef0000000000000000000000000'),
      rev('abc1234cafebabe1111111111111111111111111'),
    ];
    const cs = extractShaCitations('[sha:abc1234 @ 2024-03-15]');
    const { valid, invalid } = validateShaCitations(cs, revs);
    expect(valid).toEqual([]);
    expect(invalid.length).toBe(1);
    expect(invalid[0].sha).toBe('abc1234');
  });

  it('degenerate short prefix (all same hex char) → ambiguous → invalid', () => {
    // model emits '[sha:aaaaaaa @ ...]' → matches multiple unrelated SHAs starting w/ 'a'
    const revs = [
      rev('aaaaaaa1111111111111111111111111111111aa'),
      rev('aaaaaaa2222222222222222222222222222222aa'),
      rev('bbbbbbb0000000000000000000000000000000bb'),
    ];
    const cs = extractShaCitations('[sha:aaaaaaa @ 2024-03-15]');
    const { valid, invalid } = validateShaCitations(cs, revs);
    expect(valid).toEqual([]);
    expect(invalid.length).toBe(1);
  });
});
