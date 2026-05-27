import { describe, it, expect } from 'vitest';
import { VaultIndex, type IndexedChunk, type SearchHit } from '../../src/daemon/vault-index.js';
import { FakeEmbedder } from '../../src/core/embedder.js';
import { traceReasoning, type ReasonHop, type TraceFacade } from '../../src/daemon/reason-trace.js';

/** Build a facade backed by a real VaultIndex (the unit under test is traceReasoning, not the index). */
async function facadeOver(idx: VaultIndex): Promise<TraceFacade> {
  // private fields → reach via cast (test-only).
  const internals = idx as unknown as {
    chunks: IndexedChunk[];
    f32: Float32Array[];
    noteLinks: Map<string, string[]>;
  };
  return {
    chunks: internals.chunks,
    f32: internals.f32,
    noteLinks: internals.noteLinks,
    query: (text, k) => idx.query(text, k),
    chunkIdOf: (hit: SearchHit) =>
      internals.chunks.findIndex(
        (c) => c.notePath === hit.notePath && c.byteStart === hit.byteStart,
      ),
  };
}

describe('traceReasoning — seed-only behavior (maxDepth: 0)', () => {
  it('emits only seed hops, length ≤ kSeeds, descending scores, every chunk matches index', async () => {
    const idx = new VaultIndex(new FakeEmbedder(64));
    await idx.addNote(
      'a.md',
      '# A\n\nalpha block one\n\nalpha block two\n\nalpha block three\n\nalpha block four\n',
    );
    const facade = await facadeOver(idx);
    const hops = await traceReasoning(facade, 'alpha block one', { maxDepth: 0, kSeeds: 3 });

    expect(hops.length).toBeGreaterThan(0);
    expect(hops.length).toBeLessThanOrEqual(3);
    for (const h of hops) {
      expect(h.edgeType).toBe('seed');
      expect(h.step).toBe(0);
      expect(h.fromChunkId).toBeNull();
      expect(h.chunk).toBe(facade.chunks[h.toChunkId]);
    }
    for (let i = 1; i < hops.length; i++) {
      expect(hops[i - 1].score).toBeGreaterThanOrEqual(hops[i].score);
    }
  });
});

describe('traceReasoning — kNN cross-note BFS (maxDepth: 1)', () => {
  it('reaches a sibling note via k-NN edge when text is identical, no wikilinks', async () => {
    // FakeEmbedder: identical text → identical unit vector → cosine 1.0 across notes
    const idx = new VaultIndex(new FakeEmbedder(64));
    await idx.addNote('A.md', '# A\n\nshared insight about systems\n\nfiller a one\n');
    await idx.addNote('B.md', '# B\n\nshared insight about systems\n\nfiller b two\n');
    const facade = await facadeOver(idx);
    const hops = await traceReasoning(facade, 'shared insight about systems', {
      maxDepth: 1,
      kSeeds: 1,
      knnPerHop: 2,
      simThreshold: 0.3,
    });

    const knn = hops.filter((h) => h.edgeType === 'knn');
    expect(knn.length).toBeGreaterThan(0);
    const reached = knn.find((h) => h.chunk.notePath !== facade.chunks[h.fromChunkId!].notePath);
    expect(reached).toBeDefined();
    expect(reached!.step).toBe(1);
    expect(reached!.score).toBeGreaterThanOrEqual(0.3);
  });
});

describe('VaultIndex.trace() integration', () => {
  it('returns hops over a 3-note vault, monotonic step, every chunk bound by index.size', async () => {
    const idx = new VaultIndex(new FakeEmbedder(64));
    await idx.addNote('A.md', '# A\n\nthe central topic of inquiry\n\nbody filler a\n');
    await idx.addNote('B.md', '# B\n\nrelated to [[A]] in spirit\n\nbody filler b\n');
    await idx.addNote('C.md', '# C\n\nthe central topic of inquiry restated\n\nbody filler c\n');
    const hops = await idx.trace('the central topic of inquiry', { maxDepth: 1, kSeeds: 2 });
    expect(hops.length).toBeGreaterThan(0);
    for (const h of hops) {
      expect(h.toChunkId).toBeGreaterThanOrEqual(0);
      expect(h.toChunkId).toBeLessThan(idx.size);
    }
    const steps = hops.map((h: ReasonHop) => h.step);
    for (let i = 1; i < steps.length; i++) expect(steps[i]).toBeGreaterThanOrEqual(steps[i - 1]);
  });
});

describe('traceReasoning — wikilink BFS (maxDepth: 1)', () => {
  it('follows [[B]] from A to a chunk on B, recording edgeType=wikilink', async () => {
    const idx = new VaultIndex(new FakeEmbedder(64));
    await idx.addNote('A.md', '# A\n\nthe quick brown fox jumps\n\nlink to [[B]] here\n');
    await idx.addNote('B.md', '# B\n\ntotally different content payload\n\nmore B body\n\nstill on B note\n');
    const facade = await facadeOver(idx);
    const hops = await traceReasoning(facade, 'the quick brown fox jumps', {
      maxDepth: 1,
      kSeeds: 1, // only seed A.md's matching chunk → BFS reaches B via [[B]]
    });

    const wl = hops.filter((h) => h.edgeType === 'wikilink');
    expect(wl.length).toBeGreaterThan(0);
    const reached = wl.find((h) => h.chunk.notePath === 'B.md');
    expect(reached).toBeDefined();
    expect(reached!.fromChunkId).not.toBeNull();
    expect(facade.chunks[reached!.fromChunkId!].notePath).toBe('A.md');
    expect(reached!.step).toBe(1);
  });
});
