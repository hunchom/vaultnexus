import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Embedder } from '../../src/core/embedder.js';
import { FakeEmbedder } from '../../src/core/embedder.js';
import { IndexSnapshot } from '../../src/daemon/index-snapshot.js';
import { restoreOrRebuildIndex } from '../../src/daemon/index-restore.js';

const tmpDb = (): string => join(mkdtempSync(join(tmpdir(), 'vn-snap-')), 's.db');

/** Wraps FakeEmbedder with artificial latency → simulates real network embedder. */
class SlowEmbedder implements Embedder {
  readonly dimensions: number;
  public callCount = 0;
  public blockCount = 0;
  constructor(private readonly base: FakeEmbedder, private readonly latencyMs: number) {
    this.dimensions = base.dimensions;
  }
  async embed(texts: string[]): Promise<Float32Array[]> {
    this.callCount += 1;
    this.blockCount += texts.length;
    await new Promise((r) => setTimeout(r, this.latencyMs));
    return this.base.embed(texts);
  }
}

let vault: string;
beforeEach(async () => {
  vault = await mkdtemp(join(tmpdir(), 'vn-restart-'));
  // ~30 notes → meaningful timing signal
  for (let i = 0; i < 30; i++) {
    await writeFile(
      join(vault, `note-${i}.md`),
      `# Note ${i}\n\nThis is content for note ${i}.\n\nSecond paragraph about topic ${i % 5}.\n`,
    );
  }
});
afterEach(async () => { await rm(vault, { recursive: true, force: true }); });

describe('restart speedup (Plan 26)', () => {
  it('warm restart is faster than cold AND produces identical query results', async () => {
    const path = tmpDb();
    const base = new FakeEmbedder(64);

    // cold start — pays embed-latency cost per note
    const cold = new SlowEmbedder(base, 5); // 5ms per embed call → ~150ms over 30 notes
    const t0Cold = process.hrtime.bigint();
    const snap1 = new IndexSnapshot(path);
    const { index: idx1, stats: s1 } = await restoreOrRebuildIndex(vault, cold, snap1);
    const coldMs = Number((process.hrtime.bigint() - t0Cold) / 1_000_000n);
    expect(s1.rebuilt).toBe(30);
    expect(s1.restored).toBe(0);
    const coldHits = await idx1.query('content for note 7', 5);
    idx1.close();
    snap1.close();

    // warm restart — should skip embedding entirely
    const warm = new SlowEmbedder(base, 5);
    const t0Warm = process.hrtime.bigint();
    const snap2 = new IndexSnapshot(path);
    const { index: idx2, stats: s2 } = await restoreOrRebuildIndex(vault, warm, snap2);
    const warmMs = Number((process.hrtime.bigint() - t0Warm) / 1_000_000n);
    expect(s2.restored).toBe(30);
    expect(s2.rebuilt).toBe(0);
    expect(warm.blockCount).toBe(0); // zero embed calls during restore
    const warmHits = await idx2.query('content for note 7', 5);
    idx2.close();
    snap2.close();

    // speedup signal — warm must be strictly faster
    expect(warmMs).toBeLessThan(coldMs);
    process.stderr.write(`Plan 26 restart: cold=${coldMs}ms warm=${warmMs}ms (saved ${coldMs - warmMs}ms)\n`);

    // identical retrieval — same chunks, same ordering, same scores
    expect(warmHits.length).toBe(coldHits.length);
    for (let i = 0; i < coldHits.length; i++) {
      expect(warmHits[i].notePath).toBe(coldHits[i].notePath);
      expect(warmHits[i].byteStart).toBe(coldHits[i].byteStart);
      expect(warmHits[i].text).toBe(coldHits[i].text);
      // f32 vec rehydrated from BLOB → cosine score must match to high precision
      expect(warmHits[i].score).toBeCloseTo(coldHits[i].score, 6);
    }
  });
});
