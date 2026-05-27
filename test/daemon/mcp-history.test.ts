import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createMcpServer } from '../../src/daemon/mcp-server.js';
import { VaultIndex } from '../../src/daemon/vault-index.js';
import { FakeEmbedder } from '../../src/core/embedder.js';

// Seed a single-commit repo touching notes/a.md.
function seedRepo(): { repo: string; cleanup: () => void } {
  const repo = mkdtempSync(join(tmpdir(), 'vn-mcp-hist-'));
  execFileSync('git', ['init', '--initial-branch=main', repo]);
  mkdirSync(join(repo, 'notes'));
  writeFileSync(join(repo, 'notes/a.md'), '# A\nbody\n');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync(
    'git',
    ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-m', 'c1'],
    { env: { ...process.env, GIT_AUTHOR_DATE: '2024-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2024-01-01T00:00:00Z' } },
  );
  return { repo, cleanup: () => rmSync(repo, { recursive: true, force: true }) };
}

async function connect(server: ReturnType<typeof createMcpServer>): Promise<Client> {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const c = new Client({ name: 't', version: '0' });
  await c.connect(ct);
  return c;
}

describe('vaultnexus_history MCP tool', () => {
  let fx: { repo: string; cleanup: () => void };
  beforeAll(() => { fx = seedRepo(); });
  afterAll(() => { fx.cleanup(); });

  it('absent without an index; present with one', async () => {
    const noIdxClient = await connect(createMcpServer());
    expect((await noIdxClient.listTools()).tools.map((t) => t.name))
      .not.toContain('vaultnexus_history');
    await noIdxClient.close();

    const idx = new VaultIndex(new FakeEmbedder(32), fx.repo);
    await idx.addNote('notes/a.md', '# A\nbody\n');
    const client = await connect(createMcpServer({ index: idx }));
    expect((await client.listTools()).tools.map((t) => t.name))
      .toContain('vaultnexus_history');
    await client.close();
  });

  it('returns Revision[] for an indexed note', async () => {
    const idx = new VaultIndex(new FakeEmbedder(32), fx.repo);
    await idx.addNote('notes/a.md', '# A\nbody\n');
    const client = await connect(createMcpServer({ index: idx }));
    const res = await client.callTool({
      name: 'vaultnexus_history',
      arguments: { notePath: 'notes/a.md' },
    });
    const parsed = JSON.parse((res.content as Array<{ type: string; text: string }>)[0].text);
    expect(Array.isArray(parsed.revisions)).toBe(true);
    expect(parsed.revisions.length).toBeGreaterThan(0);
    const r = parsed.revisions[0];
    expect(r.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(typeof r.commitDate).toBe('string');
    expect(typeof r.message).toBe('string');
    expect(typeof r.authorEmail).toBe('string');
    await client.close();
  });
});
