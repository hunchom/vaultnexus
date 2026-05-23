import { existsSync, writeFileSync } from 'node:fs';
import * as lockfile from 'proper-lockfile';

/** Acquire single-instance lock. Rejects if another holder exists. Returns release fn. */
export async function acquireSingleInstanceLock(
  lockPath: string,
  onCompromised?: (err: Error) => void,
): Promise<() => Promise<void>> {
  if (!existsSync(lockPath)) writeFileSync(lockPath, '');
  return lockfile.lock(lockPath, {
    stale: 30_000,
    realpath: false,
    ...(onCompromised ? { onCompromised } : {}),
  });
}

/** Map a lock-acquisition error to a human-readable message. */
export function lockFailureMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err && err.code === 'ELOCKED') {
    return 'vaultnexus: another daemon is already running\n';
  }
  const msg = err instanceof Error ? err.message : String(err);
  return `vaultnexus: failed to acquire lock: ${msg}\n`;
}
