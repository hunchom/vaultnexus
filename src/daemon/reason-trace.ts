import type { IndexedChunk, SearchHit } from './vault-index.js';
import { dotF32 } from '../core/vectors.js';
import { resolveLink } from './note-graph.js';

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
    // hi-bound unreachable: chunkIdOf = findIndex over same chunks[]
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

  const knnPerHop = opts.knnPerHop ?? DEFAULTS.knnPerHop;
  const simThreshold = opts.simThreshold ?? DEFAULTS.simThreshold;

  // BFS: frontier carries the chunks just added at depth (level-1)
  const paths = [...facade.noteLinks.keys()];
  let frontier: number[] = out.map((h) => h.toChunkId);
  let level = 1;

  while (level <= maxDepth && frontier.length > 0 && out.length < maxHops) {
    const nextFrontier: number[] = [];

    // pass 1: wikilink-pass across WHOLE frontier first → wikilink wins ties vs kNN
    for (const fromId of frontier) {
      if (out.length >= maxHops) break;
      const fromChunk = facade.chunks[fromId];
      const links = facade.noteLinks.get(fromChunk.notePath) ?? [];
      for (const link of links) {
        if (out.length >= maxHops) break;
        const resolved = resolveLink(link, paths);
        if (!resolved || resolved === fromChunk.notePath) continue;
        for (let toId = 0; toId < facade.chunks.length; toId++) {
          if (out.length >= maxHops) break;
          if (facade.chunks[toId].notePath !== resolved) continue;
          if (visited.has(toId)) continue;
          visited.add(toId);
          const score = dotF32(facade.f32[fromId], facade.f32[toId]);
          out.push({
            step: level,
            fromChunkId: fromId,
            toChunkId: toId,
            edgeType: 'wikilink',
            score,
            chunk: facade.chunks[toId],
          });
          nextFrontier.push(toId);
        }
      }
    }

    // pass 2: kNN-pass over same frontier → wikilink-visited chunks now skipped pre-cosine
    // O(N·D) per frontier·level → fine at N=21, revisit at 10⁵ (use flatInt8 SIMD path)
    for (const fromId of frontier) {
      if (out.length >= maxHops) break;
      const fromChunk = facade.chunks[fromId];
      const candidates: Array<{ id: number; s: number }> = [];
      const vFrom = facade.f32[fromId];
      for (let id = 0; id < facade.chunks.length; id++) {
        if (id === fromId) continue;
        if (facade.chunks[id].notePath === fromChunk.notePath) continue; // cross-note only
        if (visited.has(id)) continue; // skip pre-cosine → saves dotF32 + sort slot
        const s = dotF32(vFrom, facade.f32[id]);
        if (s >= simThreshold) candidates.push({ id, s });
      }
      candidates.sort((a, b) => b.s - a.s);
      for (const { id, s } of candidates.slice(0, knnPerHop)) {
        if (out.length >= maxHops) break;
        if (visited.has(id)) continue; // re-check → earlier kNN in same pass may have claimed
        visited.add(id);
        out.push({
          step: level,
          fromChunkId: fromId,
          toChunkId: id,
          edgeType: 'knn',
          score: s,
          chunk: facade.chunks[id],
        });
        nextFrontier.push(id);
      }
    }

    frontier = nextFrontier;
    level++;
  }

  return out;
}
