import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { walkMarkdown, indexVault } from '../../src/daemon/indexer.js';
import { VaultIndex } from '../../src/daemon/vault-index.js';
import { FakeEmbedder } from '../../src/core/embedder.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vn-vault-'));
  await writeFile(join(dir, 'a.md'), '# A\n\nalpha content here\n');
  await mkdir(join(dir, 'sub'));
  await writeFile(join(dir, 'sub', 'b.md'), '# B\n\nbeta content here\n');
  await mkdir(join(dir, '.obsidian'));
  await writeFile(join(dir, '.obsidian', 'config.md'), 'should be skipped\n');
  await writeFile(join(dir, 'notes.txt'), 'not markdown\n');
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('indexer', () => {
  it('walks .md files recursively, skipping dotdirs and non-md', async () => {
    const files = await walkMarkdown(dir);
    const rels = files.map((f) => f.replace(dir, '').replace(/^[/\\]/, ''));
    expect(rels.sort()).toEqual(['a.md', join('sub', 'b.md')].sort());
  });
  it('indexes every note into a VaultIndex (relative paths)', async () => {
    const idx = new VaultIndex(new FakeEmbedder(64));
    const n = await indexVault(dir, idx);
    expect(n).toBe(2);
    const hits = await idx.query('beta content here', 3);
    expect(hits[0].notePath).toBe(join('sub', 'b.md'));
    expect(hits[0].text).toContain('beta content here');
  });
});
