import { describe, it, expect } from 'vitest';
import { FakeEmbedder } from '../../src/core/embedder.js';
import { OpenAIEmbedder } from '../../src/daemon/openai-embedder.js';
import { CachingEmbedder } from '../../src/daemon/caching-embedder.js';
import { EmbeddingCache } from '../../src/daemon/embedding-cache.js';

// id field powers /status display + plugin status panel.
describe('Embedder.id', () => {
  it('FakeEmbedder reports fake', () => {
    expect(new FakeEmbedder(32).id).toBe('fake');
  });

  it('OpenAIEmbedder reports its configured model', () => {
    const e = new OpenAIEmbedder({ baseURL: 'http://localhost', apiKey: 'k', model: 'voyage-3-large' });
    expect(e.id).toBe('voyage-3-large');
  });

  it('CachingEmbedder forwards inner embedder id', () => {
    const inner = new FakeEmbedder(16);
    const cache = new EmbeddingCache(':memory:');
    const c = new CachingEmbedder(inner, cache, 'fake');
    expect(c.id).toBe('fake');
    cache.close();
  });
});
