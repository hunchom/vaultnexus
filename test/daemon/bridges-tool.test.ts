import { describe, it, expect } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createMcpServer } from '../../src/daemon/mcp-server.js';
import { VaultIndex } from '../../src/daemon/vault-index.js';
import { FakeEmbedder } from '../../src/core/embedder.js';

async function connect(server: ReturnType<typeof createMcpServer>) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const c = new Client({ name: 't', version: '0' });
  await c.connect(ct);
  return c;
}

describe('vaultnexus_bridges tool', () => {
  it('absent without an index; present with one', async () => {
    expect((await (await connect(createMcpServer())).listTools()).tools.map((t) => t.name))
      .not.toContain('vaultnexus_bridges');
    const idx = new VaultIndex(new FakeEmbedder(32));
    await idx.addNote('a.md', 'x\n');
    expect((await (await connect(createMcpServer({ index: idx }))).listTools()).tools.map((t) => t.name))
      .toContain('vaultnexus_bridges');
  });
  it('returns cross-note bridges as JSON', async () => {
    const idx = new VaultIndex(new FakeEmbedder(64));
    await idx.addNote('a.md', '# A\n\nshared insight about systems\n\nfiller one\n');
    await idx.addNote('b.md', '# B\n\nshared insight about systems\n\nfiller two\n');
    const client = await connect(createMcpServer({ index: idx }));
    const res = await client.callTool({ name: 'vaultnexus_bridges', arguments: { topN: 5 } });
    const bridges = JSON.parse((res.content as Array<{ type: string; text: string }>)[0].text);
    expect(bridges.length).toBeGreaterThan(0);
    expect(bridges[0].a.notePath).not.toBe(bridges[0].b.notePath);
    await client.close();
  });
});
