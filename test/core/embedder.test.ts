import { describe, it, expect } from 'vitest';
import { FakeEmbedder, type Embedder } from '../../src/core/embedder.js';

describe('FakeEmbedder', () => {
  it('is an Embedder with a fixed dimension', async () => {
    const e: Embedder = new FakeEmbedder(64);
    expect(e.dimensions).toBe(64);
    const [v] = await e.embed(['hello']);
    expect(v).toBeInstanceOf(Float32Array);
    expect(v.length).toBe(64);
  });

  it('is deterministic: same text → identical vector', async () => {
    const e = new FakeEmbedder(32);
    const [a] = await e.embed(['same']);
    const [b] = await e.embed(['same']);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('different text → different vector', async () => {
    const e = new FakeEmbedder(32);
    const [a] = await e.embed(['alpha']);
    const [b] = await e.embed(['beta']);
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it('returns unit-norm vectors (ready for cosine)', async () => {
    const e = new FakeEmbedder(48);
    const [v] = await e.embed(['norm me']);
    let s = 0;
    for (const x of v) s += x * x;
    expect(Math.sqrt(s)).toBeCloseTo(1, 5);
  });

  it('embeds a batch in order', async () => {
    const e = new FakeEmbedder(16);
    const vs = await e.embed(['a', 'b', 'c']);
    expect(vs.length).toBe(3);
    const [a2] = await e.embed(['a']);
    expect(Array.from(vs[0])).toEqual(Array.from(a2));
  });
});
