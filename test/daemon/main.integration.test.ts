import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { mkdtemp, writeFile as writeFileAsync, rm } from 'node:fs/promises';

const sock = join(tmpdir(), `vn-main-${process.pid}.sock`);
const lock = join(tmpdir(), `vn-main-${process.pid}.lock`);
const port = '38473';
const env = { ...process.env, VAULTNEXUS_SOCKET: sock, VAULTNEXUS_LOCK: lock, VAULTNEXUS_HTTP_PORT: port };
let children: ChildProcess[] = [];
const ephemeralPaths: string[] = [];

interface StartOpts { extraEnv?: Record<string, string>; captureStderr?: boolean; }
function startDaemon(opts: StartOpts = {}): Promise<{ child: ChildProcess; stderr: () => string }> {
  const mergedEnv = { ...env, ...(opts.extraEnv ?? {}) };
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/daemon/main.ts'], { env: mergedEnv });
  children.push(child);
  let buf = '';
  child.stderr.on('data', (d: Buffer) => { buf += d.toString(); });
  return new Promise((resolve, reject) => {
    const onReady = (): void => {
      if (buf.includes('VAULTNEXUS_READY')) {
        child.stderr.off('data', onData);
        resolve({ child, stderr: () => buf });
      }
    };
    const onData = (): void => onReady();
    child.stderr.on('data', onData);
    child.on('exit', (code) => reject(new Error(`daemon exited early: ${code}\n${buf}`)));
  });
}

afterEach(async () => {
  for (const c of children) c.kill('SIGTERM');
  children = [];
  await new Promise((r) => setTimeout(r, 250));
  for (const p of [sock, lock, ...ephemeralPaths]) {
    try { rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  ephemeralPaths.length = 0;
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

  it('corrupted snapshot file → recovers (unlinks + rebuilds), no crash on startup', async () => {
    // pre-seed snapPath with garbage bytes → SQLite open will throw SQLITE_NOTADB.
    // expected: daemon logs "snapshot open failed", unlinks, rebuilds fresh, reaches READY.
    const vault = await mkdtemp(join(tmpdir(), 'vn-corrupt-vault-'));
    await writeFileAsync(join(vault, 'note.md'), '# Note\n\nrecovery test content\n');
    const snapDir = mkdtempSync(join(tmpdir(), 'vn-corrupt-snap-'));
    const snapPath = join(snapDir, 'index-snapshot.db');
    writeFileSync(snapPath, 'not a sqlite database — pure garbage bytes\x00\x01\x02');
    ephemeralPaths.push(vault, snapDir);

    const { stderr } = await startDaemon({
      extraEnv: { VAULTNEXUS_VAULT: vault, VAULTNEXUS_INDEX_SNAPSHOT: snapPath },
    });
    // sanity → daemon serves /health (alive) and recovery log line landed on stderr
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    // give stderr a tick to flush
    await new Promise((r) => setTimeout(r, 50));
    const log = stderr();
    expect(log).toMatch(/snapshot open failed/);
    expect(log).toMatch(/indexed 1 notes/); // post-recovery indexer ran
  });

  it('VAULTNEXUS_INDEX_SNAPSHOT=off → snapshot file is NOT created, plain indexVault runs', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'vn-snapoff-vault-'));
    await writeFileAsync(join(vault, 'note.md'), '# Note\n\nsnapshot-off test\n');
    const snapDir = mkdtempSync(join(tmpdir(), 'vn-snapoff-snap-'));
    const wouldBeSnap = join(snapDir, 'index-snapshot.db');
    ephemeralPaths.push(vault, snapDir);

    const { stderr } = await startDaemon({
      extraEnv: { VAULTNEXUS_VAULT: vault, VAULTNEXUS_INDEX_SNAPSHOT: 'off' },
    });
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    // primary assertion → no snapshot file anywhere we pointed at
    expect(existsSync(wouldBeSnap)).toBe(false);
    // secondary → stderr shows the plain indexVault path (no "restored=/rebuilt=" stats line)
    const log = stderr();
    expect(log).toMatch(/indexed 1 notes from /);
    expect(log).not.toMatch(/restored=\d+ rebuilt=/);
  });
});
