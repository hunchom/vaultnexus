import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { runEval } from '../../src/eval/harness.js';
import { GOLD_QUERIES } from '../../src/eval/gold.js';
import { FakeEmbedder } from '../../src/core/embedder.js';
import { selectEmbedder } from '../../src/daemon/select-embedder.js';

// gated: runs only when a real embedder is configured; default suite skips → stays green offline
const hasReal = !!(process.env.VAULTNEXUS_EMBED_URL && process.env.VAULTNEXUS_EMBED_KEY && process.env.VAULTNEXUS_EMBED_MODEL);
const corpusDir = join(process.cwd(), 'eval/corpus');

describe.skipIf(!hasReal)('real embedder semantic lift', () => {
  it('ranks the relevant note far better than a non-semantic baseline', async () => {
    const real = await selectEmbedder(); // real because env set
    const realR = await runEval(corpusDir, real, GOLD_QUERIES, 10);
    const fakeR = await runEval(corpusDir, new FakeEmbedder(256), GOLD_QUERIES, 10);
    process.stderr.write(
      `real recall@1=${realR.recallAt1.toFixed(3)} MRR=${realR.mrr.toFixed(3)} | fake recall@1=${fakeR.recallAt1.toFixed(3)} MRR=${fakeR.mrr.toFixed(3)}\n`,
    );
    // recall@1 / MRR are rank-sensitive → valid on a small corpus (recall@10 saturates)
    expect(realR.recallAt1).toBeGreaterThanOrEqual(0.8);
    expect(realR.recallAt1).toBeGreaterThan(fakeR.recallAt1 + 0.3);
    expect(realR.mrr).toBeGreaterThan(fakeR.mrr + 0.3);
  }, 60_000); // network — generous timeout
});
