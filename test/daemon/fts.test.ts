import { describe, it, expect } from 'vitest';
import { FtsIndex } from '../../src/daemon/fts.js';

describe('FtsIndex', () => {
  it('returns rowids of chunks matching query terms, bm25-ranked', () => {
    const fts = new FtsIndex();
    fts.add(0, 'feedback loops are the heart of every durable system');
    fts.add(1, 'spaced repetition exploits the forgetting curve');
    fts.add(2, 'optimize the system not the goal');
    const ids = fts.search('feedback loops', 5).map((r) => r.id);
    expect(ids[0]).toBe(0);
    expect(ids).not.toContain(1);
  });
  it('ranks a doc with more query-term hits higher', () => {
    const fts = new FtsIndex();
    fts.add(0, 'system');
    fts.add(1, 'system system feedback system');
    const ids = fts.search('system feedback', 5).map((r) => r.id);
    expect(ids[0]).toBe(1);
  });
  it('returns [] for no match and tolerates FTS-special characters', () => {
    const fts = new FtsIndex();
    fts.add(0, 'plain words here');
    expect(fts.search('zzzznomatch', 5)).toEqual([]);
    expect(() => fts.search('a "quote" and (paren) OR *', 5)).not.toThrow();
  });
  it('respects k', () => {
    const fts = new FtsIndex();
    for (let i = 0; i < 10; i++) fts.add(i, 'common term repeated');
    expect(fts.search('common', 3).length).toBeLessThanOrEqual(3);
  });
});
