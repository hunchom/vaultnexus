import { FakeEmbedder, type Embedder } from '../core/embedder.js';
import { OpenAIEmbedder } from './openai-embedder.js';
import { NomicEmbedder } from './nomic-embedder.js';
import { CachingEmbedder } from './caching-embedder.js';
import { EmbeddingCache } from './embedding-cache.js';
import { defaultCachePath } from '../core/paths.js';

type Env = Record<string, string | undefined>;

// Default = openai-compatible (Voyage / OpenAI / Ollama / vLLM / Nomic Atlas's /v1/embeddings).
// Explicit VAULTNEXUS_EMBED_PROVIDER=nomic switches to the Atlas native /embedding/text shape.
// No URL heuristic → user keeps full control. Both Nomic Atlas paths are reachable now.
function pickProvider(env: Env): 'nomic' | 'openai-compatible' {
  const explicit = (env.VAULTNEXUS_EMBED_PROVIDER ?? '').toLowerCase();
  if (explicit === 'nomic' || explicit === 'nomic-atlas') return 'nomic';
  return 'openai-compatible';
}

/** Pick embedder from env. Real provider when URL+KEY+MODEL set; FakeEmbedder otherwise. */
export async function selectEmbedder(env: Env = process.env): Promise<Embedder> {
  const baseURL = env.VAULTNEXUS_EMBED_URL;
  const apiKey = env.VAULTNEXUS_EMBED_KEY;
  const model = env.VAULTNEXUS_EMBED_MODEL;
  if (baseURL && apiKey && model) {
    const provider = pickProvider(env);
    const e = provider === 'nomic'
      ? new NomicEmbedder({
          baseURL, apiKey, model,
          taskType: (env.VAULTNEXUS_NOMIC_TASK_TYPE as never),
        })
      : new OpenAIEmbedder({ baseURL, apiKey, model });
    await e.probe();
    const cachePath = defaultCachePath(env);
    if (cachePath === 'off') return e;
    return new CachingEmbedder(e, new EmbeddingCache(cachePath), model);
  }
  const dims = Number(env.VAULTNEXUS_FAKE_DIMS ?? 256);
  return new FakeEmbedder(Number.isFinite(dims) && dims > 0 ? dims : 256);
}
