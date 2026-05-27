import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { relative } from 'node:path';
import type { Embedder } from '../core/embedder.js';
import type { ChatModel } from '../core/chat-model.js';
import { VaultIndex } from './vault-index.js';
import type { IndexSnapshot } from './index-snapshot.js';
import { walkMarkdown } from './indexer.js';

export interface RestoreStats {
  total: number;
  restored: number; // loaded from snapshot, no chunk/embed
  rebuilt: number;  // changed or new → re-chunked + re-embedded
  pruned: number;   // snapshot rows for missing files → dropped
}

export interface RestoreResult { index: VaultIndex; stats: RestoreStats; }

const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

/**
 * Plan 26 — build a VaultIndex over `vaultDir` reusing the snapshot for unchanged notes.
 * Changed/new notes re-chunk + re-embed (embedding cache from Plan 11 still applies to identical blocks).
 * Deleted notes are pruned from the snapshot. Snapshot stays in sync via VaultIndex.attachSnapshot.
 */
export async function restoreOrRebuildIndex(
  vaultDir: string,
  embedder: Embedder,
  snapshot: IndexSnapshot,
  chatModel?: ChatModel,
): Promise<RestoreResult> {
  const index = new VaultIndex(embedder, vaultDir, chatModel);
  index.attachSnapshot(snapshot);

  const files = await walkMarkdown(vaultDir);
  const seen = new Set<string>(); // notePaths present on disk
  const stats: RestoreStats = { total: 0, restored: 0, rebuilt: 0, pruned: 0 };

  for (const abs of files) {
    const notePath = relative(vaultDir, abs);
    seen.add(notePath);
    stats.total += 1;
    const buf = await readFile(abs);
    const contentSha = sha256(buf);
    const st = await stat(abs);
    const mtimeMs = Math.floor(st.mtimeMs);
    const prior = snapshot.getNote(notePath);
    if (prior && prior.contentSha === contentSha) {
      // unchanged → load from snapshot (no re-chunk, no re-embed)
      const chunks = snapshot.getChunks(notePath);
      index.restoreNote(notePath, buf.toString('utf8'), chunks);
      stats.restored += 1;
      // mtime drift on unchanged content → refresh meta (cheap)
      if (prior.mtimeMs !== mtimeMs) snapshot.setNote(notePath, contentSha, mtimeMs);
    } else {
      // changed or new → re-chunk + re-embed → addNote writes through to snapshot
      await index.addNote(notePath, buf.toString('utf8'), { contentSha, mtimeMs });
      stats.rebuilt += 1;
    }
  }

  // prune snapshot rows for files no longer present
  for (const stale of snapshot.listNotes()) {
    if (!seen.has(stale)) {
      snapshot.deleteNote(stale);
      stats.pruned += 1;
    }
  }

  return { index, stats };
}
