import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Unix socket the daemon listens on / the bridge connects to. */
export function defaultSocketPath(): string {
  return process.env.VAULTNEXUS_SOCKET ?? join(tmpdir(), 'vaultnexus.sock');
}

/** Single-instance lock file. */
export function defaultLockPath(): string {
  return process.env.VAULTNEXUS_LOCK ?? join(tmpdir(), 'vaultnexus.lock');
}
