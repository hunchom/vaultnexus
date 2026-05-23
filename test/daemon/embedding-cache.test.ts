import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EmbeddingCache } from '../../src/daemon/embedding-cache.js';

const tmpDb = () => join(mkdtempSync(join(tmpdir(), 'vn-cache-')), 'e.db');

describe('EmbeddingCache', () => {
  it('round-trips vectors by key, miss → undefined', () => {
    const c = new EmbeddingCache(tmpDb());
    expect(c.getMany(['k1'])).toEqual([undefined]);
    c.setMany([{ key: 'k1', vec: new Float32Array([0.5, -0.25, 1]) }]);
    const [got] = c.getMany(['k1']);
    expect(Array.from(got!)).toEqual([0.5, -0.25, 1]);
    c.close();
  });
  it('persists across reopen of the same file', () => {
    const path = tmpDb();
    const a = new EmbeddingCache(path);
    a.setMany([{ key: 'x', vec: new Float32Array([1, 2, 3, 4]) }]);
    a.close();
    const b = new EmbeddingCache(path);
    expect(Array.from(b.getMany(['x'])[0]!)).toEqual([1, 2, 3, 4]);
    b.close();
  });
  it('getMany preserves order with mixed hit/miss', () => {
    const c = new EmbeddingCache(tmpDb());
    c.setMany([{ key: 'a', vec: new Float32Array([1]) }, { key: 'c', vec: new Float32Array([3]) }]);
    const got = c.getMany(['a', 'b', 'c']);
    expect(got.map((v) => (v ? v[0] : null))).toEqual([1, null, 3]);
    c.close();
  });
});
