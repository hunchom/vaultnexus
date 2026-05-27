/** Plan 22 — eval harness over the Plan 14 seeded demo vault (30 notes, 3 wikilink-coherent
 *  communities). Variant of harness.ts that:
 *    1. seeds the Plan 14 vault into a temp dir → recursively loads notes/**\/*.md
 *    2. indexes every chunk via VaultIndex
 *    3. runs SEEDED_GOLD_QUERIES → recall@1/3/10, nDCG@10, MRR
 *    4. supports an FTS-only mode for leakage measurement (vector list weighted to 0
 *       in RRF fusion → fused rank is FTS-driven). Cleaner than embedder swapping.
 *
 *  Multi-target semantics: any-of. A query "hits at K" when any of its targets appears
 *  in the top-K ranked notes.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { VaultIndex } from '../daemon/vault-index.js';
import type { Embedder } from '../core/embedder.js';
import { l2normalize } from '../core/vectors.js';
import { ndcgAtK } from './metrics.js';
import type { GoldQuery } from './seeded-gold.js';

export interface SeededPerQuery {
  query: string;
  targets: string[];
  rankedNotes: string[];
  recall1: number;
  recall3: number;
  recall10: number;
  ndcg10: number;
  rr: number;
}

export interface SeededEvalResult {
  queries: number;
  recallAt1: number;
  recallAt3: number;
  recallAt10: number;
  ndcgAt10: number;
  mrr: number;
  perQuery: SeededPerQuery[];
}

/** Recursively walk `root` → POSIX-relative .md paths. */
function walkMarkdown(root: string, sub = ''): string[] {
  const dir = sub ? join(root, sub) : root;
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const rel = sub ? `${sub}/${entry}` : entry;
    const abs = join(root, rel);
    if (statSync(abs).isDirectory()) out.push(...walkMarkdown(root, rel));
    else if (entry.endsWith('.md')) out.push(rel);
  }
  return out;
}

/** Normalize POSIX-style note path → portable across the index + targets. */
function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}

/** Load every .md in vaultRoot/notes/** → { path: "notes/sub/file.md", source }. */
export function loadSeededCorpus(vaultRoot: string): Array<{ path: string; source: string }> {
  const notesDir = join(vaultRoot, 'notes');
  return walkMarkdown(notesDir).map((rel) => ({
    path: `notes/${toPosix(rel)}`,
    source: readFileSync(join(notesDir, rel), 'utf8'),
  }));
}

/** Dedupe note paths preserving first-seen order; drop non-positive-cosine hits.
 *  Matches harness.ts contract. */
function rankedNotes(hits: { notePath: string; score: number }[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const h of hits) {
    if (h.score <= 0) continue;
    if (!seen.has(h.notePath)) {
      seen.add(h.notePath);
      out.push(h.notePath);
    }
  }
  return out;
}

/** Constant-vector embedder → every chunk + query maps to the same unit vector.
 *  Retained as a self-contained sanity check that l2normalize + dotF32 behave on
 *  collapsed inputs. Not used by the FTS-only path anymore (that now threads
 *  ftsOnly through QueryOptions → fuseRRF weights [0,1]). */
export class ConstantEmbedder implements Embedder {
  readonly dimensions: number;
  private readonly v: Float32Array;

  constructor(dimensions = 64) {
    this.dimensions = dimensions;
    const raw = new Float32Array(dimensions);
    for (let i = 0; i < dimensions; i++) raw[i] = 1;
    this.v = l2normalize(raw);
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map(() => this.v);
  }
}

export interface RunOptions {
  /** When true → vector list weighted to 0 in RRF fusion; FTS5 alone ranks. */
  ftsOnly?: boolean;
  /** Vector + FTS fetch breadth + recall@k cut. Default 10. */
  k?: number;
  /** Plan 25: route query intent → dynamic fusion weights. */
  router?: boolean;
  /** Plan 25: DPP rerank λ-mix, 0..1. */
  diversity?: number;
}

/** Multi-target hit: any target appears in top-k → counts as recall=1 for that query.
 *  Single-target semantics fall out as the size-1 case. */
function anyOfRecallAtK(ranked: string[], targets: Set<string>, k: number): number {
  if (targets.size === 0) return 0;
  for (const id of ranked.slice(0, k)) if (targets.has(id)) return 1;
  return 0;
}

/** Multi-target reciprocal rank: 1/rank of FIRST hit among any target, 0 if none. */
function anyOfReciprocalRank(ranked: string[], targets: Set<string>): number {
  for (let i = 0; i < ranked.length; i++) if (targets.has(ranked[i])) return 1 / (i + 1);
  return 0;
}

/** Multi-target nDCG@k: treat every target as relevant, binary gain. */
function anyOfNdcgAtK(ranked: string[], targets: Set<string>, k: number): number {
  return ndcgAtK(ranked, targets, k);
}

/** Build index from seeded vault corpus → run queries → aggregate IR metrics. */
export async function runSeededEval(
  vaultRoot: string,
  embedder: Embedder,
  queries: GoldQuery[],
  opts: RunOptions = {},
): Promise<SeededEvalResult> {
  const k = opts.k ?? 10;
  const idx = new VaultIndex(embedder);
  for (const { path, source } of loadSeededCorpus(vaultRoot)) await idx.addNote(path, source);

  const perQuery: SeededPerQuery[] = [];
  for (const q of queries) {
    // Plan 25: optional router/diversity/ftsOnly flow through to VaultIndex.query.
    const hits = await idx.query(q.query, k * 4, {
      router: opts.router,
      diversity: opts.diversity,
      ftsOnly: opts.ftsOnly,
    });
    const ranked = rankedNotes(hits);
    const tgt = new Set(q.targets);
    perQuery.push({
      query: q.query,
      targets: q.targets,
      rankedNotes: ranked,
      recall1: anyOfRecallAtK(ranked, tgt, 1),
      recall3: anyOfRecallAtK(ranked, tgt, 3),
      recall10: anyOfRecallAtK(ranked, tgt, 10),
      ndcg10: anyOfNdcgAtK(ranked, tgt, 10),
      rr: anyOfReciprocalRank(ranked, tgt),
    });
  }
  const mean = (f: (p: SeededPerQuery) => number) =>
    perQuery.reduce((s, p) => s + f(p), 0) / (perQuery.length || 1);
  return {
    queries: perQuery.length,
    recallAt1: mean((p) => p.recall1),
    recallAt3: mean((p) => p.recall3),
    recallAt10: mean((p) => p.recall10),
    ndcgAt10: mean((p) => p.ndcg10),
    mrr: mean((p) => p.rr),
    perQuery,
  };
}
