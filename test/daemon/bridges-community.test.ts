import { describe, it, expect } from 'vitest';
import { VaultIndex } from '../../src/daemon/vault-index.js';
import { FakeEmbedder } from '../../src/core/embedder.js';

// cluster1: a<->b linked. cluster2: x<->y linked. a & x share an identical line but are unlinked + different clusters.
async function seeded(): Promise<VaultIndex> {
  const idx = new VaultIndex(new FakeEmbedder(64));
  await idx.addNote('a.md', '# A\n\n[[b]]\n\nidentical bridging line\n');
  await idx.addNote('b.md', '# B\n\n[[a]]\n\nb unique filler\n');
  await idx.addNote('x.md', '# X\n\n[[y]]\n\nidentical bridging line\n');
  await idx.addNote('y.md', '# Y\n\n[[x]]\n\ny unique filler\n');
  return idx;
}

describe('community-aware bridges', () => {
  it('flags the a↔x twin as crossCommunity and not linked', async () => {
    const idx = await seeded();
    const top = idx.bridges(20, 0.9).find((br) => br.similarity > 0.9)!;
    expect([top.a.notePath, top.b.notePath].sort()).toEqual(['a.md', 'x.md']);
    expect(top.crossCommunity).toBe(true);
    expect(top.linked).toBe(false);
  });
  it('crossCommunityOnly filter keeps only crossCommunity pairs', async () => {
    const idx = await seeded();
    const all = idx.bridges(50, -1);
    const cross = idx.bridges(50, -1, true);
    expect(cross.every((b) => b.crossCommunity)).toBe(true);
    expect(cross.length).toBeLessThanOrEqual(all.length);
  });
});
