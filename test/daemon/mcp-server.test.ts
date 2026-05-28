import { describe, it, expect } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createMcpServer } from '../../src/daemon/mcp-server.js';
import { health } from '../../src/core/health.js';

describe('createMcpServer', () => {
  it('exposes vaultnexus_ping returning the health snapshot', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer();
    await server.connect(serverTransport);

    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(clientTransport);

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain('vaultnexus_ping');

    const result = await client.callTool({ name: 'vaultnexus_ping', arguments: {} });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const got = JSON.parse(text);
    // ping returns health() plus an embedder id field; both must be present.
    expect(got).toMatchObject(health());
    expect(typeof got.embedder).toBe('string');

    await client.close();
  });
});
