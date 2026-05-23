import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CachingEmbedder } from '../../src/daemon/caching-embedder.js';
import { EmbeddingCache } from '../../src/daemon/embedding-cache.js';
import { FakeEmbedder } from '../../src/core/embedder.js';

const tmpDb = () => join(mkdtempSync(join(tmpdir(), 'vn-ce-')), 'e.db');

class CountingEmbedder extends FakeEmbedder {
  public embedded: string[] = [];
  async embed(texts: string[]): Promise<Float32Array[]> { this.embedded.push(...texts); return super.embed(texts); }
}

describe('CachingEmbedder', () => {
  it('embeds only cache misses, returns input order', async () => {
    const base = new CountingEmbedder(32);
    const ce = new CachingEmbedder(base, new EmbeddingCache(tmpDb()), 'm1');
    const first = await ce.embed(['alpha', 'beta']);
    expect(base.embedded).toEqual(['alpha', 'beta']);
    const second = await ce.embed(['beta', 'gamma']);
    expect(base.embedded).toEqual(['alpha', 'beta', 'gamma']); // only gamma newly embedded
    expect(Array.from(second[0])).toEqual(Array.from(first[1])); // beta vec stable from cache
    ce.close();
  });
  it('namespace (model) scopes the cache — different model re-embeds', async () => {
    const cache = new EmbeddingCache(tmpDb());
    const b1 = new CountingEmbedder(16);
    await new CachingEmbedder(b1, cache, 'modelA').embed(['x']);
    const b2 = new CountingEmbedder(16);
    await new CachingEmbedder(b2, cache, 'modelB').embed(['x']);
    expect(b2.embedded).toEqual(['x']); // modelB miss despite same text
    cache.close();
  });
});
