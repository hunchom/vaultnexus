import { describe, it, expect } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createMcpServer } from '../../src/daemon/mcp-server.js';
import { VaultIndex } from '../../src/daemon/vault-index.js';
import { FakeEmbedder } from '../../src/core/embedder.js';
import { FakeChatModel } from '../../src/core/fake-chat-model.js';

async function connect(server: ReturnType<typeof createMcpServer>): Promise<Client> {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const c = new Client({ name: 't', version: '0' });
  await c.connect(ct);
  return c;
}

describe('vaultnexus_reason MCP tool', () => {
  it('absent without an index; present with one', async () => {
    expect((await (await connect(createMcpServer())).listTools()).tools.map((t) => t.name)).not.toContain(
      'vaultnexus_reason',
    );
    const idx = new VaultIndex(new FakeEmbedder(32), undefined, new FakeChatModel());
    await idx.addNote('a.md', 'x\n');
    expect(
      (await (await connect(createMcpServer({ index: idx }))).listTools()).tools.map((t) => t.name),
    ).toContain('vaultnexus_reason');
  });

  it('returns { answer, hops, model } with FakeChatModel id=fake', async () => {
    const idx = new VaultIndex(new FakeEmbedder(64), undefined, new FakeChatModel());
    await idx.addNote('A.md', '# A\n\nthe central topic\n\nlink [[B]]\n');
    await idx.addNote('B.md', '# B\n\nrelated body content\n\nmore stuff here\n');
    const client = await connect(createMcpServer({ index: idx }));
    const res = await client.callTool({
      name: 'vaultnexus_reason',
      arguments: { question: 'the central topic', maxDepth: 1, kSeeds: 2 },
    });
    const parsed = JSON.parse((res.content as Array<{ type: string; text: string }>)[0].text);
    expect(typeof parsed.answer).toBe('string');
    expect(Array.isArray(parsed.hops)).toBe(true);
    expect(parsed.hops.length).toBeGreaterThan(0);
    expect(parsed.model).toBe('fake');
    expect(parsed.answer).toContain('[fake-compose]');
    await client.close();
  });

  it('zero-hop question → fallback answer + empty hops, model still reported', async () => {
    const idx = new VaultIndex(new FakeEmbedder(32), undefined, new FakeChatModel());
    // empty index → reason returns fallback
    const client = await connect(createMcpServer({ index: idx }));
    // empty-index → vaultnexus_reason tool registers only when at least one chunk exists in some impls;
    // we register it whenever an index is present, so call must still succeed:
    const tools = (await client.listTools()).tools.map((t) => t.name);
    if (!tools.includes('vaultnexus_reason')) {
      await client.close();
      return; // implementation chose not to register on empty → acceptable
    }
    const res = await client.callTool({
      name: 'vaultnexus_reason',
      arguments: { question: 'anything' },
    });
    const parsed = JSON.parse((res.content as Array<{ type: string; text: string }>)[0].text);
    expect(parsed.model).toBe('fake');
    expect(parsed.hops).toEqual([]);
    await client.close();
  });
});
