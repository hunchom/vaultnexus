import { describe, it, expect } from 'vitest';
import type { Chunk, Granularity } from '../../src/core/types.js';

describe('types', () => {
  it('Chunk shape is constructable', () => {
    const g: Granularity = 'block';
    const c: Chunk = { granularity: g, text: 'hello', byteStart: 0, byteEnd: 5, headingPath: ['Intro'] };
    expect(c.granularity).toBe('block');
    expect(c.byteEnd - c.byteStart).toBe(5);
  });
});
