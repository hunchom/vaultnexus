import { describe, it, expect } from 'vitest';
import { createHttpApp } from '../../src/daemon/http.js';
import { VaultIndex } from '../../src/daemon/vault-index.js';
import { FakeEmbedder } from '../../src/core/embedder.js';

describe('GET /status', () => {
  it('reports indexed=0 + chatModel=none when no index injected', async () => {
    const res = await createHttpApp().request('/status');
    expect(res.status).toBe(200);
    const j = (await res.json()) as Record<string, unknown>;
    expect(j.status).toBe('ok');
    expect(j.indexed).toBe(0);
    expect(j.chatModel).toBe('none');
    expect(j.embedder).toBe('fake');
    expect((j.tools as string[]).length).toBe(8);
  });

  it('reports embedderId from deps', async () => {
    const idx = new VaultIndex(new FakeEmbedder(16));
    const app = createHttpApp({ index: idx, embedderId: 'voyage-3-large' });
    const res = await app.request('/status');
    const j = (await res.json()) as Record<string, unknown>;
    expect(j.embedder).toBe('voyage-3-large');
  });

  it('reports indexed chunk count when index has data', async () => {
    const idx = new VaultIndex(new FakeEmbedder(16));
    await idx.addNote('a.md', '# A\n\npara one\n\npara two\n\npara three\n');
    const app = createHttpApp({ index: idx, embedderId: 'fake' });
    const j = (await (await app.request('/status')).json()) as { indexed: number };
    expect(j.indexed).toBeGreaterThan(0);
  });

  it('tools list contains all 8 vaultnexus_* names', async () => {
    const j = (await (await createHttpApp().request('/status')).json()) as { tools: string[] };
    const expected = new Set([
      'vaultnexus_ping', 'vaultnexus_search', 'vaultnexus_bridges',
      'vaultnexus_trace', 'vaultnexus_reason', 'vaultnexus_history',
      'vaultnexus_recall_history', 'vaultnexus_forecasts',
    ]);
    for (const name of j.tools) expect(expected.has(name)).toBe(true);
    expect(j.tools.length).toBe(expected.size);
  });
});
