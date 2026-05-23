import { VaultIndex } from '../daemon/vault-index.js';
import type { Embedder } from '../core/embedder.js';
import { loadCorpus, type GoldQuery } from './gold.js';
import { recallAtK, ndcgAtK, reciprocalRank } from './metrics.js';

export interface PerQuery {
  query: string;
  relevant: string[];
  rankedNotes: string[];
  recall: number; // recall@k (k = eval cut)
  recall1: number; // relevant note ranked #1
  ndcg: number;
  rr: number;
}
export interface EvalResult {
  queries: number;
  recallAt1: number; // headline — rank-sensitive, valid on any corpus size
  recallAt3: number;
  recallAt10: number; // saturates on tiny corpora → secondary
  ndcgAt10: number;
  mrr: number;
  perQuery: PerQuery[];
}

/** Dedupe note paths preserving first-seen order; drop non-positive-cosine hits (relevance floor). */
function rankedNotes(hits: { notePath: string; score: number }[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const h of hits) {
    if (h.score <= 0) continue;
    if (!seen.has(h.notePath)) { seen.add(h.notePath); out.push(h.notePath); }
  }
  return out;
}

/** Build index from corpus, run each query, aggregate IR metrics. k = fetch breadth + recall@k/nDCG cut. */
export async function runEval(corpusDir: string, embedder: Embedder, queries: GoldQuery[], k = 10): Promise<EvalResult> {
  const idx = new VaultIndex(embedder);
  for (const { path, source } of loadCorpus(corpusDir)) await idx.addNote(path, source);

  const perQuery: PerQuery[] = [];
  for (const q of queries) {
    const hits = await idx.query(q.query, k * 4); // over-fetch chunks → dedupe to notes
    const ranked = rankedNotes(hits);
    const rel = new Set(q.relevant);
    perQuery.push({
      query: q.query, relevant: q.relevant, rankedNotes: ranked,
      recall: recallAtK(ranked, rel, k), recall1: recallAtK(ranked, rel, 1),
      ndcg: ndcgAtK(ranked, rel, k), rr: reciprocalRank(ranked, rel),
    });
  }
  const mean = (f: (p: PerQuery) => number) => perQuery.reduce((s, p) => s + f(p), 0) / (perQuery.length || 1);
  return {
    queries: perQuery.length,
    recallAt1: mean((p) => p.recall1),
    recallAt3: mean((p) => recallAtK(p.rankedNotes, new Set(p.relevant), 3)),
    recallAt10: mean((p) => p.recall),
    ndcgAt10: mean((p) => p.ndcg),
    mrr: mean((p) => p.rr),
    perQuery,
  };
}
