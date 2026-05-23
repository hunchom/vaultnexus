import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const sock = join(tmpdir(), `vn-main-${process.pid}.sock`);
const lock = join(tmpdir(), `vn-main-${process.pid}.lock`);
const port = '38473';
const env = { ...process.env, VAULTNEXUS_SOCKET: sock, VAULTNEXUS_LOCK: lock, VAULTNEXUS_HTTP_PORT: port };
let children: ChildProcess[] = [];

function startDaemon(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/daemon/main.ts'], { env });
  children.push(child);
  return new Promise((resolve, reject) => {
    let buf = '';
    child.stderr.on('data', (d: Buffer) => {
      buf += d.toString();
      if (buf.includes('VAULTNEXUS_READY')) resolve(child);
    });
    child.on('exit', (code) => reject(new Error(`daemon exited early: ${code}\n${buf}`)));
  });
}

afterEach(async () => {
  for (const c of children) c.kill('SIGTERM');
  children = [];
  await new Promise((r) => setTimeout(r, 200));
  for (const p of [sock, lock]) { try { rmSync(p); } catch { /* ignore */ } }
});

describe('daemon/main', () => {
  it('serves loopback /health once ready', async () => {
    await startDaemon();
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    expect((await res.json() as { status: string }).status).toBe('ok');
  });

  it('refuses a second instance (lock held)', async () => {
    await startDaemon();
    const second = spawn(process.execPath, ['--import', 'tsx', 'src/daemon/main.ts'], { env });
    children.push(second);
    const code = await new Promise<number | null>((r) => second.on('exit', r));
    expect(code).not.toBe(0);
  });
});
