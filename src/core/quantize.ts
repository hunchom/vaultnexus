/** Symmetric single-scale: s = max|x| / 127 over calibration sample. */
export function calibrateScale(sample: Float32Array[]): number {
  let maxAbs = 0;
  for (const v of sample) {
    for (let i = 0; i < v.length; i++) {
      const a = Math.abs(v[i]);
      if (a > maxAbs) maxAbs = a;
    }
  }
  return maxAbs === 0 ? 1 : maxAbs / 127;
}

/** Quantize f32 → int8 with one symmetric scale; clamps to [-127,127]. */
export function quantize(v: Float32Array, scale: number): Int8Array {
  const out = new Int8Array(v.length);
  for (let i = 0; i < v.length; i++) {
    const q = Math.round(v[i] / scale);
    out[i] = q > 127 ? 127 : q < -127 ? -127 : q;
  }
  return out;
}
