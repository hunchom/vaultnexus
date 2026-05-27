import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createMcpServer } from '../../src/daemon/mcp-server.js';
import { VaultIndex } from '../../src/daemon/vault-index.js';
import { FakeEmbedder } from '../../src/core/embedder.js';
import { FakeChatModel } from '../../src/core/fake-chat-model.js';
import { seedDemoVault } from '../../scripts/seed-demo-vault.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');

async function connect(server: ReturnType<typeof createMcpServer>): Promise<Client> {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const c = new Client({ name: 't', version: '0' });
  await c.connect(ct);
  return c;
}

function listVaultNotes(vaultPath: string): string[] {
  const out = execFileSync('git', ['-C', vaultPath, 'ls-files', 'notes'], { encoding: 'utf8' });
  return out.split('\n').filter((l) => l.endsWith('.md'));
}

async function buildSeededIndex(vaultPath: string): Promise<VaultIndex> {
  const idx = new VaultIndex(new FakeEmbedder(64), vaultPath, new FakeChatModel());
  for (const rel of listVaultNotes(vaultPath)) {
    const abs = join(vaultPath, rel);
    if (existsSync(abs)) await idx.addNote(rel, readFileSync(abs, 'utf8'));
  }
  return idx;
}

describe('vaultnexus_recall_history MCP tool', () => {
  let vaultPath: string;
  let cleanupRoot: string;

  beforeAll(() => {
    cleanupRoot = mkdtempSync(join(tmpdir(), 'vn-mcp-recall-'));
    vaultPath = join(cleanupRoot, 'vault');
    seedDemoVault(vaultPath);
  });
  afterAll(() => { rmSync(cleanupRoot, { recursive: true, force: true }); });

  it('absent without an index; present with one', async () => {
    const noIdx = await connect(createMcpServer());
    expect((await noIdx.listTools()).tools.map((t) => t.name)).not.toContain(
      'vaultnexus_recall_history',
    );
    await noIdx.close();

    const idx = await buildSeededIndex(vaultPath);
    const client = await connect(createMcpServer({ index: idx }));
    expect((await client.listTools()).tools.map((t) => t.name)).toContain(
      'vaultnexus_recall_history',
    );
    await client.close();
  });

  it('returns { narration, revisions, model } for a multi-rev note', async () => {
    const idx = await buildSeededIndex(vaultPath);
    const client = await connect(createMcpServer({ index: idx }));
    const res = await client.callTool({
      name: 'vaultnexus_recall_history',
      arguments: { notePath: 'notes/productivity/gtd-effectiveness.md' },
    });
    const parsed = JSON.parse((res.content as Array<{ type: string; text: string }>)[0].text);
    expect(typeof parsed.narration).toBe('string');
    expect(Array.isArray(parsed.revisions)).toBe(true);
    expect(parsed.revisions.length).toBe(3);
    expect(parsed.model).toBe('fake');
    expect(parsed.narration).toContain('[fake-compose]');
    await client.close();
  });

  it('single-rev note → fallback narration + model still reported', async () => {
    const idx = await buildSeededIndex(vaultPath);
    const client = await connect(createMcpServer({ index: idx }));
    const res = await client.callTool({
      name: 'vaultnexus_recall_history',
      arguments: { notePath: 'notes/productivity/gtd-overview.md' },
    });
    const parsed = JSON.parse((res.content as Array<{ type: string; text: string }>)[0].text);
    expect(parsed.model).toBe('fake');
    expect(parsed.revisions.length).toBe(1);
    expect(parsed.narration.startsWith('Note has fewer than two')).toBe(true);
    await client.close();
  });
});
