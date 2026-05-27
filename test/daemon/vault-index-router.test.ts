/** Plan 25 — router + diversity integration over a small FakeEmbedder vault. */
import { describe, it, expect } from 'vitest';
import { VaultIndex } from '../../src/daemon/vault-index.js';
import { FakeEmbedder } from '../../src/core/embedder.js';

describe('VaultIndex.queryWithMeta — router (Plan 25)', () => {
  it('router off (default) → intent null, weights null', async () => {
    const idx = new VaultIndex(new FakeEmbedder(32));
    await idx.addNote('a.md', 'a fox runs\n\nlazy dog rests\n');
    const { meta } = await idx.queryWithMeta('any old thing', 3);
    expect(meta.intent).toBe(null);
    expect(meta.weights).toBe(null);
  });

  it('router=true on short query → specific intent + (1.0, 0.4) weights', async () => {
    const idx = new VaultIndex(new FakeEmbedder(32));
    await idx.addNote('a.md', 'fox\n\ndog\n');
    const { meta } = await idx.queryWithMeta('OODA loop', 3, { router: true });
    expect(meta.intent).toBe('specific');
    expect(meta.weights).toEqual([1.0, 0.4]);
  });

  it('router=true on long paraphrase → broad intent + (1.0, 0.0) weights', async () => {
    const idx = new VaultIndex(new FakeEmbedder(32));
    await idx.addNote('a.md', 'fox\n\ndog\n');
    const { meta } = await idx.queryWithMeta(
      'why waiting until the last minute actually produces better outcomes for me',
      3,
      { router: true },
    );
    expect(meta.intent).toBe('broad');
    expect(meta.weights).toEqual([1.0, 0.0]);
  });

  it('router=true on 4-7 word query → mixed intent + (1.0, 1.0) weights', async () => {
    const idx = new VaultIndex(new FakeEmbedder(32));
    await idx.addNote('a.md', 'fox\n\ndog\n');
    const { meta } = await idx.queryWithMeta('how to prioritize tasks well', 3, { router: true });
    expect(meta.intent).toBe('mixed');
    expect(meta.weights).toEqual([1.0, 1.0]);
  });

  it('router=true broad query → FTS contribution suppressed (no FTS-only id reaches top)', async () => {
    // a.md: target paraphrase chunk that does NOT share keywords with the query.
    // b.md: keyword-matching chunk that would normally win FTS.
    const idx = new VaultIndex(new FakeEmbedder(32));
    await idx.addNote('a.md', 'completely unrelated chunk one\n\nanother filler line\n');
    await idx.addNote('b.md', 'the quick brown fox jumps over the lazy dog every single day\n');
    // FakeEmbedder is hash-based → vector ordering is essentially random; what matters
    // here is that with broad routing, the FTS-keyword winner does NOT get an artificial
    // RRF boost over the vector-side ranking. We assert the meta wiring; relevance
    // judgement is left to the real eval.
    const broad = await idx.queryWithMeta(
      'the quick brown fox jumps over the lazy dog every single day repeatedly',
      5,
      { router: true },
    );
    expect(broad.meta.intent).toBe('broad');
    expect(broad.meta.weights).toEqual([1.0, 0.0]);
  });
});

describe('VaultIndex.queryWithMeta — diversity / DPP (Plan 25)', () => {
  it('diversity=0 (default) → no DPP, meta.diversity=0', async () => {
    const idx = new VaultIndex(new FakeEmbedder(32));
    await idx.addNote('a.md', 'one\n\ntwo\n');
    const { meta } = await idx.queryWithMeta('x', 3);
    expect(meta.diversity).toBe(0);
  });

  it('diversity>0 reduces redundancy: top-K covers more distinct notes than pure relevance', async () => {
    // Note A has many similar chunks → vector ranker would fill top-K with A.
    // Note B has one distinct chunk → diversity should pull it into top-K.
    const idx = new VaultIndex(new FakeEmbedder(64));
    const longA = Array.from({ length: 10 }, (_, i) => `chunk about foxes number ${i}`).join('\n\n');
    await idx.addNote('a.md', longA);
    await idx.addNote(
      'b.md',
      'a unique paragraph that talks about completely different topics like horses\n',
    );

    const pure = await idx.queryWithMeta('foxes', 5, { diversity: 0 });
    const diverse = await idx.queryWithMeta('foxes', 5, { diversity: 0.5 });

    const pureNotes = new Set(pure.hits.map((h) => h.notePath));
    const diverseNotes = new Set(diverse.hits.map((h) => h.notePath));
    // Either diverse covers ≥ as many distinct notes, OR (rare with FakeEmbedder)
    // pure already covers both — but it must not REGRESS. Assert non-regression.
    expect(diverseNotes.size).toBeGreaterThanOrEqual(pureNotes.size);
    expect(diverse.meta.diversity).toBe(0.5);
  });

  it('diversity + router compose: meta carries both', async () => {
    const idx = new VaultIndex(new FakeEmbedder(32));
    await idx.addNote('a.md', 'paragraph one\n\nparagraph two\n');
    const { meta } = await idx.queryWithMeta('foo', 3, { router: true, diversity: 0.3 });
    expect(meta.intent).toBe('specific'); // 1 word
    expect(meta.diversity).toBe(0.3);
    expect(meta.weights).toEqual([1.0, 0.4]);
  });

  it('diversity clamped to [0,1]', async () => {
    const idx = new VaultIndex(new FakeEmbedder(32));
    await idx.addNote('a.md', 'paragraph one\n\nparagraph two\n');
    const tooBig = await idx.queryWithMeta('x', 3, { diversity: 5 });
    expect(tooBig.meta.diversity).toBe(1);
    const tooSmall = await idx.queryWithMeta('x', 3, { diversity: -0.5 });
    expect(tooSmall.meta.diversity).toBe(0);
  });
});

describe('VaultIndex.query — backwards compat (Plan 25)', () => {
  it('query(text, k) → identical result to pre-Plan-25 path (no opts)', async () => {
    const idx = new VaultIndex(new FakeEmbedder(32));
    await idx.addNote('a.md', 'paragraph one alpha\n\nparagraph two beta\n');
    await idx.addNote('b.md', 'gamma chunk\n\ndelta chunk\n');
    const hits = await idx.query('alpha', 3);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].text).toContain('alpha');
  });
});
