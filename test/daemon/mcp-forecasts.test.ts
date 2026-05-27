import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createMcpServer } from '../../src/daemon/mcp-server.js';
import { VaultIndex } from '../../src/daemon/vault-index.js';
import { FakeEmbedder } from '../../src/core/embedder.js';
import { seedDemoVault } from '../../scripts/seed-demo-vault.js';

async function connect(server: ReturnType<typeof createMcpServer>): Promise<Client> {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const c = new Client({ name: 't', version: '0' });
  await c.connect(ct);
  return c;
}

interface LedgerPayload {
  pending: Array<{ notePath: string; claim: string; probability: number }>;
  resolved: Array<{ notePath: string; outcome: boolean; probability: number; resolvedAt: string }>;
  brier: number | null;
}

describe('vaultnexus_forecasts MCP tool', () => {
  let cleanupRoot: string;
  let vaultPath: string;

  beforeAll(() => {
    cleanupRoot = mkdtempSync(join(tmpdir(), 'vn-mcp-forecasts-'));
    vaultPath = join(cleanupRoot, 'vault');
    seedDemoVault(vaultPath);
  });
  afterAll(() => { rmSync(cleanupRoot, { recursive: true, force: true }); });

  it('absent without an index; present with one', async () => {
    const noIdx = await connect(createMcpServer());
    expect((await noIdx.listTools()).tools.map((t) => t.name)).not.toContain(
      'vaultnexus_forecasts',
    );
    await noIdx.close();

    const idx = new VaultIndex(new FakeEmbedder(32), vaultPath);
    const client = await connect(createMcpServer({ index: idx }));
    expect((await client.listTools()).tools.map((t) => t.name)).toContain('vaultnexus_forecasts');
    await client.close();
  });

  it('Plan 14 seeded vault → 5 pending, 0 resolved, brier null', async () => {
    const idx = new VaultIndex(new FakeEmbedder(32), vaultPath);
    const client = await connect(createMcpServer({ index: idx }));
    const res = await client.callTool({ name: 'vaultnexus_forecasts', arguments: {} });
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text) as LedgerPayload;
    expect(parsed.pending.length).toBe(5);
    expect(parsed.resolved.length).toBe(0);
    expect(parsed.brier).toBeNull();
    // every pending defaults to probability 0.5 (no `probability:` field in fixture)
    for (const p of parsed.pending) expect(p.probability).toBe(0.5);
    await client.close();
  });

  it('temp vault w/ one resolved forecast → brier reflects single resolution', async () => {
    const extra = mkdtempSync(join(cleanupRoot, 'extra-'));
    writeFileSync(join(extra, 'r.md'), [
      '---',
      'forecast:',
      '  claim: "resolved fixture"',
      '  by: 2027-01-01',
      '  marked_at: 2024-01-01',
      '  probability: 0.9',
      'resolved:',
      '  outcome: true',
      '  resolved_at: 2024-12-31',
      '---',
      '',
      'body',
    ].join('\n'));
    const idx = new VaultIndex(new FakeEmbedder(32), extra);
    const client = await connect(createMcpServer({ index: idx }));
    const res = await client.callTool({ name: 'vaultnexus_forecasts', arguments: {} });
    const parsed = JSON.parse(
      (res.content as Array<{ type: string; text: string }>)[0].text,
    ) as LedgerPayload;
    expect(parsed.pending.length).toBe(0);
    expect(parsed.resolved.length).toBe(1);
    expect(parsed.resolved[0].outcome).toBe(true);
    expect(parsed.brier).toBeCloseTo(0.01, 10);
    await client.close();
  });
});
