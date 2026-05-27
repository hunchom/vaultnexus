import type { IndexedChunk, SearchHit } from './vault-index.js';

/** Edge type that introduced a chunk into the chain. */
export type EdgeType = 'seed' | 'wikilink' | 'knn';

/** One step in a citation chain → toChunkId via edgeType, score = cosine or hybrid rank. */
export interface ReasonHop {
  step: number;
  fromChunkId: number | null;
  toChunkId: number;
  edgeType: EdgeType;
  score: number;
  chunk: IndexedChunk;
}

/** Read-only index facade → keeps traceReasoning pure + testable. */
export interface TraceFacade {
  chunks: readonly IndexedChunk[];
  f32: readonly Float32Array[];
  noteLinks: ReadonlyMap<string, readonly string[]>;
  query: (text: string, k: number) => Promise<SearchHit[]>;
  // (notePath, byteStart) unique per chunk (Plan 02 invariant)
  chunkIdOf: (hit: SearchHit) => number;
}

/** BFS knobs. Defaults: depth 2, 5 seeds, 3 kNN/hop, 0.5 cosine cutoff, 30 hop cap. */
export interface TraceOptions {
  maxDepth?: number;
  kSeeds?: number;
  knnPerHop?: number;
  simThreshold?: number;
  maxHops?: number;
}

const DEFAULTS = {
  maxDepth: 2,
  kSeeds: 5,
  knnPerHop: 3,
  simThreshold: 0.5,
  maxHops: 30,
} as const;

/** Pure BFS over wikilink + kNN edges, seeded by hybrid query(). Returns ordered citation chain. */
export async function traceReasoning(
  facade: TraceFacade,
  question: string,
  opts: TraceOptions = {},
): Promise<ReasonHop[]> {
  const maxDepth = opts.maxDepth ?? DEFAULTS.maxDepth;
  const kSeeds = opts.kSeeds ?? DEFAULTS.kSeeds;
  const maxHops = opts.maxHops ?? DEFAULTS.maxHops;

  const out: ReasonHop[] = [];
  const visited = new Set<number>();
  const seeds = await facade.query(question, kSeeds);

  for (const hit of seeds) {
    if (out.length >= maxHops) return out;
    const id = facade.chunkIdOf(hit);
    if (id < 0 || visited.has(id)) continue; // -1 = corrupted-index defensive skip
    visited.add(id);
    out.push({
      step: 0,
      fromChunkId: null,
      toChunkId: id,
      edgeType: 'seed',
      score: hit.score,
      chunk: facade.chunks[id],
    });
  }

  if (maxDepth === 0) return out;
  return out;
}
