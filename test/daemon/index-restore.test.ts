import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeEmbedder } from '../../src/core/embedder.js';
import { IndexSnapshot } from '../../src/daemon/index-snapshot.js';
import { restoreOrRebuildIndex } from '../../src/daemon/index-restore.js';

const tmpDb = (): string => join(mkdtempSync(join(tmpdir(), 'vn-snap-')), 's.db');

let vault: string;
beforeEach(async () => {
  vault = await mkdtemp(join(tmpdir(), 'vn-vault-'));
  await writeFile(join(vault, 'a.md'), '# A\n\nalpha alpha alpha content\n');
  await mkdir(join(vault, 'sub'));
  await writeFile(join(vault, 'sub', 'b.md'), '# B\n\nbeta beta beta content\n');
  await writeFile(join(vault, 'c.md'), '# C\n\ngamma gamma gamma content\n');
});
afterEach(async () => { await rm(vault, { recursive: true, force: true }); });

describe('restoreOrRebuildIndex', () => {
  it('cold start with empty snapshot → rebuilds all', async () => {
    const snap = new IndexSnapshot(tmpDb());
    const { index, stats } = await restoreOrRebuildIndex(vault, new FakeEmbedder(64), snap);
    expect(stats.total).toBe(3);
    expect(stats.rebuilt).toBe(3);
    expect(stats.restored).toBe(0);
    expect(stats.pruned).toBe(0);
    const hits = await index.query('beta beta beta content', 3);
    expect(hits[0].notePath).toBe(join('sub', 'b.md'));
    index.close();
    snap.close();
  });

  it('warm start with full snapshot → restores all, no re-embed', async () => {
    const path = tmpDb();
    // cold pass to populate snapshot
    const snap1 = new IndexSnapshot(path);
    const cold = await restoreOrRebuildIndex(vault, new FakeEmbedder(64), snap1);
    expect(cold.stats.rebuilt).toBe(3);
    cold.index.close();
    snap1.close();

    // warm pass — sentinel embedder throws if called
    const snap2 = new IndexSnapshot(path);
    const sentinel = new (class {
      readonly dimensions = 64;
      async embed(_texts: string[]): Promise<Float32Array[]> {
        // query() calls embed once for the query text → can't fully ban it. Track instead.
        calls += 1;
        return _texts.map(() => new Float32Array(64));
      }
    })();
    let calls = 0;
    const { index, stats } = await restoreOrRebuildIndex(vault, sentinel, snap2);
    expect(stats.restored).toBe(3);
    expect(stats.rebuilt).toBe(0);
    expect(calls).toBe(0); // restore path never embedded a single block
    // still 3 notes worth of chunks indexed
    expect(index.size).toBeGreaterThanOrEqual(3);
    index.close();
    snap2.close();
  });

  it('delta rebuild — one note changed → re-embed only that note', async () => {
    const path = tmpDb();
    const snap1 = new IndexSnapshot(path);
    const cold = await restoreOrRebuildIndex(vault, new FakeEmbedder(64), snap1);
    cold.index.close();
    snap1.close();

    // mutate c.md content (need different bytes → different sha)
    await writeFile(join(vault, 'c.md'), '# C\n\nDELTA replaced gamma content totally\n');

    const snap2 = new IndexSnapshot(path);
    const { index, stats } = await restoreOrRebuildIndex(vault, new FakeEmbedder(64), snap2);
    expect(stats.restored).toBe(2);
    expect(stats.rebuilt).toBe(1);
    expect(stats.pruned).toBe(0);
    // changed note → new content reflected somewhere in the index
    const hits = await index.query('DELTA replaced gamma content', 10);
    const cHit = hits.find((h) => h.notePath === 'c.md');
    expect(cHit).toBeDefined();
    expect(cHit!.text).toContain('DELTA replaced gamma content');
    // old gamma content for c.md must be gone
    expect(hits.every((h) => h.notePath !== 'c.md' || !h.text.includes('gamma gamma gamma'))).toBe(true);
    index.close();
    snap2.close();
  });

  it('prunes snapshot rows for deleted files', async () => {
    const path = tmpDb();
    const snap1 = new IndexSnapshot(path);
    const cold = await restoreOrRebuildIndex(vault, new FakeEmbedder(64), snap1);
    cold.index.close();
    snap1.close();

    await rm(join(vault, 'sub', 'b.md'));

    const snap2 = new IndexSnapshot(path);
    const { index, stats } = await restoreOrRebuildIndex(vault, new FakeEmbedder(64), snap2);
    expect(stats.restored).toBe(2);
    expect(stats.pruned).toBe(1);
    expect(snap2.getNote(join('sub', 'b.md'))).toBeUndefined();
    index.close();
    snap2.close();
  });

  it('new file added → restored + new', async () => {
    const path = tmpDb();
    const snap1 = new IndexSnapshot(path);
    const cold = await restoreOrRebuildIndex(vault, new FakeEmbedder(64), snap1);
    cold.index.close();
    snap1.close();

    await writeFile(join(vault, 'd.md'), '# D\n\ndelta new note content\n');

    const snap2 = new IndexSnapshot(path);
    const { index, stats } = await restoreOrRebuildIndex(vault, new FakeEmbedder(64), snap2);
    expect(stats.restored).toBe(3);
    expect(stats.rebuilt).toBe(1);
    const hits = await index.query('delta new note content', 3);
    expect(hits[0].notePath).toBe('d.md');
    index.close();
    snap2.close();
  });
});
