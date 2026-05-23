import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSocketPath, defaultLockPath } from '../../src/core/paths.js';

const savedSock = process.env.VAULTNEXUS_SOCKET;
const savedLock = process.env.VAULTNEXUS_LOCK;

afterEach(() => {
  if (savedSock === undefined) delete process.env.VAULTNEXUS_SOCKET;
  else process.env.VAULTNEXUS_SOCKET = savedSock;
  if (savedLock === undefined) delete process.env.VAULTNEXUS_LOCK;
  else process.env.VAULTNEXUS_LOCK = savedLock;
});

describe('paths', () => {
  it('defaults to tmpdir when env unset', () => {
    delete process.env.VAULTNEXUS_SOCKET;
    delete process.env.VAULTNEXUS_LOCK;
    expect(defaultSocketPath()).toBe(join(tmpdir(), 'vaultnexus.sock'));
    expect(defaultLockPath()).toBe(join(tmpdir(), 'vaultnexus.lock'));
  });

  it('honors env overrides', () => {
    process.env.VAULTNEXUS_SOCKET = '/tmp/custom.sock';
    process.env.VAULTNEXUS_LOCK = '/tmp/custom.lock';
    expect(defaultSocketPath()).toBe('/tmp/custom.sock');
    expect(defaultLockPath()).toBe('/tmp/custom.lock');
  });
});
