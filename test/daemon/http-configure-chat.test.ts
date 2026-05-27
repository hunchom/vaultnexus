import { describe, it, expect } from 'vitest';
import { createHttpApp } from '../../src/daemon/http.js';
import { VaultIndex } from '../../src/daemon/vault-index.js';
import { FakeEmbedder } from '../../src/core/embedder.js';

async function postJson(app: ReturnType<typeof createHttpApp>, path: string, body: unknown): Promise<Response> {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// Hot-swap chat model via plugin → daemon /configure-chat. No restart.
describe('createHttpApp — POST /configure-chat (chat hot-swap)', () => {
  it('503s when no index injected', async () => {
    const res = await postJson(createHttpApp(), '/configure-chat', { provider: 'fake' });
    expect(res.status).toBe(503);
  });

  it('400s on bad body (no provider)', async () => {
    const idx = new VaultIndex(new FakeEmbedder(16));
    const res = await postJson(createHttpApp({ index: idx }), '/configure-chat', {});
    expect(res.status).toBe(400);
  });

  it('400s on missing key for anthropic', async () => {
    const idx = new VaultIndex(new FakeEmbedder(16));
    const res = await postJson(createHttpApp({ index: idx }), '/configure-chat', { provider: 'anthropic' });
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error: string };
    expect(j.error).toMatch(/VAULTNEXUS_CHAT_KEY required/);
  });

  it('swaps to fake → fake (idempotent)', async () => {
    const idx = new VaultIndex(new FakeEmbedder(16));
    expect(idx.chatModelId()).toBe('none');
    const res = await postJson(createHttpApp({ index: idx }), '/configure-chat', { provider: 'fake' });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { ok: boolean; chatModel: string };
    expect(j.ok).toBe(true);
    expect(j.chatModel).toBe('fake');
    expect(idx.chatModelId()).toBe('fake');
  });

  it('swaps to anthropic w/ key → chatModelId reflects provider:model', async () => {
    const idx = new VaultIndex(new FakeEmbedder(16));
    const res = await postJson(createHttpApp({ index: idx }), '/configure-chat', {
      provider: 'anthropic',
      key: 'sk-ant-test',
      model: 'claude-sonnet-4-6',
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { ok: boolean; chatModel: string };
    expect(j.chatModel).toBe('anthropic:claude-sonnet-4-6');
    expect(idx.chatModelId()).toBe('anthropic:claude-sonnet-4-6');
  });

  it('swaps to openai-compatible w/ baseURL + model', async () => {
    const idx = new VaultIndex(new FakeEmbedder(16));
    const res = await postJson(createHttpApp({ index: idx }), '/configure-chat', {
      provider: 'openai-compatible',
      key: 'local',
      model: 'llama3.1:8b',
      baseURL: 'http://localhost:11434/v1',
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { ok: boolean; chatModel: string };
    expect(j.chatModel).toBe('openai-compatible:llama3.1:8b');
  });

  it('rejects invalid baseURL', async () => {
    const idx = new VaultIndex(new FakeEmbedder(16));
    const res = await postJson(createHttpApp({ index: idx }), '/configure-chat', {
      provider: 'openai-compatible',
      key: 'k',
      model: 'm',
      baseURL: 'not-a-url',
    });
    expect(res.status).toBe(400);
  });
});
