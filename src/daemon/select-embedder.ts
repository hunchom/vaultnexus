import { FakeEmbedder, type Embedder } from '../core/embedder.js';
import { OpenAIEmbedder } from './openai-embedder.js';

type Env = Record<string, string | undefined>;

/** Pick embedder from env: OpenAI-compat if URL+KEY+MODEL set, else offline FakeEmbedder. */
export async function selectEmbedder(env: Env = process.env): Promise<Embedder> {
  const baseURL = env.VAULTNEXUS_EMBED_URL;
  const apiKey = env.VAULTNEXUS_EMBED_KEY;
  const model = env.VAULTNEXUS_EMBED_MODEL;
  if (baseURL && apiKey && model) {
    const e = new OpenAIEmbedder({ baseURL, apiKey, model });
    await e.probe();
    return e;
  }
  const dims = Number(env.VAULTNEXUS_FAKE_DIMS ?? 256);
  return new FakeEmbedder(Number.isFinite(dims) && dims > 0 ? dims : 256);
}
