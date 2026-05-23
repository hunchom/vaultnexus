import type { Embedder } from '../core/embedder.js';
import { chunkDocument } from '../core/chunk.js';
import { l2normalize, dotF32 } from '../core/vectors.js';
import { calibrateScale, quantize } from '../core/quantize.js';
import { search } from '../core/search.js';
import { FtsIndex } from './fts.js';
import { fuseRRF } from '../core/fusion.js';
import { extractWikilinks } from '../core/wikilinks.js';
import { buildNoteGraph, detectCommunities, resolveLink } from './note-graph.js';

export interface IndexedChunk {
  notePath: string;
  headingPath: string[];
  text: string;
  byteStart: number;
  byteEnd: number;
}

export interface SearchHit extends IndexedChunk {
  score: number;
}

export interface Bridge { a: IndexedChunk; b: IndexedChunk; similarity: number; crossCommunity: boolean; linked: boolean; }

/** In-memory semantic index over note block-chunks. Cosine via unit-norm vectors. */
export class VaultIndex {
  private chunks: IndexedChunk[] = [];
  private f32: Float32Array[] = [];
  private dims = 0;
  private flatInt8: Int8Array | null = null;
  private flatF32: Float32Array | null = null;
  private scale = 1;
  private readonly fts = new FtsIndex();
  private readonly noteLinks = new Map<string, string[]>(); // notePath → bare wikilink targets

  constructor(private readonly embedder: Embedder) {}

  get size(): number {
    return this.chunks.length;
  }

  /** Chunk a note, embed its blocks, store unit-norm for search. */
  async addNote(notePath: string, source: string): Promise<void> {
    // tokenBudget:0 → one block per paragraph (paragraph = retrieval unit)
    const blocks = chunkDocument(source, { tokenBudget: 0 }).filter((c) => c.granularity === 'block');
    if (blocks.length === 0) return;
    this.noteLinks.set(notePath, extractWikilinks(source));
    const vecs = await this.embedder.embed(blocks.map((b) => b.text));
    blocks.forEach((b, i) => {
      const id = this.chunks.length;
      this.chunks.push({ notePath, headingPath: b.headingPath, text: b.text, byteStart: b.byteStart, byteEnd: b.byteEnd });
      this.f32.push(l2normalize(vecs[i]));
      this.fts.add(id, b.text);
    });
    this.dims = this.f32[0].length;
    this.flatInt8 = null; // new data → rebuild flat store on next query
  }

  /** Indexed notes with their bare wikilink targets (for graph build). */
  private noteList(): Array<{ path: string; links: string[] }> {
    return [...this.noteLinks.entries()].map(([path, links]) => ({ path, links }));
  }

  private build(): void {
    const n = this.f32.length, d = this.dims;
    this.scale = calibrateScale(this.f32);
    const i8 = new Int8Array(n * d);
    const f = new Float32Array(n * d);
    this.f32.forEach((v, i) => {
      i8.set(quantize(v, this.scale), i * d);
      f.set(v, i * d);
    });
    this.flatInt8 = i8;
    this.flatF32 = f;
  }

  /** Cross-note high-similarity chunk pairs ("notes that secretly agree"), top-N descending. FP-safe. */
  bridges(topN = 20, minSimilarity = 0.5, crossCommunityOnly = false): Bridge[] {
    const n = this.chunks.length;
    if (n < 2) return [];
    if (!this.flatInt8) this.build();
    const f = this.flatF32!;
    const d = this.dims;
    const notes = this.noteList();
    const comm = detectCommunities(buildNoteGraph(notes));
    const paths = notes.map((nt) => nt.path);
    const key = (p: string, q: string) => (p < q ? `${p} ${q}` : `${q} ${p}`);
    const linkedPairs = new Set<string>();
    for (const nt of notes) for (const l of nt.links) {
      const t = resolveLink(l, paths);
      if (t && t !== nt.path) linkedPairs.add(key(nt.path, t));
    }
    const out: Bridge[] = [];
    for (let i = 0; i < n; i++) {
      const vi = f.subarray(i * d, (i + 1) * d);
      for (let j = i + 1; j < n; j++) {
        if (this.chunks[i].notePath === this.chunks[j].notePath) continue;
        const s = dotF32(vi, f.subarray(j * d, (j + 1) * d));
        if (s >= minSimilarity) {
          const aP = this.chunks[i].notePath, bP = this.chunks[j].notePath;
          const crossCommunity = comm.get(aP) !== comm.get(bP);
          if (crossCommunityOnly && !crossCommunity) continue;
          out.push({ a: this.chunks[i], b: this.chunks[j], similarity: s, crossCommunity, linked: linkedPairs.has(key(aP, bP)) });
        }
      }
    }
    out.sort((x, y) => y.similarity - x.similarity);
    return out.slice(0, topN);
  }

  /** Embed query, search, return cited hits. vector ⊕ FTS → RRF fusion. */
  async query(text: string, k = 10): Promise<SearchHit[]> {
    if (this.chunks.length === 0) return [];
    if (!this.flatInt8) this.build();
    const [qe] = await this.embedder.embed([text]);
    const q = l2normalize(qe);
    const want = Math.floor(k) * 8; // FTS LIMIT needs int; vec list parity
    const vec = search(q, {
      flatInt8: this.flatInt8!, flatF32: this.flatF32!,
      count: this.chunks.length, dims: this.dims, scale: this.scale, k: want,
    });
    const lex = this.fts.search(text, want);
    const fused = fuseRRF([vec.map((r) => r.index), lex.map((r) => r.id)]).slice(0, k);
    const cos = new Map(vec.map((r) => [r.index, r.score]));
    // FTS-only hit (outside vector top-want) → compute its true cosine, never surface 0
    return fused.map((index) => ({ ...this.chunks[index], score: cos.get(index) ?? dotF32(q, this.f32[index]) }));
  }

  /** Release native FTS db handle. */
  close(): void {
    this.fts.close();
  }
}
