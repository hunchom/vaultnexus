import { describe, it, expect } from 'vitest';
import { calibrateScale, quantize } from '../../src/core/quantize.js';
import { l2normalize } from '../../src/core/vectors.js';

describe('quantize (symmetric single-scale)', () => {
  it('scale is max|x|/127 over the sample', () => {
    const sample = [Float32Array.from([0.5, -1.0, 0.25]), Float32Array.from([0.1, 0.2, 0.8])];
    expect(calibrateScale(sample)).toBeCloseTo(1.0 / 127, 9);
  });

  it('quantizes into int8 range and round-trips approximately', () => {
    const v = l2normalize(Float32Array.from([0.2, -0.5, 0.3, 0.8]));
    const scale = calibrateScale([v]);
    const q = quantize(v, scale);
    expect(q).toBeInstanceOf(Int8Array);
    for (const x of q) {
      expect(x).toBeGreaterThanOrEqual(-127);
      expect(x).toBeLessThanOrEqual(127);
    }
    for (let i = 0; i < v.length; i++) {
      expect(q[i] * scale).toBeCloseTo(v[i], 2);
    }
  });

  it('clamps out-of-range values to [-127,127]', () => {
    const q = quantize(Float32Array.from([10, -10]), 1 / 127);
    expect(q[0]).toBe(127);
    expect(q[1]).toBe(-127);
  });
});
