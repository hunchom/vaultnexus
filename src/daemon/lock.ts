import { existsSync, writeFileSync } from 'node:fs';
import * as lockfile from 'proper-lockfile';

/** Acquire single-instance lock. Rejects if another holder exists. Returns release fn. */
export async function acquireSingleInstanceLock(lockPath: string): Promise<() => Promise<void>> {
  if (!existsSync(lockPath)) writeFileSync(lockPath, '');
  return lockfile.lock(lockPath, { stale: 30_000, realpath: false });
}
