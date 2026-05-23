import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from 'undici';
import { selectEmbedder } from '../../src/daemon/select-embedder.js';
import { FakeEmbedder } from '../../src/core/embedder.js';
import { OpenAIEmbedder } from '../../src/daemon/openai-embedder.js';

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
  it('builds an OpenAIEmbedder and probes dims when embed env is set', async () => {
    mock.get('https://api.example.com').intercept({ path: '/v1/embeddings', method: 'POST' })
      .reply(200, { data: [{ index: 0, embedding: [0, 1, 2, 3] }] });
    const e = await selectEmbedder({
      VAULTNEXUS_EMBED_URL: 'https://api.example.com/v1',
      VAULTNEXUS_EMBED_KEY: 'k', VAULTNEXUS_EMBED_MODEL: 'm',
    });
    expect(e).toBeInstanceOf(OpenAIEmbedder);
    expect(e.dimensions).toBe(4);
  });
});
