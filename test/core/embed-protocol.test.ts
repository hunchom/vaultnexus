import { describe, it, expect } from 'vitest';
import { buildEmbedBody, parseEmbedResponse } from '../../src/core/embed-protocol.js';

describe('embed protocol (OpenAI-compatible)', () => {
  it('builds the request body', () => {
    expect(buildEmbedBody('text-embedding-3-small', ['a', 'b'])).toEqual({
      model: 'text-embedding-3-small', input: ['a', 'b'],
    });
  });
  it('parses embeddings in API index order regardless of array order', () => {
    const resp = { data: [{ index: 1, embedding: [0.1, 0.2] }, { index: 0, embedding: [0.3, 0.4] }] };
    const out = parseEmbedResponse(resp, 2);
    expect(out.length).toBe(2);
    expect(Array.from(out[0])).toEqual([0.3, 0.4].map((x) => Math.fround(x)));
    expect(Array.from(out[1])).toEqual([0.1, 0.2].map((x) => Math.fround(x)));
    expect(out[0]).toBeInstanceOf(Float32Array);
  });
  it('throws on a count mismatch', () => {
    expect(() => parseEmbedResponse({ data: [{ index: 0, embedding: [1] }] }, 2)).toThrow();
  });
  it('throws on a malformed response', () => {
    expect(() => parseEmbedResponse({}, 1)).toThrow();
  });
});
