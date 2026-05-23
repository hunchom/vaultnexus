import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { health } from '../../src/core/health.js';

const sock = join(tmpdir(), `vn-e2e-${process.pid}.sock`);
const lock = join(tmpdir(), `vn-e2e-${process.pid}.lock`);
let daemon: ChildProcess | undefined;

beforeEach(async () => {
  const env = { ...process.env, VAULTNEXUS_SOCKET: sock, VAULTNEXUS_LOCK: lock, VAULTNEXUS_HTTP_PORT: '38474' };
  daemon = spawn(process.execPath, ['--import', 'tsx', 'src/daemon/main.ts'], { env });
  await new Promise<void>((resolve, reject) => {
    let buf = '';
    daemon!.stderr!.on('data', (d: Buffer) => {
      buf += d.toString();
      if (buf.includes('VAULTNEXUS_READY')) resolve();
    });
    daemon!.on('exit', (c) => reject(new Error(`daemon exited: ${c}\n${buf}`)));
  });
});

afterEach(async () => {
  daemon?.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 200));
  for (const p of [sock, lock]) { try { rmSync(p); } catch { /* ignore */ } }
});

describe('end-to-end: Claude Code -> bridge -> daemon', () => {
  it('lists and calls vaultnexus_ping through the bridge', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', 'src/bridge/main.ts'],
      env: { PATH: process.env.PATH ?? '', VAULTNEXUS_SOCKET: sock },
    });
    const client = new Client({ name: 'e2e', version: '0.0.0' });
    await client.connect(transport);

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain('vaultnexus_ping');

    const result = await client.callTool({ name: 'vaultnexus_ping', arguments: {} });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(JSON.parse(text)).toEqual(health());

    await client.close();
  });
});
