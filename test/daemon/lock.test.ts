import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { acquireSingleInstanceLock } from '../../src/daemon/lock.js';

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
});
