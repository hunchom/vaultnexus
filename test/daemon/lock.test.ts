import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { acquireSingleInstanceLock, lockFailureMessage } from '../../src/daemon/lock.js';

const lockPath = join(tmpdir(), `vn-lock-test-${process.pid}.lock`);

afterEach(() => {
  try { rmSync(lockPath); } catch { /* ignore */ }
});

describe('acquireSingleInstanceLock', () => {
  it('grants the first holder and rejects a second', async () => {
    const release = await acquireSingleInstanceLock(lockPath);
    await expect(acquireSingleInstanceLock(lockPath)).rejects.toThrow();
    await release();
  });

  it('allows re-acquisition after release', async () => {
    const release1 = await acquireSingleInstanceLock(lockPath);
    await release1();
    const release2 = await acquireSingleInstanceLock(lockPath);
    await release2();
    expect(true).toBe(true);
  });

  it('accepts and forwards an onCompromised callback', async () => {
    // Verify the option is accepted without error and lock still works.
    const called: Error[] = [];
    const release = await acquireSingleInstanceLock(lockPath, (err) => called.push(err));
    await release();
    // callback not called during normal acquire+release
    expect(called).toHaveLength(0);
  });
});

describe('lockFailureMessage', () => {
  it('returns "already running" for ELOCKED', () => {
    const err = Object.assign(new Error('locked'), { code: 'ELOCKED' });
    expect(lockFailureMessage(err)).toContain('another daemon is already running');
  });

  it('returns "failed to acquire lock" for other errors', () => {
    const err = new Error('EACCES: permission denied');
    const msg = lockFailureMessage(err);
    expect(msg).toContain('failed to acquire lock');
    expect(msg).toContain('EACCES');
  });

  it('handles non-Error unknown values', () => {
    const msg = lockFailureMessage('something weird');
    expect(msg).toContain('failed to acquire lock');
    expect(msg).toContain('something weird');
  });
});
