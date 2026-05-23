import { describe, it, expect } from 'vitest';
import { VaultIndex } from '../../src/daemon/vault-index.js';
import { FakeEmbedder } from '../../src/core/embedder.js';

describe('hybrid query', () => {
  it('still returns the exact-text match on top', async () => {
    const idx = new VaultIndex(new FakeEmbedder(64));
    await idx.addNote('a.md', '# A\n\nthe quick brown fox\n\nlazy dog sleeps here\n');
    await idx.addNote('b.md', '# B\n\nunrelated content block\n');
    const hits = await idx.query('the quick brown fox', 3);
    expect(hits[0].text).toContain('the quick brown fox');
    expect(hits[0].notePath).toBe('a.md');
  });
  it('surfaces a lexical match the non-semantic embedder would miss', async () => {
    const idx = new VaultIndex(new FakeEmbedder(64));
    await idx.addNote('bio.md', '# Bio\n\nphotosynthesis converts light to chemical energy\n');
    await idx.addNote('misc.md', '# Misc\n\ntotally different words about finance\n\nmore filler text here\n');
    const hits = await idx.query('how does photosynthesis work', 3);
    expect(hits.some((h) => h.text.includes('photosynthesis'))).toBe(true);
    expect(hits[0].notePath).toBe('bio.md');
  });
  it('returns [] before indexing', async () => {
    expect(await new VaultIndex(new FakeEmbedder(16)).query('x')).toEqual([]);
  });
});
