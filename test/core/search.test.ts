import { describe, it, expect } from 'vitest';
import { int8Dot, search, type SearchResult } from '../../src/core/search.js';
import { l2normalize, dotF32 } from '../../src/core/vectors.js';
import { calibrateScale, quantize } from '../../src/core/quantize.js';

function mulberry32(seed: number) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function randUnit(dims: number, rng: () => number): Float32Array {
  const v = new Float32Array(dims);
  for (let i = 0; i < dims; i++) v[i] = rng() * 2 - 1;
  return l2normalize(v);
}
function bruteForceTopK(query: Float32Array, vecs: Float32Array[], k: number): number[] {
  return vecs.map((v, i) => [i, dotF32(query, v)] as [number, number]).sort((a, b) => b[1] - a[1]).slice(0, k).map(([i]) => i);
}

describe('search engine', () => {
  it('int8Dot is the integer dot product', () => {
    expect(int8Dot(Int8Array.from([1, 2, 3, -4]), Int8Array.from([5, 6, 7, 8]))).toBe(6);
  });

  it('int8 + f32 rescore recovers the exact f32 top-k (recall@10 >= 0.95)', () => {
    const rng = mulberry32(42);
    const dims = 256, N = 2000, k = 10;
    const vecs: Float32Array[] = Array.from({ length: N }, () => randUnit(dims, rng));
    const scale = calibrateScale(vecs);
    const flatInt8 = new Int8Array(N * dims); const flatF32 = new Float32Array(N * dims);
    vecs.forEach((v, i) => { flatInt8.set(quantize(v, scale), i * dims); flatF32.set(v, i * dims); });
    let hits = 0; const trials = 50;
    for (let t = 0; t < trials; t++) {
      const q = randUnit(dims, rng);
      const got = search(q, { flatInt8, flatF32, count: N, dims, scale, k, oversample: 8 });
      const truth = new Set(bruteForceTopK(q, vecs, k));
      hits += got.filter((r) => truth.has(r.index)).length;
    }
    expect(hits / (trials * k)).toBeGreaterThanOrEqual(0.95);
  });

  it('rescore scores equal exact f32 cosine for the returned indices and are sorted desc', () => {
    const rng = mulberry32(7);
    const dims = 64, N = 200, k = 5;
    const vecs = Array.from({ length: N }, () => randUnit(dims, rng));
    const scale = calibrateScale(vecs);
    const flatInt8 = new Int8Array(N * dims); const flatF32 = new Float32Array(N * dims);
    vecs.forEach((v, i) => { flatInt8.set(quantize(v, scale), i * dims); flatF32.set(v, i * dims); });
    const q = randUnit(dims, rng);
    const got = search(q, { flatInt8, flatF32, count: N, dims, scale, k, oversample: 8 });
    for (const r of got) expect(r.score).toBeCloseTo(dotF32(q, vecs[r.index]), 5);
    for (let i = 1; i < got.length; i++) expect(got[i - 1].score).toBeGreaterThanOrEqual(got[i].score);
  });
});
