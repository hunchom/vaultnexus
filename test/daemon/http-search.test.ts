import { describe, it, expect } from 'vitest';
import { createHttpApp } from '../../src/daemon/http.js';
import { VaultIndex } from '../../src/daemon/vault-index.js';
import { FakeEmbedder } from '../../src/core/embedder.js';

// Helper → POST JSON to a Hono app via app.request() (matches test/daemon/http.test.ts style).
async function postJson(app: ReturnType<typeof createHttpApp>, path: string, body: unknown): Promise<Response> {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('createHttpApp — /search + /bridges (Plan 29: Obsidian loopback)', () => {
  it('POST /search returns cited hits when an index is injected', async () => {
    const idx = new VaultIndex(new FakeEmbedder(32));
    await idx.addNote('a.md', '# A\n\nthe quick brown fox jumps over the lazy dog\n');
    await idx.addNote('b.md', '# B\n\ntotally unrelated content here\n');
    const app = createHttpApp({ index: idx });

    const res = await postJson(app, '/search', { query: 'quick fox', k: 5 });
    expect(res.status).toBe(200);
    const hits = (await res.json()) as Array<{ notePath: string; score: number }>;
    expect(Array.isArray(hits)).toBe(true);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]).toHaveProperty('notePath');
    expect(hits[0]).toHaveProperty('score');
  });

  it('POST /search 503s when no index is injected', async () => {
    const app = createHttpApp();
    const res = await postJson(app, '/search', { query: 'anything' });
    expect(res.status).toBe(503);
  });

  it('POST /search 400s on malformed body', async () => {
    const idx = new VaultIndex(new FakeEmbedder(16));
    const app = createHttpApp({ index: idx });
    const res = await postJson(app, '/search', { missing: 'query field' });
    expect(res.status).toBe(400);
  });

  it('POST /bridges returns cross-note pairs', async () => {
    const idx = new VaultIndex(new FakeEmbedder(64));
    await idx.addNote('a.md', '# A\n\nshared insight about systems\n\nfiller one\n');
    await idx.addNote('b.md', '# B\n\nshared insight about systems\n\nfiller two\n');
    const app = createHttpApp({ index: idx });

    const res = await postJson(app, '/bridges', { topN: 5 });
    expect(res.status).toBe(200);
    const bridges = (await res.json()) as Array<{ a: { notePath: string }; b: { notePath: string } }>;
    expect(Array.isArray(bridges)).toBe(true);
    expect(bridges.length).toBeGreaterThan(0);
    expect(bridges[0].a.notePath).not.toBe(bridges[0].b.notePath);
  });

  it('POST /bridges 503s when no index is injected', async () => {
    const app = createHttpApp();
    const res = await postJson(app, '/bridges', {});
    expect(res.status).toBe(503);
  });
});
