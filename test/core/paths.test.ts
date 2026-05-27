import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSocketPath, defaultLockPath, defaultIndexSnapshotPath } from '../../src/core/paths.js';
import { homedir } from 'node:os';

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

  it('defaultIndexSnapshotPath defaults under ~/.vaultnexus + honors env override', () => {
    expect(defaultIndexSnapshotPath({})).toBe(join(homedir(), '.vaultnexus', 'index-snapshot.db'));
    expect(defaultIndexSnapshotPath({ VAULTNEXUS_INDEX_SNAPSHOT: '/tmp/snap.db' })).toBe('/tmp/snap.db');
    expect(defaultIndexSnapshotPath({ VAULTNEXUS_INDEX_SNAPSHOT: 'off' })).toBe('off');
  });
});
