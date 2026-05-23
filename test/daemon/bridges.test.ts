import { describe, it, expect } from 'vitest';
import { VaultIndex } from '../../src/daemon/vault-index.js';
import { FakeEmbedder } from '../../src/core/embedder.js';

describe('VaultIndex.bridges', () => {
  it('returns [] with fewer than 2 chunks', async () => {
    const idx = new VaultIndex(new FakeEmbedder(64));
    await idx.addNote('a.md', '# A\n\nlone block\n');
    expect(idx.bridges()).toEqual([]);
  });
  it('surfaces a high-similarity pair across different notes, not same-note pairs', async () => {
    const idx = new VaultIndex(new FakeEmbedder(64));
    await idx.addNote('a.md', '# A\n\nshared insight about systems\n\nfiller one\n');
    await idx.addNote('b.md', '# B\n\nshared insight about systems\n\nfiller two\n');
    const bridges = idx.bridges(10, 0.5);
    expect(bridges.length).toBeGreaterThan(0);
    const top = bridges[0];
    expect(top.similarity).toBeCloseTo(1, 5);
    expect(top.a.notePath).not.toBe(top.b.notePath);
    expect([top.a.notePath, top.b.notePath].sort()).toEqual(['a.md', 'b.md']);
    expect(top.a.text).toContain('shared insight about systems');
  });
  it('never bridges a note to itself', async () => {
    const idx = new VaultIndex(new FakeEmbedder(32));
    await idx.addNote('a.md', 'p one\n\np two\n\np three\n');
    await idx.addNote('b.md', 'q one\n\nq two\n');
    for (const br of idx.bridges(50, -1)) expect(br.a.notePath).not.toBe(br.b.notePath);
  });
  it('respects the similarity floor and topN (descending)', async () => {
    const idx = new VaultIndex(new FakeEmbedder(32));
    await idx.addNote('a.md', 'alpha block\n\nbeta block\n');
    await idx.addNote('b.md', 'gamma block\n\ndelta block\n');
    const all = idx.bridges(100, -1);
    expect(all.every((b, i, arr) => i === 0 || arr[i - 1].similarity >= b.similarity)).toBe(true);
    expect(idx.bridges(1, -1).length).toBeLessThanOrEqual(1);
  });
});
