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

describe('traceReasoning — edge cases', () => {
  it('empty index → trace() returns []', async () => {
    const idx = new VaultIndex(new FakeEmbedder(32));
    expect(await idx.trace('anything')).toEqual([]);
  });

  it('honors maxHops cap even when more candidates exist', async () => {
    const idx = new VaultIndex(new FakeEmbedder(64));
    await idx.addNote('A.md', '# A\n\nshared insight x\n\nshared insight y\n\nshared insight z\n');
    await idx.addNote('B.md', '# B\n\nshared insight x\n\nshared insight y\n\nshared insight z\n');
    await idx.addNote('C.md', '# C\n\nshared insight x\n\nshared insight y\n\nshared insight z\n');
    const cap = 2;
    const hops = await idx.trace('shared insight', {
      maxDepth: 2,
      kSeeds: 5,
      knnPerHop: 5,
      simThreshold: -1,
      maxHops: cap,
    });
    expect(hops.length).toBeLessThanOrEqual(cap);
  });

  it('deterministic: two runs with same inputs deep-equal', async () => {
    const idx = new VaultIndex(new FakeEmbedder(64));
    await idx.addNote('A.md', '# A\n\nthe central topic\n\nlink to [[B]]\n');
    await idx.addNote('B.md', '# B\n\nrelated body content\n\nmore stuff\n');
    const opts = { maxDepth: 2, kSeeds: 2, knnPerHop: 2, simThreshold: 0.3 };
    const a = await idx.trace('the central topic', opts);
    const b = await idx.trace('the central topic', opts);
    expect(a).toEqual(b);
  });

  it('byte offsets satisfy 0 ≤ byteStart < byteEnd ≤ sourceByteLen for every hop', async () => {
    const sources: Record<string, string> = {
      'A.md': '# A\n\nthe central topic\n\nbody filler a\n',
      'B.md': '# B\n\nrelated body content\n\nmore stuff here\n',
    };
    const idx = new VaultIndex(new FakeEmbedder(64));
    for (const [p, s] of Object.entries(sources)) await idx.addNote(p, s);
    const hops = await idx.trace('the central topic', { maxDepth: 1, kSeeds: 2 });
    for (const h of hops) {
      const srcLen = Buffer.byteLength(sources[h.chunk.notePath]);
      expect(h.chunk.byteStart).toBeGreaterThanOrEqual(0);
      expect(h.chunk.byteStart).toBeLessThan(h.chunk.byteEnd);
      expect(h.chunk.byteEnd).toBeLessThanOrEqual(srcLen);
      // verify text matches source slice (mechanical citation invariant)
      const slice = Buffer.from(sources[h.chunk.notePath]).subarray(h.chunk.byteStart, h.chunk.byteEnd).toString();
      expect(slice).toBe(h.chunk.text);
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

  it('wikilink wins over kNN across frontier ordering', async () => {
    // contract: chunk reachable via both wikilink + kNN at same level → tagged 'wikilink'
    // FakeEmbedder hashes whole text → identical paragraphs across notes give cosine 1.0
    // construction:
    //   A.md → unique seed paragraph + [[X]] wikilink (A reaches X via wikilink)
    //   B.md → paragraph IDENTICAL to X's first paragraph (B reaches X via kNN cos 1.0)
    //   X.md → first paragraph identical to B → both A-wikilink AND B-kNN reach this chunk
    // both A + B seeded into level-0 frontier. forced query order [B, A] →
    // if BFS were per-fromId only: B's kNN would tag X-chunk 'knn' before A's wikilink-pass.
    // correct two-pass BFS: wikilink-pass over WHOLE frontier first → X tagged 'wikilink'.
    const sharedXText = 'paragraph identical across X and B for kNN edge cosine one';
    const idx = new VaultIndex(new FakeEmbedder(64));
    await idx.addNote('A.md', `# A\n\nthe unique A seed paragraph alpha\n\nrouting via [[X]] here\n`);
    await idx.addNote('B.md', `# B\n\n${sharedXText}\n`);
    await idx.addNote('X.md', `# X\n\n${sharedXText}\n\nfiller x body distinct\n`);
    const internals = idx as unknown as {
      chunks: IndexedChunk[]; f32: Float32Array[]; noteLinks: Map<string, string[]>;
    };
    const chunkIdOf = (hit: SearchHit): number =>
      internals.chunks.findIndex((c) => c.notePath === hit.notePath && c.byteStart === hit.byteStart);
    // build forged seed hits manually → bypass natural query (X would otherwise self-match)
    const aSeedChunk = internals.chunks.find((c) => c.notePath === 'A.md' && c.text.includes('alpha'))!;
    const bSeedChunk = internals.chunks.find((c) => c.notePath === 'B.md' && c.text.includes('paragraph identical'))!;
    expect(aSeedChunk).toBeDefined();
    expect(bSeedChunk).toBeDefined();
    const aSeed: SearchHit = { ...aSeedChunk, score: 1.0 };
    const bSeed: SearchHit = { ...bSeedChunk, score: 1.0 };
    const facade: TraceFacade = {
      chunks: internals.chunks,
      f32: internals.f32,
      noteLinks: internals.noteLinks,
      // forge order [B, A] → B's kNN-pass would race A's wikilink-pass under per-fromId BFS
      query: async () => [bSeed, aSeed],
      chunkIdOf,
    };
    const hops = await traceReasoning(facade, 'irrelevant', {
      maxDepth: 1, simThreshold: 0.3, knnPerHop: 2, kSeeds: 2,
    });
    const xHops = hops.filter((h) => h.chunk.notePath === 'X.md');
    expect(xHops.length).toBeGreaterThan(0);
    // X's first chunk (text=sharedXText) is reachable via BOTH A-wikilink AND B-kNN → must be 'wikilink'
    const sharedXHop = xHops.find((h) => h.chunk.text === sharedXText);
    expect(sharedXHop, 'shared X chunk reached by both wikilink + kNN').toBeDefined();
    expect(sharedXHop!.edgeType, 'wikilink must win over kNN across frontier').toBe('wikilink');
    // inverse order → contract holds either way
    const facade2: TraceFacade = { ...facade, query: async () => [aSeed, bSeed] };
    const hops2 = await traceReasoning(facade2, 'irrelevant', {
      maxDepth: 1, simThreshold: 0.3, knnPerHop: 2, kSeeds: 2,
    });
    const sharedXHop2 = hops2.find((h) => h.chunk.notePath === 'X.md' && h.chunk.text === sharedXText);
    expect(sharedXHop2).toBeDefined();
    expect(sharedXHop2!.edgeType).toBe('wikilink');
  });
});
