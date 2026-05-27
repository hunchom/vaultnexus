import { describe, it, expect } from 'vitest';
import { chunkDocument } from '../../src/core/chunk.js';

// Regression: doc starting at depth > 1 must NOT leave `undefined` in headingPath.
// Plain JSON serialization turns undefined → null which crashes downstream consumers.
describe('chunkDocument — skip-level headings', () => {
  it('fills missing ancestor slots with empty strings (no undefined / null leaks)', () => {
    const src = '#### deep heading\n\nbody text under deep heading\n';
    const chunks = chunkDocument(src, { tokenBudget: 0 });
    const blocks = chunks.filter((c) => c.granularity === 'block');
    expect(blocks.length).toBeGreaterThan(0);
    for (const b of blocks) {
      for (const p of b.headingPath) {
        expect(typeof p).toBe('string');
        expect(p).not.toBeUndefined();
      }
    }
  });

  it('JSON round-trip preserves headingPath shape (no nulls)', () => {
    const src = '##### lone five\n\npayload\n';
    const chunks = chunkDocument(src, { tokenBudget: 0 });
    const round = JSON.parse(JSON.stringify(chunks)) as typeof chunks;
    for (const c of round) {
      for (const p of c.headingPath) {
        expect(p).not.toBeNull();
        expect(typeof p).toBe('string');
      }
    }
  });
});
