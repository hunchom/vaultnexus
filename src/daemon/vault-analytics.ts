// Vault-level analytics for cheap read tools. Heading outline, tags, recent mtimes, stats.
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { walkMarkdown } from './indexer.js';

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;
// m flag → ^ matches every line start, not just string start (Fix: review finding #4).
const TAG_RE = /(?:^|\s)#([A-Za-z0-9][\w/-]*)/gm;
const WIKILINK_RE = /\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g;

export interface OutlineNode { depth: number; text: string; byteOffset: number; }

/** Parse heading lines into a flat outline (depth + text + byte offset of `#` char). */
export function outlineFromSource(source: string): OutlineNode[] {
  const out: OutlineNode[] = [];
  // Detect line-ending width once → byte offsets stay accurate on CRLF (Fix: review finding #5).
  const lineEndingWidth = source.includes('\r\n') ? 2 : 1;
  const lines = source.split(/\r?\n/);
  let bytePos = 0;
  for (const line of lines) {
    const lineByteLen = Buffer.byteLength(line, 'utf8');
    const m = HEADING_RE.exec(line);
    if (m) out.push({ depth: m[1].length, text: m[2].trim(), byteOffset: bytePos });
    bytePos += lineByteLen + lineEndingWidth;
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

/** Outbound link counts per note → ranked. Most-linking notes first. */
export function linkCountsPerNote(noteLinks: Map<string, string[]>): Array<{ notePath: string; outbound: number }> {
  return [...noteLinks.entries()]
    .map(([notePath, links]) => ({ notePath, outbound: links.length }))
    .sort((a, b) => b.outbound - a.outbound);
}

/** Notes ranked by inbound wikilink count → highest first. */
export function inboundRanking(noteLinks: Map<string, string[]>): Array<{ notePath: string; inbound: number }> {
  const allNotes = [...noteLinks.keys()];
  const inboundOf = new Map<string, number>(allNotes.map((p) => [p, 0]));
  for (const [, targets] of noteLinks) {
    for (const t of targets) {
      const tLower = t.toLowerCase();
      const hit = allNotes.find((p) => {
        const base = p.replace(/\.md$/i, '').split('/').pop()?.toLowerCase();
        return base === tLower || p.toLowerCase() === `${tLower}.md` || p.toLowerCase() === tLower;
      });
      if (hit) inboundOf.set(hit, (inboundOf.get(hit) ?? 0) + 1);
    }
  }
  return [...inboundOf.entries()]
    .map(([notePath, inbound]) => ({ notePath, inbound }))
    .sort((a, b) => b.inbound - a.inbound);
}

/** Find note-title mentions in plain text that aren't wikilinked. Suggests upgrades. */
export async function unlinkedMentions(
  vaultDir: string,
  notePaths: string[],
  readSource: (abs: string) => Promise<string>,
  limit: number = 200,
): Promise<Array<{ from: string; mention: string; line: number; lineText: string }>> {
  const { walkMarkdown } = await import('./indexer.js');
  // Cap title length → defense-in-depth vs future paths where titles come from untrusted input.
  const titles = notePaths
    .map((p) => p.replace(/\.md$/i, '').split('/').pop() ?? '')
    .filter((t) => t && t.length <= 256);
  const titlesSet = new Set(titles.map((t) => t.toLowerCase()));
  const files = await walkMarkdown(vaultDir);
  const out: Array<{ from: string; mention: string; line: number; lineText: string }> = [];
  for (const abs of files) {
    const rel = abs.startsWith(vaultDir) ? abs.slice(vaultDir.length + 1) : abs;
    const src = await readSource(abs);
    const lines = src.split(/\r?\n/);
    // strip [[wikilinks]] + [markdown](links) + ```code``` from each line before scan
    for (let i = 0; i < lines.length; i += 1) {
      const stripped = lines[i]
        .replace(/```[\s\S]*?```/g, '')
        .replace(/\[\[[^\]]*\]\]/g, '')
        .replace(/\[[^\]]*\]\([^)]*\)/g, '');
      for (const title of titles) {
        if (title.length < 4) continue;
        const re = new RegExp(`\\b${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
        if (re.test(stripped)) {
          out.push({ from: rel, mention: title, line: i + 1, lineText: lines[i].slice(0, 200) });
          if (out.length >= limit) return out;
        }
      }
    }
  }
  return out;
}

/** Notes that contain a specific #tag (case-insensitive). Returns relative paths. */
export async function notesByTag(
  vaultDir: string,
  tag: string,
  readSource: (abs: string) => Promise<string>,
): Promise<string[]> {
  const files = await walkMarkdown(vaultDir);
  const target = tag.replace(/^#/, '').toLowerCase();
  const out: string[] = [];
  for (const abs of files) {
    const src = (await readSource(abs)).toLowerCase();
    if (src.includes(`#${target}`)) {
      // Avoid #tag-substring collisions w/ hashtags inside #longertag — keep it strict.
      for (const m of src.matchAll(TAG_RE)) {
        if (m[1].toLowerCase() === target) {
          out.push(abs.startsWith(vaultDir) ? abs.slice(vaultDir.length + 1) : abs);
          break;
        }
      }
    }
  }
  return out.sort();
}

/** Find wikilink targets that don't resolve to any vault note. Returns [{from, target}]. */
export function brokenLinks(noteLinks: Map<string, string[]>): Array<{ from: string; target: string }> {
  const allNotes = [...noteLinks.keys()];
  const baseNames = new Set(allNotes.map((p) => p.replace(/\.md$/i, '').split('/').pop()?.toLowerCase() ?? ''));
  const fullPaths = new Set(allNotes.map((p) => p.toLowerCase()));
  const out: Array<{ from: string; target: string }> = [];
  for (const [from, targets] of noteLinks) {
    for (const t of targets) {
      const tLower = t.toLowerCase();
      const ok = baseNames.has(tLower) || fullPaths.has(tLower) || fullPaths.has(`${tLower}.md`);
      if (!ok) out.push({ from, target: t });
    }
  }
  return out;
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
