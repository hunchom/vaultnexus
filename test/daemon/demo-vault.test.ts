import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { VaultIndex } from '../../src/daemon/vault-index.js';
import { indexVault } from '../../src/daemon/indexer.js';
import { FakeEmbedder } from '../../src/core/embedder.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const demoDir = join(repoRoot, 'demo-vault');

describe('demo vault', () => {
  it('indexes the 5 bundled notes', async () => {
    const idx = new VaultIndex(new FakeEmbedder(128));
    const n = await indexVault(demoDir, idx);
    expect(n).toBe(5);
    expect(idx.size).toBeGreaterThanOrEqual(5);
  });
  it('exact-text search finds the source note', async () => {
    const idx = new VaultIndex(new FakeEmbedder(128));
    await indexVault(demoDir, idx);
    const hits = await idx.query('Feedback loops are the heart of every durable system.', 3);
    expect(['systems.md', 'decisions.md']).toContain(hits[0].notePath);
  });
  it('bridges connect notes sharing a repeated line, across different files', async () => {
    const idx = new VaultIndex(new FakeEmbedder(128));
    await indexVault(demoDir, idx);
    const bridges = idx.bridges(20, 0.99);
    expect(bridges.length).toBeGreaterThan(0);
    for (const b of bridges) expect(b.a.notePath).not.toBe(b.b.notePath);
    const pairs = bridges.map((b) => [b.a.notePath, b.b.notePath].sort().join('+'));
    expect(pairs).toContain('decisions.md+systems.md');
  });
});
