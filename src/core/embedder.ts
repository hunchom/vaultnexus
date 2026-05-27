import { l2normalize } from './vectors.js';

/** Model-agnostic embedding provider. Returns one unit-norm Float32Array per input. */
export interface Embedder {
  readonly dimensions: number;
  /** Stable id for the /status surface. e.g. 'fake', 'voyage-3-large', 'text-embedding-3-small'. */
  readonly id?: string;
  embed(texts: string[]): Promise<Float32Array[]>;
}

// FNV-1a 32-bit hash
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic offline embedder: hash(text,dim) → unit vector. For tests + offline pipeline. */
export class FakeEmbedder implements Embedder {
  readonly id = 'fake';
  constructor(public readonly dimensions: number = 64) {}

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => this.one(t));
  }

  private one(text: string): Float32Array {
    const v = new Float32Array(this.dimensions);
    for (let d = 0; d < this.dimensions; d++) {
      v[d] = (fnv1a(`${text}:${d}`) / 0xffffffff) * 2 - 1;
    }
    return l2normalize(v);
  }
}
