import { describe, it, expect } from 'vitest';
import { dot } from 'numkong';

describe('numkong i8 kernel (probe)', () => {
  it('Int8Array dot is the integer dot product', () => {
    const a = Int8Array.from([1, 2, 3, -4]);
    const b = Int8Array.from([5, 6, 7, 8]);
    // 1*5+2*6+3*7+(-4)*8 = 6
    expect(Number(dot(a, b))).toBe(6);
  });

  it('returns number (not bigint)', () => {
    const a = Int8Array.from([1, 0]);
    const b = Int8Array.from([0, 1]);
    expect(typeof dot(a, b)).toBe('number');
  });

  it('all-zeros → 0', () => {
    const a = Int8Array.from([0, 0, 0]);
    const b = Int8Array.from([1, 2, 3]);
    expect(dot(a, b)).toBe(0);
  });
});
