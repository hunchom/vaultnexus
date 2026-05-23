import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const sock = join(tmpdir(), `vn-vault-e2e-${process.pid}.sock`);
const lock = join(tmpdir(), `vn-vault-e2e-${process.pid}.lock`);
let daemon: ChildProcess | undefined; let vault: string;

beforeEach(async () => {
  vault = await mkdtemp(join(tmpdir(), 'vn-e2e-vault-'));
  await writeFile(join(vault, 'fox.md'), '# Animals\n\nthe quick brown fox jumps\n');
  await writeFile(join(vault, 'sea.md'), '# Ocean\n\nblue whales sing deep songs\n');
  const env = { ...process.env, VAULTNEXUS_SOCKET: sock, VAULTNEXUS_LOCK: lock, VAULTNEXUS_HTTP_PORT: '38475', VAULTNEXUS_VAULT: vault };
  daemon = spawn(process.execPath, ['--import', 'tsx', 'src/daemon/main.ts'], { env });
  await new Promise<void>((resolve, reject) => {
    let buf = '';
    daemon!.stderr!.on('data', (d: Buffer) => { buf += d.toString(); if (buf.includes('VAULTNEXUS_READY')) resolve(); });
    daemon!.on('exit', (c) => reject(new Error(`daemon exited: ${c}\n${buf}`)));
  });
});
afterEach(async () => {
  daemon?.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 200));
  for (const p of [sock, lock]) { try { rmSync(p); } catch { /* ignore */ } }
  await rm(vault, { recursive: true, force: true });
});

describe('vault e2e: search a real directory through the bridge', () => {
  it('returns a cited hit from the matching note', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath, args: ['--import', 'tsx', 'src/bridge/main.ts'],
      env: { PATH: process.env.PATH ?? '', VAULTNEXUS_SOCKET: sock },
    });
    const client = new Client({ name: 'e2e', version: '0' });
    await client.connect(transport);
    const res = await client.callTool({ name: 'vaultnexus_search', arguments: { query: 'the quick brown fox jumps', k: 2 } });
    const hits = JSON.parse((res.content as Array<{ type: string; text: string }>)[0].text);
    expect(hits[0].notePath).toBe('fox.md');
    expect(hits[0].text).toContain('quick brown fox');
    await client.close();
  });
});
