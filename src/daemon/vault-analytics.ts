// Vault-level analytics for cheap read tools. Heading outline, tags, recent mtimes, stats.
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { walkMarkdown } from './indexer.js';

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;
const TAG_RE = /(?:^|\s)#([A-Za-z0-9][\w/-]*)/g;
const WIKILINK_RE = /\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g;

export interface OutlineNode { depth: number; text: string; byteOffset: number; }

/** Parse heading lines into a flat outline (depth + text + byte offset of `#` char). */
export function outlineFromSource(source: string): OutlineNode[] {
  const out: OutlineNode[] = [];
  const lines = source.split(/\r?\n/);
  let bytePos = 0;
  for (const line of lines) {
    const lineByteLen = Buffer.byteLength(line, 'utf8');
    const m = HEADING_RE.exec(line);
    if (m) out.push({ depth: m[1].length, text: m[2].trim(), byteOffset: bytePos });
    bytePos += lineByteLen + 1; // +1 for the LF (CRLF would shift by 2 but rare in vaults)
  }
  return out;
}

/** Count #tags across the vault. Returns sorted by count desc, ties by name asc. */
export async function tagCounts(vaultDir: string, readSource: (abs: string) => Promise<string>): Promise<Array<{ tag: string; count: number }>> {
  const files = await walkMarkdown(vaultDir);
  const counts = new Map<string, number>();
  for (const abs of files) {
    const src = await readSource(abs);
    for (const m of src.matchAll(TAG_RE)) {
      counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => (b.count - a.count) || a.tag.localeCompare(b.tag));
}

/** Most-recently-modified notes. Returns relative paths + mtime ms. */
export async function recentNotes(vaultDir: string, limit = 20): Promise<Array<{ notePath: string; mtimeMs: number }>> {
  const files = await walkMarkdown(vaultDir);
  const stats = await Promise.all(files.map(async (abs) => {
    const s = await stat(abs);
    return { abs, mtimeMs: s.mtimeMs };
  }));
  stats.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return stats.slice(0, limit).map(({ abs, mtimeMs }) => ({
    notePath: abs.startsWith(vaultDir) ? abs.slice(vaultDir.length + 1) : abs,
    mtimeMs,
  }));
}

/** Vault summary stats: note count, total bytes, total chunks (from index), avg chunk size. */
export interface VaultStats {
  notes: number;
  bytes: number;
  chunks: number;
  avgChunkBytes: number;
  embedder?: string;
  chatModel?: string;
}

/** Notes w/ NO inbound wikilinks from any other note (vault-internal islands). */
export function orphanNotes(noteLinks: Map<string, string[]>): string[] {
  const allNotes = [...noteLinks.keys()];
  const inbound = new Set<string>();
  for (const [, targets] of noteLinks) {
    for (const t of targets) {
      // Resolve bare wikilink target → match against notePaths (case-insensitive base name).
      const tLower = t.toLowerCase();
      const hit = allNotes.find((p) => {
        const base = p.replace(/\.md$/i, '').split('/').pop()?.toLowerCase();
        return base === tLower || p.toLowerCase() === `${tLower}.md` || p.toLowerCase() === tLower;
      });
      if (hit) inbound.add(hit);
    }
  }
  return allNotes.filter((p) => !inbound.has(p)).sort();
}

/** Outbound + inbound wikilink summaries for a single note. */
export function linkGraph(noteLinks: Map<string, string[]>, notePath: string): { outbound: string[]; inbound: string[] } {
  const outbound = noteLinks.get(notePath) ?? [];
  const inbound: string[] = [];
  const baseName = notePath.replace(/\.md$/i, '').split('/').pop()?.toLowerCase() ?? '';
  for (const [from, targets] of noteLinks) {
    if (from === notePath) continue;
    if (targets.some((t) => t.toLowerCase() === baseName || t.toLowerCase() === notePath.toLowerCase())) {
      inbound.push(from);
    }
  }
  return { outbound, inbound: inbound.sort() };
}
