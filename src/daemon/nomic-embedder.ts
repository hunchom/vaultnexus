import { request } from 'undici';
import type { Embedder } from '../core/embedder.js';

export interface NomicEmbedderConfig {
  baseURL: string;         // e.g. https://api-atlas.nomic.ai/v1
  apiKey: string;
  model: string;           // e.g. nomic-embed-text-v1.5, nomic-embed-text-v2-moe
  taskType?: 'search_document' | 'search_query' | 'classification' | 'clustering';
}

// Nomic Atlas native /embedding/text endpoint. Shape: { model, texts: [], task_type }
// → { embeddings: [[...]] }. Different from OpenAI's /embeddings { input, data: [{embedding}] }.
export class NomicEmbedder implements Embedder {
  private _dims = 0;
  constructor(private readonly cfg: NomicEmbedderConfig) {}
  get dimensions(): number { return this._dims; }
  get id(): string { return this.cfg.model; }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const taskType = this.cfg.taskType ?? 'search_document';
    const body = JSON.stringify({ model: this.cfg.model, texts, task_type: taskType });
    const url = `${this.cfg.baseURL.replace(/\/+$/, '')}/embedding/text`;
    const res = await request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.cfg.apiKey}`,
      },
      body,
    });
    if (res.statusCode < 200 || res.statusCode >= 300) {
      const text = await res.body.text();
      throw new Error(`nomic embed HTTP ${res.statusCode}: ${text.slice(0, 200)}`);
    }
    const json = (await res.body.json()) as { embeddings?: number[][] };
    if (!Array.isArray(json.embeddings)) throw new Error('nomic response missing embeddings[]');
    if (json.embeddings.length !== texts.length) {
      throw new Error(`nomic response: expected ${texts.length} embeddings, got ${json.embeddings.length}`);
    }
    const out = json.embeddings.map((v) => Float32Array.from(v));
    if (out.length > 0) this._dims = out[0].length;
    return out;
  }

  /** Probe true dimension by embedding one string. */
  async probe(): Promise<number> {
    const [v] = await this.embed(['probe']);
    this._dims = v.length;
    return this._dims;
  }
}
