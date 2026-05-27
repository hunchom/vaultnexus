import { request } from 'undici';
import type { Embedder } from '../core/embedder.js';
import { buildEmbedBody, parseEmbedResponse } from '../core/embed-protocol.js';

export interface OpenAIEmbedderConfig { baseURL: string; apiKey: string; model: string; }

/** OpenAI-compatible embedder over undici. dimensions=0 until probe() or first embed(). */
export class OpenAIEmbedder implements Embedder {
  private _dims = 0;
  constructor(private readonly cfg: OpenAIEmbedderConfig) {}
  get dimensions(): number { return this._dims; }
  get id(): string { return this.cfg.model; }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const res = await request(`${this.cfg.baseURL}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.cfg.apiKey}` },
      body: JSON.stringify(buildEmbedBody(this.cfg.model, texts)),
    });
    if (res.statusCode < 200 || res.statusCode >= 300) {
      const text = await res.body.text();
      throw new Error(`embed HTTP ${res.statusCode}: ${text.slice(0, 200)}`);
    }
    const json = await res.body.json();
    const out = parseEmbedResponse(json, texts.length);
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
