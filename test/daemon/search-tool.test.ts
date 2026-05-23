import { describe, it, expect } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createMcpServer } from '../../src/daemon/mcp-server.js';
import { VaultIndex } from '../../src/daemon/vault-index.js';
import { FakeEmbedder } from '../../src/core/embedder.js';

async function connect(server: ReturnType<typeof createMcpServer>) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: 't', version: '0' });
  await client.connect(ct);
  return client;
}

describe('vaultnexus_search tool', () => {
  it('is absent when no index is provided (ping still present)', async () => {
    const client = await connect(createMcpServer());
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('vaultnexus_ping');
    expect(names).not.toContain('vaultnexus_search');
    await client.close();
  });
  it('searches the injected index and returns cited hits', async () => {
    const idx = new VaultIndex(new FakeEmbedder(64));
    await idx.addNote('notes/a.md', '# H\n\nthe quick brown fox\n\nlazy dog\n');
    const client = await connect(createMcpServer({ index: idx }));
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('vaultnexus_search');
    const res = await client.callTool({ name: 'vaultnexus_search', arguments: { query: 'the quick brown fox', k: 3 } });
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    const hits = JSON.parse(text) as Array<{ notePath: string; text: string; score: number }>;
    expect(hits[0].notePath).toBe('notes/a.md');
    expect(hits[0].text).toContain('the quick brown fox');
    await client.close();
  });
});
