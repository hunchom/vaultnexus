import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from 'undici';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectEmbedder } from '../../src/daemon/select-embedder.js';
import { FakeEmbedder } from '../../src/core/embedder.js';
import { OpenAIEmbedder } from '../../src/daemon/openai-embedder.js';
import { CachingEmbedder } from '../../src/daemon/caching-embedder.js';

let prev: Dispatcher; let mock: MockAgent;
beforeEach(() => { prev = getGlobalDispatcher(); mock = new MockAgent(); mock.disableNetConnect(); setGlobalDispatcher(mock); });
afterEach(() => { setGlobalDispatcher(prev); });

describe('selectEmbedder', () => {
  it('defaults to FakeEmbedder when no embed env is set', async () => {
    const e = await selectEmbedder({});
    expect(e).toBeInstanceOf(FakeEmbedder);
    expect(e.dimensions).toBeGreaterThan(0);
  });
  it('honors VAULTNEXUS_FAKE_DIMS', async () => {
    const e = await selectEmbedder({ VAULTNEXUS_FAKE_DIMS: '128' });
    expect(e.dimensions).toBe(128);
  });
  it('builds a raw OpenAIEmbedder and probes dims when embed env is set + cache off', async () => {
    mock.get('https://api.example.com').intercept({ path: '/v1/embeddings', method: 'POST' })
      .reply(200, { data: [{ index: 0, embedding: [0, 1, 2, 3] }] });
    const e = await selectEmbedder({
      VAULTNEXUS_EMBED_URL: 'https://api.example.com/v1',
      VAULTNEXUS_EMBED_KEY: 'k', VAULTNEXUS_EMBED_MODEL: 'm', VAULTNEXUS_CACHE: 'off',
    });
    expect(e).toBeInstanceOf(OpenAIEmbedder);
    expect(e.dimensions).toBe(4);
  });
  it('wraps the real embedder in CachingEmbedder when a cache path is set', async () => {
    mock.get('https://api.example.com').intercept({ path: '/v1/embeddings', method: 'POST' })
      .reply(200, { data: [{ index: 0, embedding: [0, 1, 2, 3] }] });
    const e = await selectEmbedder({
      VAULTNEXUS_EMBED_URL: 'https://api.example.com/v1',
      VAULTNEXUS_EMBED_KEY: 'k', VAULTNEXUS_EMBED_MODEL: 'm',
      VAULTNEXUS_CACHE: join(mkdtempSync(join(tmpdir(), 'vn-sel-')), 'e.db'),
    });
    expect(e).toBeInstanceOf(CachingEmbedder);
    expect(e.dimensions).toBe(4); // delegates to wrapped OpenAIEmbedder
    (e as CachingEmbedder).close();
  });
});
