#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { selectEmbedder } from '../daemon/select-embedder.js';
import { runEval } from './harness.js';
import { GOLD_QUERIES } from './gold.js';

const THRESHOLD = Number(process.env.VAULTNEXUS_EVAL_MIN_RECALL ?? 0); // gate recall@1 when >0

async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const corpusDir = join(here, '../../eval/corpus'); // repo-root/eval/corpus
  const embedder = await selectEmbedder();
  const isFake = embedder.constructor.name === 'FakeEmbedder';
  process.stderr.write(`eval: embedder=${embedder.constructor.name} dims=${embedder.dimensions}\n`);

  const r = await runEval(corpusDir, embedder, GOLD_QUERIES, 10);
  process.stdout.write(
    `\nqueries=${r.queries}  recall@1=${r.recallAt1.toFixed(3)}  recall@3=${r.recallAt3.toFixed(3)}` +
      `  recall@10=${r.recallAt10.toFixed(3)}  nDCG@10=${r.ndcgAt10.toFixed(3)}  MRR=${r.mrr.toFixed(3)}\n\n`,
  );
  for (const p of r.perQuery) {
    const tag = p.recall1 > 0 ? 'TOP1 ' : p.recall > 0 ? 'top-k' : 'MISS ';
    process.stdout.write(`  ${tag} rr=${p.rr.toFixed(2)}  ${p.query}\n         → ${p.rankedNotes.slice(0, 3).join(', ') || '(none)'}\n`);
  }
  if (isFake) {
    process.stderr.write('\neval: FakeEmbedder is non-semantic — paraphrase recall expected low. Set VAULTNEXUS_EMBED_* for a real run.\n');
  }
  if (THRESHOLD > 0 && r.recallAt1 < THRESHOLD) {
    process.stderr.write(`\neval: recall@1 ${r.recallAt1.toFixed(3)} < threshold ${THRESHOLD}\n`);
    process.exit(1);
  }
}
main().catch((e) => {
  process.stderr.write(`eval: fatal ${String(e)}\n`);
  process.exit(1);
});
