import { describe, it, expect } from 'vitest';
import { VaultIndex } from '../../src/daemon/vault-index.js';
import { FakeEmbedder } from '../../src/core/embedder.js';

describe('VaultIndex', () => {
  it('returns [] before anything is indexed', async () => {
    const idx = new VaultIndex(new FakeEmbedder(64));
    expect(await idx.query('anything')).toEqual([]);
  });
  it('ranks the block whose text equals the query first, with its citation', async () => {
    const idx = new VaultIndex(new FakeEmbedder(64));
    await idx.addNote('notes/a.md', '# Heading\n\nthe quick brown fox\n\nlazy dog sleeps here\n');
    await idx.addNote('notes/b.md', '# Other\n\nunrelated content block\n');
    const hits = await idx.query('the quick brown fox', 3);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].text).toContain('the quick brown fox');
    expect(hits[0].notePath).toBe('notes/a.md');
    expect(hits[0].headingPath).toEqual(['Heading']);
    expect(hits[0].score).toBeCloseTo(1, 5);
    const src = '# Heading\n\nthe quick brown fox\n\nlazy dog sleeps here\n';
    expect(Buffer.from(src).subarray(hits[0].byteStart, hits[0].byteEnd).toString()).toBe(hits[0].text);
  });
  it('respects k', async () => {
    const idx = new VaultIndex(new FakeEmbedder(32));
    await idx.addNote('n.md', 'a block one\n\nb block two\n\nc block three\n\nd block four\n');
    expect((await idx.query('x', 2)).length).toBeLessThanOrEqual(2);
  });
  it('size reflects indexed block count', async () => {
    const idx = new VaultIndex(new FakeEmbedder(16));
    await idx.addNote('n.md', 'one\n\ntwo\n');
    expect(idx.size).toBeGreaterThan(0);
  });
});
