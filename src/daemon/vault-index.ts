import type { Embedder } from '../core/embedder.js';
import { chunkDocument } from '../core/chunk.js';
import { l2normalize } from '../core/vectors.js';
import { calibrateScale, quantize } from '../core/quantize.js';
import { search } from '../core/search.js';

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

/** In-memory semantic index over note block-chunks. Cosine via unit-norm vectors. */
export class VaultIndex {
  private chunks: IndexedChunk[] = [];
  private f32: Float32Array[] = [];
  private dims = 0;
  private flatInt8: Int8Array | null = null;
  private flatF32: Float32Array | null = null;
  private scale = 1;

  constructor(private readonly embedder: Embedder) {}

  get size(): number {
    return this.chunks.length;
  }

  /** Chunk a note, embed its blocks, store unit-norm for search. */
  async addNote(notePath: string, source: string): Promise<void> {
    // tokenBudget:0 → one block per paragraph (paragraph = retrieval unit)
    const blocks = chunkDocument(source, { tokenBudget: 0 }).filter((c) => c.granularity === 'block');
    if (blocks.length === 0) return;
    const vecs = await this.embedder.embed(blocks.map((b) => b.text));
    blocks.forEach((b, i) => {
      this.chunks.push({
        notePath,
        headingPath: b.headingPath,
        text: b.text,
        byteStart: b.byteStart,
        byteEnd: b.byteEnd,
      });
      this.f32.push(l2normalize(vecs[i]));
    });
    this.dims = this.f32[0].length;
    this.flatInt8 = null; // new data → rebuild flat store on next query
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

  /** Embed query, search, return cited hits. */
  async query(text: string, k = 10): Promise<SearchHit[]> {
    if (this.chunks.length === 0) return [];
    if (!this.flatInt8) this.build();
    const [q] = await this.embedder.embed([text]);
    const res = search(l2normalize(q), {
      flatInt8: this.flatInt8!,
      flatF32: this.flatF32!,
      count: this.chunks.length,
      dims: this.dims,
      scale: this.scale,
      k,
    });
    return res.map((r) => ({ ...this.chunks[r.index], score: r.score }));
  }
}
