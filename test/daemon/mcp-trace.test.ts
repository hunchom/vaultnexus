import { describe, it, expect } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createMcpServer } from '../../src/daemon/mcp-server.js';
import { VaultIndex } from '../../src/daemon/vault-index.js';
import { FakeEmbedder } from '../../src/core/embedder.js';

async function connect(server: ReturnType<typeof createMcpServer>): Promise<Client> {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const c = new Client({ name: 't', version: '0' });
  await c.connect(ct);
  return c;
}

describe('vaultnexus_trace MCP tool', () => {
  it('absent without an index; present with one', async () => {
    expect((await (await connect(createMcpServer())).listTools()).tools.map((t) => t.name))
      .not.toContain('vaultnexus_trace');
    const idx = new VaultIndex(new FakeEmbedder(32));
    await idx.addNote('a.md', 'x\n');
    expect((await (await connect(createMcpServer({ index: idx }))).listTools()).tools.map((t) => t.name))
      .toContain('vaultnexus_trace');
  });
  it('returns a non-empty hops array shaped per ReasonHop', async () => {
    const idx = new VaultIndex(new FakeEmbedder(64));
    await idx.addNote('A.md', '# A\n\nthe central topic\n\nlink [[B]]\n');
    await idx.addNote('B.md', '# B\n\nrelated body content\n\nmore stuff here\n');
    const client = await connect(createMcpServer({ index: idx }));
    const res = await client.callTool({
      name: 'vaultnexus_trace',
      arguments: { question: 'the central topic', maxDepth: 1, kSeeds: 1 },
    });
    const parsed = JSON.parse((res.content as Array<{ type: string; text: string }>)[0].text);
    expect(Array.isArray(parsed.hops)).toBe(true);
    expect(parsed.hops.length).toBeGreaterThan(0);
    const h = parsed.hops[0];
    expect(typeof h.step).toBe('number');
    expect(['seed', 'wikilink', 'knn']).toContain(h.edgeType);
    expect(typeof h.toChunkId).toBe('number');
    expect(typeof h.score).toBe('number');
    expect(h.chunk.notePath).toBeDefined();
    expect(typeof h.chunk.byteStart).toBe('number');
    expect(typeof h.chunk.byteEnd).toBe('number');
    await client.close();
  });
});
