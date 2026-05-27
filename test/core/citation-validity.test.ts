import { describe, it, expect } from 'vitest';
import { extractCitations, validateCitations } from '../../src/core/citation-validity.js';
import type { ReasonHop } from '../../src/daemon/reason-trace.js';
import type { IndexedChunk } from '../../src/daemon/vault-index.js';

// minimal hop builder → only chunk triple (notePath, byteStart, byteEnd) matters for validation
function hop(notePath: string, byteStart: number, byteEnd: number): ReasonHop {
  const chunk: IndexedChunk = { notePath, headingPath: [], text: '', byteStart, byteEnd };
  return { step: 0, fromChunkId: null, toChunkId: 0, edgeType: 'seed', score: 1, chunk };
}

describe('extractCitations', () => {
  it('extracts two citations from mixed prose', () => {
    const got = extractCitations('foo [ref:a/b.md:10-20] bar [ref:c.md:30-40] baz');
    expect(got).toEqual([
      { raw: '[ref:a/b.md:10-20]', notePath: 'a/b.md', byteStart: 10, byteEnd: 20 },
      { raw: '[ref:c.md:30-40]', notePath: 'c.md', byteStart: 30, byteEnd: 40 },
    ]);
  });

  it('empty array when no citations present', () => {
    expect(extractCitations('no citations here')).toEqual([]);
  });

  it('paths with spaces extract (regex permits non-colon non-bracket chars)', () => {
    const got = extractCitations('[ref:weird path:0-10]');
    expect(got).toEqual([
      { raw: '[ref:weird path:0-10]', notePath: 'weird path', byteStart: 0, byteEnd: 10 },
    ]);
  });

  it('malformed (no byte range) → no match', () => {
    expect(extractCitations('[ref:malformed]')).toEqual([]);
  });

  it('duplicate citations same text → both extract (no dedup)', () => {
    const got = extractCitations('[ref:a.md:0-10] [ref:a.md:0-10]');
    expect(got).toHaveLength(2);
    expect(got[0]).toEqual(got[1]);
  });

  it('adjacent no-whitespace citations → both extract', () => {
    const got = extractCitations('[ref:a.md:0-10][ref:b.md:0-10]');
    expect(got.map((c) => c.notePath)).toEqual(['a.md', 'b.md']);
  });

  it('unicode in notePath matches (regex char class is byte-agnostic)', () => {
    const got = extractCitations('[ref:αβ/日本.md:0-10]');
    expect(got).toHaveLength(1);
    expect(got[0].notePath).toBe('αβ/日本.md');
  });

  it('citation spanning newline in notePath → rejected', () => {
    // notePath cannot contain '\n' — vault paths are single-line
    const got = extractCitations('[ref:a\nb.md:0-10]');
    expect(got).toEqual([]);
  });
});

describe('validateCitations', () => {
  it('partitions into valid + invalid by exact triple match', () => {
    const hops = [hop('a.md', 0, 50), hop('b.md', 10, 20)];
    const citations = extractCitations(
      '[ref:a.md:0-50] [ref:b.md:10-20] [ref:a.md:0-49] [ref:c.md:0-50]',
    );
    const { valid, invalid } = validateCitations(citations, hops);
    expect(valid.map((c) => c.raw)).toEqual(['[ref:a.md:0-50]', '[ref:b.md:10-20]']);
    expect(invalid.map((c) => c.raw)).toEqual(['[ref:a.md:0-49]', '[ref:c.md:0-50]']);
  });

  it('empty citations → empty partitions', () => {
    expect(validateCitations([], [hop('a.md', 0, 1)])).toEqual({ valid: [], invalid: [] });
  });

  it('empty hops → all citations invalid', () => {
    const cs = extractCitations('[ref:a.md:0-1]');
    const { valid, invalid } = validateCitations(cs, []);
    expect(valid).toEqual([]);
    expect(invalid.length).toBe(1);
  });
});
