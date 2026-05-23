import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from 'undici';
import { OpenAIEmbedder } from '../../src/daemon/openai-embedder.js';

let prev: Dispatcher;
let mock: MockAgent;
beforeEach(() => {
  prev = getGlobalDispatcher();
  mock = new MockAgent();
  mock.disableNetConnect();
  setGlobalDispatcher(mock);
});
afterEach(() => { setGlobalDispatcher(prev); });

function stub(embeddings: number[][]) {
  mock.get('https://api.example.com').intercept({ path: '/v1/embeddings', method: 'POST' }).reply(200, {
    data: embeddings.map((embedding, index) => ({ index, embedding })),
  });
}

describe('OpenAIEmbedder', () => {
  it('embeds texts via POST and returns Float32Array[]', async () => {
    stub([[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]]);
    const e = new OpenAIEmbedder({ baseURL: 'https://api.example.com/v1', apiKey: 'k', model: 'm' });
    const out = await e.embed(['a', 'b']);
    expect(out.length).toBe(2);
    expect(Array.from(out[0])).toEqual([0.1, 0.2, 0.3].map((x) => Math.fround(x)));
  });
  it('probe() sets dimensions from a one-string embed', async () => {
    stub([[0, 1, 2, 3, 4]]);
    const e = new OpenAIEmbedder({ baseURL: 'https://api.example.com/v1', apiKey: 'k', model: 'm' });
    expect(await e.probe()).toBe(5);
    expect(e.dimensions).toBe(5);
  });
  it('throws on a non-2xx response', async () => {
    mock.get('https://api.example.com').intercept({ path: '/v1/embeddings', method: 'POST' }).reply(401, { error: 'nope' });
    const e = new OpenAIEmbedder({ baseURL: 'https://api.example.com/v1', apiKey: 'bad', model: 'm' });
    await expect(e.embed(['x'])).rejects.toThrow();
  });
});
