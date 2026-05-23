import { dot as numkongDot } from 'numkong';
import { dotF32 } from './vectors.js';

export interface SearchResult { index: number; score: number; }
export interface SearchParams {
  flatInt8: Int8Array; flatF32: Float32Array; count: number; dims: number; scale: number; k: number; oversample?: number;
}

/** Integer dot of two int8 vectors via numkong's i8 kernel. */
export function int8Dot(a: Int8Array, b: Int8Array): number {
  return Number(numkongDot(a, b));
}

/** Coarse int8 top-(want) candidate indices by int8 dot, descending. */
export function int8TopK(query: Int8Array, flatInt8: Int8Array, count: number, dims: number, want: number): number[] {
  const scored: Array<[number, number]> = new Array(count);
  for (let i = 0; i < count; i++) scored[i] = [i, int8Dot(query, flatInt8.subarray(i * dims, (i + 1) * dims))];
  scored.sort((a, b) => b[1] - a[1]);
  return scored.slice(0, want).map(([i]) => i);
}

/** Exact f32 cosine rescore of candidates → top-k descending. */
export function rescoreF32(candidates: number[], query: Float32Array, flatF32: Float32Array, dims: number, k: number): SearchResult[] {
  const res = candidates.map((index) => ({ index, score: dotF32(query, flatF32.subarray(index * dims, (index + 1) * dims)) }));
  res.sort((a, b) => b.score - a.score);
  return res.slice(0, k);
}

/** Two-stage exact top-k: int8 coarse rank → f32 exact rescore. Query must be unit-norm f32. */
export function search(queryF32: Float32Array, p: SearchParams): SearchResult[] {
  const oversample = p.oversample ?? 8;
  const want = Math.min(p.count, p.k * oversample);
  const qInt8 = new Int8Array(p.dims);
  for (let i = 0; i < p.dims; i++) {
    const q = Math.round(queryF32[i] / p.scale);
    qInt8[i] = q > 127 ? 127 : q < -127 ? -127 : q;
  }
  return rescoreF32(int8TopK(qInt8, p.flatInt8, p.count, p.dims, want), queryF32, p.flatF32, p.dims, p.k);
}

/** Recall@k of a result set vs a ground-truth index set. */
export function recallAtK(got: SearchResult[], truth: Set<number>): number {
  if (truth.size === 0) return 1;
  return got.filter((r) => truth.has(r.index)).length / Math.min(got.length, truth.size);
}
