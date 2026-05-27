import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

/** Unix socket the daemon listens on / the bridge connects to. */
export function defaultSocketPath(): string {
  return process.env.VAULTNEXUS_SOCKET ?? join(tmpdir(), 'vaultnexus.sock');
}

/** Single-instance lock file. */
export function defaultLockPath(): string {
  return process.env.VAULTNEXUS_LOCK ?? join(tmpdir(), 'vaultnexus.lock');
}

/** Persistent embedding cache DB (survives reboot, unlike tmpdir). 'off' disables. */
export function defaultCachePath(env: Record<string, string | undefined> = process.env): string {
  return env.VAULTNEXUS_CACHE ?? join(homedir(), '.vaultnexus', 'embeddings.db');
}

/** On-disk VaultIndex snapshot (chunks + f32 vecs + note meta). 'off' disables. */
export function defaultIndexSnapshotPath(env: Record<string, string | undefined> = process.env): string {
  return env.VAULTNEXUS_INDEX_SNAPSHOT ?? join(homedir(), '.vaultnexus', 'index-snapshot.db');
}
