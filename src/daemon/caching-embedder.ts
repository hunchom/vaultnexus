import { createHash } from 'node:crypto';
import type { Embedder } from '../core/embedder.js';
import type { EmbeddingCache } from './embedding-cache.js';

/** Decorates an Embedder with a persistent cache. Key = sha256(namespace \0 text); namespace = model id. */
export class CachingEmbedder implements Embedder {
  constructor(private readonly base: Embedder, private readonly cache: EmbeddingCache, private readonly namespace: string) {}

  get dimensions(): number { return this.base.dimensions; }
  get id(): string { return this.base.id ?? 'unknown'; }

  private key(text: string): string {
    const ns = createHash('sha256').update(this.namespace).digest('hex'); // fixed 64-char prefix → boundary unambiguous even with NUL in ns/text
    return createHash('sha256').update(ns).update(text).digest('hex');
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const keys = texts.map((t) => this.key(t));
    const out = this.cache.getMany(keys);
    const missIdx: number[] = [];
    out.forEach((v, i) => { if (!v) missIdx.push(i); });
    if (missIdx.length) {
      const fresh = await this.base.embed(missIdx.map((i) => texts[i]));
      const writes = fresh.map((vec, k) => { out[missIdx[k]] = vec; return { key: keys[missIdx[k]], vec }; });
      this.cache.setMany(writes);
    }
    return out as Float32Array[];
  }

  close(): void { this.cache.close(); }
}
