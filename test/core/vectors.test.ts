import { describe, it, expect } from 'vitest';
import { l2normalize, dotF32 } from '../../src/core/vectors.js';

describe('vectors', () => {
  it('l2normalize yields unit length', () => {
    const v = l2normalize(Float32Array.from([3, 4]));
    expect(Math.hypot(v[0], v[1])).toBeCloseTo(1, 6);
    expect(v[0]).toBeCloseTo(0.6, 6);
  });

  it('dotF32 of two unit vectors is their cosine', () => {
    const a = l2normalize(Float32Array.from([1, 0]));
    const b = l2normalize(Float32Array.from([1, 1]));
    expect(dotF32(a, b)).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('l2normalize of a zero vector returns zeros (no NaN)', () => {
    const v = l2normalize(Float32Array.from([0, 0]));
    expect(v[0]).toBe(0);
    expect(v[1]).toBe(0);
  });
});
