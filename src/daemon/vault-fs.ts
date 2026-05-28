// Filesystem ops scoped to a vault root. Every public fn re-resolves the input
// under vaultDir + asserts no escape → no path traversal via .. or absolute paths.
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve, dirname, extname, sep } from 'node:path';

export class VaultFsError extends Error {
  constructor(message: string, public readonly code: 'ENOTFOUND' | 'EEXISTS' | 'EESCAPE' | 'EBAD' | 'EFAIL') {
    super(message);
    this.name = 'VaultFsError';
  }
}

function safeJoin(vaultDir: string, p: string): string {
  if (typeof p !== 'string') throw new VaultFsError('path required', 'EBAD');
  // Reject NUL bytes outright → some OS calls truncate at NUL → tricky traversal.
  if (p.includes('\0')) throw new VaultFsError(`path contains NUL`, 'EBAD');
  const norm = p.replace(/^\/+/, '');                 // strip leading / → vault-relative
  const abs = resolve(vaultDir, norm);
  const rel = relative(vaultDir, abs);
  if (rel.startsWith('..') || rel === '..' || rel.split(sep).includes('..')) {
    throw new VaultFsError(`path escapes vault: ${p}`, 'EESCAPE');
  }
  return abs;
}

// Resolve any symlinks at the final path. If the realpath escapes the vault → reject.
// Called on every read/write/delete after safeJoin → defense vs symlink-into-/etc/passwd.
async function safeRealpath(vaultDir: string, abs: string): Promise<string> {
  try {
    const real = await realpath(abs);
    const realVault = await realpath(vaultDir).catch(() => vaultDir);
    const rel = relative(realVault, real);
    if (rel.startsWith('..') || rel === '..' || rel.split(sep).includes('..')) {
      throw new VaultFsError(`symlink escapes vault: ${abs}`, 'EESCAPE');
    }
    return real;
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return abs; // doesn't exist yet (createPage)
    if ((e as VaultFsError).code === 'EESCAPE') throw e;
    return abs; // realpath failure on a still-resolvable parent → fall through (write tools handle ENOENT)
  }
}

export interface DirEntry { name: string; path: string; kind: 'note' | 'folder' | 'other'; }
export interface VaultListing {
  cwd: string;
  folders: string[];
  notes: string[];
}

/** List contents of a folder (relative to vault root). Skips dotfiles/dotdirs. */
export async function listFolder(vaultDir: string, p: string = ''): Promise<VaultListing> {
  const abs = await safeRealpath(vaultDir, safeJoin(vaultDir, p));
  let entries;
  try { entries = await readdir(abs, { withFileTypes: true }); }
  catch (e) { throw new VaultFsError(`folder not found: ${p}`, 'ENOTFOUND'); }
  const folders: string[] = [];
  const notes: string[] = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (e.isDirectory()) folders.push(e.name);
    else if (e.isFile() && extname(e.name).toLowerCase() === '.md') notes.push(e.name);
  }
  folders.sort(); notes.sort();
  return { cwd: p, folders, notes };
}

/** Read a note's full content. Optional byte slice (inclusive start, exclusive end). */
export async function readPage(
  vaultDir: string,
  notePath: string,
  opts: { byteStart?: number; byteEnd?: number } = {},
): Promise<{ notePath: string; bytes: number; text: string }> {
  const abs = await safeRealpath(vaultDir, safeJoin(vaultDir, notePath));
  let buf;
  try { buf = await readFile(abs); }
  catch { throw new VaultFsError(`note not found: ${notePath}`, 'ENOTFOUND'); }
  const slice = (opts.byteStart != null || opts.byteEnd != null)
    ? buf.subarray(opts.byteStart ?? 0, opts.byteEnd ?? buf.length)
    : buf;
  return { notePath, bytes: buf.length, text: slice.toString('utf8') };
}

/** Create a new note. Fails if a file already exists unless overwrite=true. mkdir -p parents. */
export async function createPage(
  vaultDir: string, notePath: string, content: string, opts: { overwrite?: boolean } = {},
): Promise<{ notePath: string; bytes: number }> {
  if (!notePath.toLowerCase().endsWith('.md')) {
    throw new VaultFsError('notePath must end with .md', 'EBAD');
  }
  const abs = await safeRealpath(vaultDir, safeJoin(vaultDir, notePath));
  if (!opts.overwrite) {
    try { await stat(abs); throw new VaultFsError(`note exists: ${notePath}`, 'EEXISTS'); }
    catch (e) { if ((e as VaultFsError).code === 'EEXISTS') throw e; /* otherwise ENOENT → ok */ }
  }
  await mkdir(dirname(abs), { recursive: true });
  const data = Buffer.from(content, 'utf8');
  await writeFile(abs, data);
  return { notePath, bytes: data.length };
}

/** mkdir -p under vault. */
export async function createFolder(vaultDir: string, folderPath: string): Promise<{ folderPath: string }> {
  const abs = await safeRealpath(vaultDir, safeJoin(vaultDir, folderPath));
  await mkdir(abs, { recursive: true });
  return { folderPath };
}

/** Append text to an existing note. Returns new size. */
export async function appendToPage(
  vaultDir: string, notePath: string, text: string,
): Promise<{ notePath: string; bytes: number; appended: number }> {
  const abs = await safeRealpath(vaultDir, safeJoin(vaultDir, notePath));
  let cur;
  try { cur = await readFile(abs); }
  catch { throw new VaultFsError(`note not found: ${notePath}`, 'ENOTFOUND'); }
  const add = Buffer.from(text, 'utf8');
  const next = Buffer.concat([cur, add]);
  await writeFile(abs, next);
  return { notePath, bytes: next.length, appended: add.length };
}

/** Insert text after the first heading line that matches headingText (exact). Heading line included; insert follows. */
export async function insertAfterHeading(
  vaultDir: string, notePath: string, headingText: string, insertion: string,
): Promise<{ notePath: string; bytes: number; insertedAtByte: number }> {
  const abs = await safeRealpath(vaultDir, safeJoin(vaultDir, notePath));
  let raw;
  try { raw = (await readFile(abs)).toString('utf8'); }
  catch { throw new VaultFsError(`note not found: ${notePath}`, 'ENOTFOUND'); }
  const lines = raw.split(/\r?\n/);
  let idx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^#{1,6}\s+(.+?)\s*$/.exec(lines[i]);
    if (m && m[1].trim() === headingText.trim()) { idx = i; break; }
  }
  if (idx < 0) throw new VaultFsError(`heading not found: ${headingText}`, 'ENOTFOUND');
  const pre = lines.slice(0, idx + 1).join('\n');
  const post = lines.slice(idx + 1).join('\n');
  // Always sandwich a blank line before + after the insertion → preserves block boundaries.
  const next = pre + '\n\n' + insertion.trimEnd() + '\n' + (post.length ? '\n' + post : '');
  const buf = Buffer.from(next, 'utf8');
  await writeFile(abs, buf);
  // After pre + '\n\n' the inserted content starts at byteLen(pre)+2 (Fix: review finding #2).
  return { notePath, bytes: buf.length, insertedAtByte: Buffer.byteLength(pre, 'utf8') + 2 };
}

/** Replace first or all occurrences of literal `find` with `replace`. */
export async function replaceInPage(
  vaultDir: string, notePath: string, find: string, replace: string, opts: { all?: boolean } = {},
): Promise<{ notePath: string; replacements: number; bytes: number }> {
  const abs = await safeRealpath(vaultDir, safeJoin(vaultDir, notePath));
  let raw;
  try { raw = (await readFile(abs)).toString('utf8'); }
  catch { throw new VaultFsError(`note not found: ${notePath}`, 'ENOTFOUND'); }
  let count = 0;
  let next: string;
  if (opts.all) {
    const parts = raw.split(find);
    count = parts.length - 1;
    next = parts.join(replace);
  } else {
    const i = raw.indexOf(find);
    if (i < 0) { count = 0; next = raw; }
    else { count = 1; next = raw.slice(0, i) + replace + raw.slice(i + find.length); }
  }
  const buf = Buffer.from(next, 'utf8');
  if (count > 0) await writeFile(abs, buf);
  return { notePath, replacements: count, bytes: buf.length };
}

/** Soft-delete: move into <vault>/.trash/<timestamp>/<originalPath>. */
export async function deletePage(
  vaultDir: string, notePath: string,
): Promise<{ notePath: string; trashedAt: string }> {
  const abs = await safeRealpath(vaultDir, safeJoin(vaultDir, notePath));
  try { await stat(abs); }
  catch { throw new VaultFsError(`note not found: ${notePath}`, 'ENOTFOUND'); }
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = safeJoin(vaultDir, join('.trash', ts, notePath));
  await mkdir(dirname(dest), { recursive: true });
  await rename(abs, dest);
  return { notePath, trashedAt: relative(vaultDir, dest) };
}

/** Delete folder. Refuses if non-empty unless force=true (then recursive). Goes to .trash. */
export async function deleteFolder(
  vaultDir: string, folderPath: string, opts: { force?: boolean } = {},
): Promise<{ folderPath: string; trashedAt: string }> {
  const abs = await safeRealpath(vaultDir, safeJoin(vaultDir, folderPath));
  let entries;
  try { entries = await readdir(abs); }
  catch { throw new VaultFsError(`folder not found: ${folderPath}`, 'ENOTFOUND'); }
  if (entries.filter((e) => !e.startsWith('.')).length > 0 && !opts.force) {
    throw new VaultFsError(`folder not empty: ${folderPath} (pass force=true)`, 'EBAD');
  }
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = safeJoin(vaultDir, join('.trash', ts, folderPath));
  await mkdir(dirname(dest), { recursive: true });
  await rename(abs, dest);
  return { folderPath, trashedAt: relative(vaultDir, dest) };
}

/** Rename/move a note or folder within the vault. */
export async function renamePath(
  vaultDir: string, from: string, to: string,
): Promise<{ from: string; to: string }> {
  const absFrom = await safeRealpath(vaultDir, safeJoin(vaultDir, from));
  const absTo = await safeRealpath(vaultDir, safeJoin(vaultDir, to));
  try { await stat(absFrom); }
  catch { throw new VaultFsError(`source not found: ${from}`, 'ENOTFOUND'); }
  try { await stat(absTo); throw new VaultFsError(`destination exists: ${to}`, 'EEXISTS'); }
  catch (e) { if ((e as VaultFsError).code === 'EEXISTS') throw e; /* ENOENT → ok */ }
  await mkdir(dirname(absTo), { recursive: true });
  await rename(absFrom, absTo);
  return { from, to };
}

/** Fetch a sub-slice of a note by selector: heading text, block-id line, frontmatter, or outline. */
export async function getPartial(
  vaultDir: string,
  notePath: string,
  selector: { kind: 'heading'; text: string } | { kind: 'frontmatter' } | { kind: 'outline' },
): Promise<{ notePath: string; kind: string; text: string }> {
  const abs = await safeRealpath(vaultDir, safeJoin(vaultDir, notePath));
  let raw;
  try { raw = (await readFile(abs)).toString('utf8'); }
  catch { throw new VaultFsError(`note not found: ${notePath}`, 'ENOTFOUND'); }
  if (selector.kind === 'frontmatter') {
    const m = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
    return { notePath, kind: 'frontmatter', text: m ? m[1] : '' };
  }
  if (selector.kind === 'outline') {
    const lines = raw.split(/\r?\n/);
    const headings = lines
      .map((l) => /^(#{1,6})\s+(.+?)\s*$/.exec(l))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => `${m[1]} ${m[2]}`);
    return { notePath, kind: 'outline', text: headings.join('\n') };
  }
  // heading section: from matching heading to next heading at same-or-shallower depth (or EOF)
  const lines = raw.split(/\r?\n/);
  let startLine = -1;
  let startDepth = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[i]);
    if (m && m[2].trim() === selector.text.trim()) {
      startLine = i;
      startDepth = m[1].length;
      break;
    }
  }
  if (startLine < 0) throw new VaultFsError(`heading not found: ${selector.text}`, 'ENOTFOUND');
  let endLine = lines.length;
  for (let i = startLine + 1; i < lines.length; i += 1) {
    const m = /^(#{1,6})\s+/.exec(lines[i]);
    if (m && m[1].length <= startDepth) { endLine = i; break; }
  }
  return { notePath, kind: 'heading', text: lines.slice(startLine, endLine).join('\n') };
}

/** Patch a heading section: replace its body (keep the heading line). */
export async function patchHeadingSection(
  vaultDir: string, notePath: string, headingText: string, newBody: string,
): Promise<{ notePath: string; bytes: number; replacedLines: number }> {
  const abs = await safeRealpath(vaultDir, safeJoin(vaultDir, notePath));
  let raw;
  try { raw = (await readFile(abs)).toString('utf8'); }
  catch { throw new VaultFsError(`note not found: ${notePath}`, 'ENOTFOUND'); }
  const lines = raw.split(/\r?\n/);
  let startLine = -1;
  let startDepth = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[i]);
    if (m && m[2].trim() === headingText.trim()) {
      startLine = i;
      startDepth = m[1].length;
      break;
    }
  }
  if (startLine < 0) throw new VaultFsError(`heading not found: ${headingText}`, 'ENOTFOUND');
  let endLine = lines.length;
  for (let i = startLine + 1; i < lines.length; i += 1) {
    const m = /^(#{1,6})\s+/.exec(lines[i]);
    if (m && m[1].length <= startDepth) { endLine = i; break; }
  }
  const before = lines.slice(0, startLine + 1).join('\n');
  const after = lines.slice(endLine).join('\n');
  const next = before + '\n\n' + newBody.trimEnd() + (after.length > 0 ? '\n\n' + after : '\n');
  const buf = Buffer.from(next, 'utf8');
  await writeFile(abs, buf);
  return { notePath, bytes: buf.length, replacedLines: endLine - startLine - 1 };
}

/** Bulk set one frontmatter key on N notes. Per-note error inline; never aborts. */
export async function bulkSetProperty(
  vaultDir: string, notePaths: string[], key: string, value: unknown,
): Promise<Array<{ notePath: string; ok: boolean; error?: string }>> {
  if (!/^[A-Za-z_][\w-]*$/.test(key)) throw new VaultFsError(`invalid key: ${key}`, 'EBAD');
  const out: Array<{ notePath: string; ok: boolean; error?: string }> = [];
  for (const np of notePaths) {
    try { await setProperty(vaultDir, np, key, value); out.push({ notePath: np, ok: true }); }
    catch (e) { out.push({ notePath: np, ok: false, error: (e as Error).message }); }
  }
  return out;
}

/** Bulk unset one frontmatter key on N notes. */
export async function bulkUnsetProperty(
  vaultDir: string, notePaths: string[], key: string,
): Promise<Array<{ notePath: string; removed: boolean; error?: string }>> {
  const out: Array<{ notePath: string; removed: boolean; error?: string }> = [];
  for (const np of notePaths) {
    try { const r = await unsetProperty(vaultDir, np, key); out.push({ notePath: np, removed: r.removed }); }
    catch (e) { out.push({ notePath: np, removed: false, error: (e as Error).message }); }
  }
  return out;
}

/** Bulk copy: duplicate N notes by {from, to} pairs. */
export async function bulkCopy(
  vaultDir: string, pairs: Array<{ from: string; to: string }>,
): Promise<Array<{ from: string; to: string; ok: boolean; error?: string }>> {
  const out: Array<{ from: string; to: string; ok: boolean; error?: string }> = [];
  for (const pair of pairs) {
    try { await copyPage(vaultDir, pair.from, pair.to); out.push({ ...pair, ok: true }); }
    catch (e) { out.push({ ...pair, ok: false, error: (e as Error).message }); }
  }
  return out;
}

/** Bulk soft-delete: trash N notes in one call. */
export async function bulkDelete(
  vaultDir: string, notePaths: string[],
): Promise<Array<{ notePath: string; ok: boolean; trashedAt?: string; error?: string }>> {
  const out: Array<{ notePath: string; ok: boolean; trashedAt?: string; error?: string }> = [];
  for (const np of notePaths) {
    try { const r = await deletePage(vaultDir, np); out.push({ notePath: np, ok: true, trashedAt: r.trashedAt }); }
    catch (e) { out.push({ notePath: np, ok: false, error: (e as Error).message }); }
  }
  return out;
}

/** Vault-wide top words (lowercased, stopword-filtered). */
const STOPWORDS = new Set('the and for are but not you all any can had her was one our out day get has him his how man new now old see two way who boy did its let put say she too use that with from this they have were said been than them like into your time some more very what just take know come well may say will can man'.split(/\s+/));
export async function vaultTopTerms(
  vaultDir: string, limit: number = 50,
): Promise<Array<{ term: string; count: number }>> {
  const { walkMarkdown } = await import('./indexer.js');
  const files = await walkMarkdown(vaultDir);
  const counts = new Map<string, number>();
  for (const abs of files) {
    const s = await stat(abs).catch(() => null);
    if (!s || s.size > MAX_ANALYTICS_READ_BYTES) continue;
    const text = (await readFile(abs)).toString('utf8').toLowerCase();
    for (const m of text.matchAll(/[a-z]{4,}/g)) {
      if (STOPWORDS.has(m[0])) continue;
      counts.set(m[0], (counts.get(m[0]) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([term, count]) => ({ term, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

/** First non-empty paragraph of a note (skips frontmatter + heading). */
export async function extractFirstParagraph(
  vaultDir: string, notePath: string,
): Promise<{ notePath: string; paragraph: string }> {
  const { text } = await readPage(vaultDir, notePath, { byteStart: 0, byteEnd: 64_000 });
  const body = text.replace(/^---\n[\s\S]*?\n---\n?/, '');
  const blocks = body.split(/\n\n+/);
  const para = blocks.find((b) => b.trim() && !/^#{1,6}\s+/.test(b.trim())) ?? '';
  return { notePath, paragraph: para.trim() };
}

/** Dataview-style inline fields: `key:: value` on a single line. */
export async function extractInlineFields(
  vaultDir: string, notePath: string,
): Promise<{ notePath: string; fields: Array<{ key: string; value: string; line: number }> }> {
  const { text } = await readPage(vaultDir, notePath, { byteStart: 0, byteEnd: 500_000 });
  const lines = text.split(/\r?\n/);
  const fields: Array<{ key: string; value: string; line: number }> = [];
  for (let i = 0; i < lines.length; i += 1) {
    for (const m of lines[i].matchAll(/(?:^|[\s\-*])([A-Za-z][\w-]*)::\s*([^\n]+?)(?=\s+[A-Za-z][\w-]*::|$)/g)) {
      fields.push({ key: m[1], value: m[2].trim(), line: i + 1 });
    }
  }
  return { notePath, fields };
}

/** Notes that reference at least one attachment. */
export async function findNotesWithAttachments(
  vaultDir: string,
): Promise<Array<{ notePath: string; attachmentCount: number }>> {
  const { walkMarkdown } = await import('./indexer.js');
  const files = await walkMarkdown(vaultDir);
  const out: Array<{ notePath: string; attachmentCount: number }> = [];
  for (const abs of files) {
    const s = await stat(abs).catch(() => null);
    if (!s || s.size > MAX_ANALYTICS_READ_BYTES) continue;
    const text = (await readFile(abs)).toString('utf8');
    const embeds = [...text.matchAll(/!\[\[[^\]|#]+\.(?:png|jpe?g|gif|webp|svg|bmp|pdf|mp3|mp4|mov|webm)/gi)].length;
    const mdImgs = [...text.matchAll(/!\[[^\]]*\]\([^)]+\.(?:png|jpe?g|gif|webp|svg|bmp|pdf|mp3|mp4|mov|webm)\)/gi)].length;
    const total = embeds + mdImgs;
    if (total > 0) out.push({ notePath: relative(vaultDir, abs), attachmentCount: total });
  }
  out.sort((a, b) => b.attachmentCount - a.attachmentCount);
  return out;
}

/** Notes modified between two unix-ms timestamps. */
export async function notesInDateRange(
  vaultDir: string, fromMs: number, toMs: number, limit: number = 100,
): Promise<Array<{ notePath: string; mtimeMs: number; bytes: number }>> {
  const { walkMarkdown } = await import('./indexer.js');
  const files = await walkMarkdown(vaultDir);
  const out: Array<{ notePath: string; mtimeMs: number; bytes: number }> = [];
  for (const abs of files) {
    const s = await stat(abs).catch(() => null);
    if (!s) continue;
    if (s.mtimeMs < fromMs || s.mtimeMs > toMs) continue;
    out.push({ notePath: relative(vaultDir, abs), mtimeMs: s.mtimeMs, bytes: s.size });
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out.slice(0, limit);
}

/** Notes whose path starts with prefix. Cheap flat list w/o re-walking the FS. */
export function notesByPathPrefix(
  notePaths: string[], pathPrefix: string, limit: number = 200,
): string[] {
  const p = pathPrefix.replace(/^\/+/, '');
  return notePaths.filter((np) => np.startsWith(p)).slice(0, limit);
}

/** Image refs in a note: ![[X.png]] embeds + ![alt](url) markdown. */
export async function extractImageRefs(
  vaultDir: string, notePath: string,
): Promise<{ notePath: string; embeds: string[]; markdown: Array<{ alt: string; src: string }> }> {
  // 500KB cap → consistent w/ tokenCount + bundle. Image refs live near top of note.
  const { text } = await readPage(vaultDir, notePath, { byteStart: 0, byteEnd: 500_000 });
  const embeds = [...new Set(
    [...text.matchAll(/!\[\[([^\]|#]+\.(?:png|jpe?g|gif|webp|svg|bmp))(?:[|#][^\]]*)?\]\]/gi)].map((m) => m[1]),
  )];
  const markdown = [...text.matchAll(/!\[([^\]]*)\]\(([^)]+\.(?:png|jpe?g|gif|webp|svg|bmp))\)/gi)]
    .map((m) => ({ alt: m[1], src: m[2] }));
  return { notePath, embeds, markdown };
}

/** External http/https URLs referenced in a note. Deduped + ordered by first appearance. */
export async function extractExternalUrls(
  vaultDir: string, notePath: string,
): Promise<{ notePath: string; urls: string[] }> {
  const { text } = await readPage(vaultDir, notePath, { byteStart: 0, byteEnd: 500_000 });
  const seen = new Set<string>();
  const out: string[] = [];
  // Markdown link href OR bare URL in text.
  const mdRe = /\[[^\]]+\]\((https?:\/\/[^)]+)\)/g;
  const bareRe = /(?<![("\[])\b(https?:\/\/[^\s)<>"']+)/g;
  for (const m of text.matchAll(mdRe)) {
    if (!seen.has(m[1])) { seen.add(m[1]); out.push(m[1]); }
  }
  for (const m of text.matchAll(bareRe)) {
    if (!seen.has(m[1])) { seen.add(m[1]); out.push(m[1]); }
  }
  return { notePath, urls: out };
}

/** Replace just the first line of a note (typically the title heading). */
export async function replaceFirstLine(
  vaultDir: string, notePath: string, newLine: string,
): Promise<{ notePath: string; bytes: number }> {
  const abs = await safeRealpath(vaultDir, safeJoin(vaultDir, notePath));
  let raw;
  try { raw = (await readFile(abs)).toString('utf8'); }
  catch { throw new VaultFsError(`note not found: ${notePath}`, 'ENOTFOUND'); }
  const lines = raw.split(/\r?\n/);
  lines[0] = newLine.split(/\r?\n/)[0];
  const buf = Buffer.from(lines.join('\n'), 'utf8');
  await writeFile(abs, buf);
  return { notePath, bytes: buf.length };
}

/** Word count per heading section in a note. Reveals where mass lives. */
export async function wordDensityPerSection(
  vaultDir: string, notePath: string,
): Promise<{ notePath: string; sections: Array<{ heading: string; depth: number; words: number }> }> {
  const { text } = await readPage(vaultDir, notePath, { byteStart: 0, byteEnd: 500_000 });
  const lines = text.split(/\r?\n/);
  const sections: Array<{ heading: string; depth: number; words: number }> = [];
  let cur: { heading: string; depth: number; words: number } | null = { heading: '(preamble)', depth: 0, words: 0 };
  for (const line of lines) {
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (m) {
      if (cur && cur.heading !== '(preamble)' || (cur && cur.words > 0)) sections.push(cur);
      cur = { heading: m[2].trim(), depth: m[1].length, words: 0 };
    } else if (cur) {
      cur.words += line.split(/\s+/).filter(Boolean).length;
    }
  }
  if (cur && (cur.heading !== '(preamble)' || cur.words > 0)) sections.push(cur);
  return { notePath, sections };
}

/** Find wikilink cycles. Pairs of notes that mutually link to each other. */
export function findCircularLinks(
  noteLinks: Map<string, string[]>,
): Array<{ a: string; b: string }> {
  const allNotes = [...noteLinks.keys()];
  const baseToPath = new Map<string, string>();
  for (const p of allNotes) {
    const base = p.replace(/\.md$/i, '').split('/').pop()?.toLowerCase() ?? '';
    if (!baseToPath.has(base)) baseToPath.set(base, p);
  }
  const linksOut = new Map<string, Set<string>>();
  for (const [from, targets] of noteLinks) {
    const set = new Set<string>();
    for (const t of targets) {
      const hit = baseToPath.get(t.toLowerCase());
      if (hit && hit !== from) set.add(hit);
    }
    linksOut.set(from, set);
  }
  const pairs: Array<{ a: string; b: string }> = [];
  const seen = new Set<string>();
  for (const [a, outs] of linksOut) {
    for (const b of outs) {
      if (a >= b) continue;
      const back = linksOut.get(b);
      if (back && back.has(a)) {
        const k = `${a}|${b}`;
        if (!seen.has(k)) { seen.add(k); pairs.push({ a, b }); }
      }
    }
  }
  return pairs;
}

/** Distribution of values seen under a frontmatter key across the vault. */
export async function frontmatterValueDistribution(
  vaultDir: string, notePaths: string[], key: string,
): Promise<Array<{ value: string; count: number }>> {
  if (!/^[A-Za-z_][\w-]*$/.test(key)) throw new VaultFsError(`invalid key: ${key}`, 'EBAD');
  const counts = new Map<string, number>();
  for (const np of notePaths) {
    try {
      const fm = (await getFrontmatter(vaultDir, np)).frontmatter;
      const v = fm[key];
      if (v === undefined) continue;
      const arr = Array.isArray(v) ? v : [v];
      for (const x of arr) {
        const s = String(x);
        counts.set(s, (counts.get(s) ?? 0) + 1);
      }
    } catch { /* skip */ }
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => (b.count - a.count) || a.value.localeCompare(b.value));
}

/** Per-note combined snapshot — one-call status for a note. Smaller than note_meta. */
export async function noteStatusSummary(
  vaultDir: string, notePath: string,
): Promise<{ notePath: string; bytes: number; words: number; lines: number; headings: number; tasks: number; tags: number; outboundLinks: number }> {
  const { text, bytes } = await readPage(vaultDir, notePath);
  const lines = text.split(/\r?\n/);
  const words = text.split(/\s+/).filter(Boolean).length;
  const headings = lines.filter((l) => /^#{1,6}\s+/.test(l)).length;
  const tasks = lines.filter((l) => /^\s*-\s+\[[ xX]\]\s+/.test(l)).length;
  const tags = [...new Set([...text.matchAll(/(?:^|\s)#([A-Za-z0-9][\w/-]*)/gm)].map((m) => m[1]))].length;
  const outboundLinks = [...new Set([...text.matchAll(/(?<!!)\[\[([^\]|#]+)/g)].map((m) => m[1]))].length;
  return { notePath, bytes, words, lines: lines.length, headings, tasks, tags, outboundLinks };
}

/** Set one frontmatter key. Inserts FM block if missing, preserves other keys. */
export async function setProperty(
  vaultDir: string, notePath: string, key: string, value: unknown,
): Promise<{ notePath: string; bytes: number }> {
  if (!/^[A-Za-z_][\w-]*$/.test(key)) throw new VaultFsError(`invalid key: ${key}`, 'EBAD');
  const fm = (await getFrontmatter(vaultDir, notePath)).frontmatter;
  fm[key] = value;
  return setFrontmatter(vaultDir, notePath, fm);
}

/** Remove one frontmatter key. No-op if absent. */
export async function unsetProperty(
  vaultDir: string, notePath: string, key: string,
): Promise<{ notePath: string; bytes: number; removed: boolean }> {
  const fm = (await getFrontmatter(vaultDir, notePath)).frontmatter;
  const had = key in fm;
  if (had) delete fm[key];
  const r = await setFrontmatter(vaultDir, notePath, fm);
  return { ...r, removed: had };
}

/** Add a #tag to one note (skip if exact tag already present). */
export async function addTagToNote(
  vaultDir: string, notePath: string, tag: string,
): Promise<{ notePath: string; added: boolean; bytes: number }> {
  if (!/^[A-Za-z0-9][\w/-]*$/.test(tag)) throw new VaultFsError(`invalid tag: ${tag}`, 'EBAD');
  const { text } = await readPage(vaultDir, notePath);
  const re = new RegExp(`(?:^|\\s)#${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`, 'm');
  if (re.test(text)) {
    return { notePath, added: false, bytes: Buffer.byteLength(text, 'utf8') };
  }
  const r = await appendToPage(vaultDir, notePath, `\n\n#${tag}\n`);
  return { notePath, added: true, bytes: r.bytes };
}

/** Strip every occurrence of #tag (and only that tag, exact) from a note. */
export async function removeTagFromNote(
  vaultDir: string, notePath: string, tag: string,
): Promise<{ notePath: string; replacements: number; bytes: number }> {
  if (!/^[A-Za-z0-9][\w/-]*$/.test(tag)) throw new VaultFsError(`invalid tag: ${tag}`, 'EBAD');
  const abs = await safeRealpath(vaultDir, safeJoin(vaultDir, notePath));
  let raw;
  try { raw = (await readFile(abs)).toString('utf8'); }
  catch { throw new VaultFsError(`note not found: ${notePath}`, 'ENOTFOUND'); }
  const re = new RegExp(`(^|\\s)#${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`, 'gm');
  let count = 0;
  const next = raw.replace(re, (_m, ws: string) => { count += 1; return ws; });
  if (count > 0) await writeFile(abs, Buffer.from(next, 'utf8'));
  return { notePath, replacements: count, bytes: Buffer.byteLength(next, 'utf8') };
}

/** Find Obsidian tasks across vault: `- [ ]` (open) + `- [x]` (done), incl. checked variants. */
export async function findTasks(
  vaultDir: string, opts: { status?: 'all' | 'open' | 'done'; pathPrefix?: string; limit?: number } = {},
): Promise<Array<{ notePath: string; line: number; status: 'open' | 'done'; text: string }>> {
  const { walkMarkdown } = await import('./indexer.js');
  const files = await walkMarkdown(vaultDir);
  const filter = opts.status ?? 'all';
  const cap = opts.limit ?? 200;
  const out: Array<{ notePath: string; line: number; status: 'open' | 'done'; text: string }> = [];
  for (const abs of files) {
    const rel = relative(vaultDir, abs);
    if (opts.pathPrefix && !rel.startsWith(opts.pathPrefix)) continue;
    const s = await stat(abs).catch(() => null);
    if (!s || s.size > MAX_ANALYTICS_READ_BYTES) continue;
    const lines = (await readFile(abs)).toString('utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const m = /^\s*-\s+\[(.)\]\s+(.+?)\s*$/.exec(lines[i]);
      if (!m) continue;
      const status: 'open' | 'done' = m[1].trim().toLowerCase() === 'x' ? 'done' : 'open';
      if (filter !== 'all' && status !== filter) continue;
      out.push({ notePath: rel, line: i + 1, status, text: m[2].slice(0, 200) });
      if (out.length >= cap) return out;
    }
  }
  return out;
}

/** Toggle a task checkbox at a specific 1-indexed line. */
export async function toggleTask(
  vaultDir: string, notePath: string, line: number,
): Promise<{ notePath: string; line: number; newStatus: 'open' | 'done' | 'no-task'; bytes: number }> {
  if (line < 1) throw new VaultFsError(`bad line ${line}`, 'EBAD');
  const abs = await safeRealpath(vaultDir, safeJoin(vaultDir, notePath));
  let raw;
  try { raw = (await readFile(abs)).toString('utf8'); }
  catch { throw new VaultFsError(`note not found: ${notePath}`, 'ENOTFOUND'); }
  const lines = raw.split(/\r?\n/);
  if (line > lines.length) throw new VaultFsError(`line ${line} > ${lines.length}`, 'EBAD');
  const idx = line - 1;
  const m = /^(\s*-\s+\[)(.)(]\s+.+)$/.exec(lines[idx]);
  if (!m) return { notePath, line, newStatus: 'no-task', bytes: Buffer.byteLength(raw, 'utf8') };
  const current = m[2].trim().toLowerCase();
  const next: 'open' | 'done' = current === 'x' ? 'open' : 'done';
  lines[idx] = `${m[1]}${next === 'done' ? 'x' : ' '}${m[3]}`;
  const buf = Buffer.from(lines.join('\n'), 'utf8');
  await writeFile(abs, buf);
  return { notePath, line, newStatus: next, bytes: buf.length };
}

/** Find ```dataview``` blocks across the vault → query + location. */
export async function findDataviewBlocks(
  vaultDir: string, limit: number = 100,
): Promise<Array<{ notePath: string; startLine: number; query: string }>> {
  const { walkMarkdown } = await import('./indexer.js');
  const files = await walkMarkdown(vaultDir);
  const out: Array<{ notePath: string; startLine: number; query: string }> = [];
  for (const abs of files) {
    const s = await stat(abs).catch(() => null);
    if (!s || s.size > MAX_ANALYTICS_READ_BYTES) continue;
    const lines = (await readFile(abs)).toString('utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      if (!/^```dataview\s*$/i.test(lines[i])) continue;
      const start = i + 1;
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { body.push(lines[i]); i += 1; }
      out.push({ notePath: relative(vaultDir, abs), startLine: start, query: body.join('\n') });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** Note count snapshot. Cheap top-level read. */
export async function countNotes(
  vaultDir: string, pathPrefix?: string,
): Promise<{ notes: number; bytes: number }> {
  const { walkMarkdown } = await import('./indexer.js');
  const files = await walkMarkdown(vaultDir);
  let notes = 0; let bytes = 0;
  for (const abs of files) {
    if (pathPrefix && !relative(vaultDir, abs).startsWith(pathPrefix)) continue;
    const s = await stat(abs).catch(() => null);
    if (!s) continue;
    notes += 1; bytes += s.size;
  }
  return { notes, bytes };
}

/** SHA-256 hash of a note's bytes → cheap dedup key + change detection. */
export async function noteHash(
  vaultDir: string, notePath: string,
): Promise<{ notePath: string; bytes: number; sha256: string }> {
  const abs = await safeRealpath(vaultDir, safeJoin(vaultDir, notePath));
  let buf;
  try { buf = await readFile(abs); } catch { throw new VaultFsError(`note not found: ${notePath}`, 'ENOTFOUND'); }
  const { createHash } = await import('node:crypto');
  return { notePath, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') };
}

/** Exact-content duplicates across the vault. Returns groups of notes that share identical SHA-256. */
export async function findExactDuplicates(
  vaultDir: string,
): Promise<Array<{ sha256: string; notes: string[]; bytes: number }>> {
  const { walkMarkdown } = await import('./indexer.js');
  const { createHash } = await import('node:crypto');
  const files = await walkMarkdown(vaultDir);
  const groups = new Map<string, { notes: string[]; bytes: number }>();
  for (const abs of files) {
    const s = await stat(abs).catch(() => null);
    if (!s || s.size > MAX_ANALYTICS_READ_BYTES) continue;
    const buf = await readFile(abs);
    const sha = createHash('sha256').update(buf).digest('hex');
    const rel = relative(vaultDir, abs);
    const g = groups.get(sha) ?? { notes: [], bytes: buf.length };
    g.notes.push(rel);
    groups.set(sha, g);
  }
  return [...groups.entries()]
    .filter(([, g]) => g.notes.length >= 2)
    .map(([sha256, g]) => ({ sha256, notes: g.notes.sort(), bytes: g.bytes }))
    .sort((a, b) => b.notes.length - a.notes.length);
}

/** Notes with body-only word count under threshold (frontmatter stripped). */
export async function findEmptyNotes(
  vaultDir: string, maxBodyWords: number = 5,
): Promise<Array<{ notePath: string; bodyWords: number; bytes: number }>> {
  const { walkMarkdown } = await import('./indexer.js');
  const files = await walkMarkdown(vaultDir);
  const out: Array<{ notePath: string; bodyWords: number; bytes: number }> = [];
  for (const abs of files) {
    const s = await stat(abs).catch(() => null);
    if (!s || s.size > MAX_ANALYTICS_READ_BYTES) continue;
    const raw = (await readFile(abs)).toString('utf8');
    const body = raw.replace(/^---\n[\s\S]*?\n---\n?/, '').replace(/#{1,6}\s+.+/g, '').trim();
    const words = body.split(/\s+/).filter(Boolean).length;
    if (words <= maxBodyWords) out.push({ notePath: relative(vaultDir, abs), bodyWords: words, bytes: s.size });
  }
  out.sort((a, b) => a.bodyWords - b.bodyWords);
  return out;
}

/** Notes that lack any frontmatter block. Probes the first 64 bytes only (Fix: review MEDIUM #3). */
export async function findNotesWithoutFrontmatter(
  vaultDir: string,
): Promise<Array<{ notePath: string; bytes: number }>> {
  const { walkMarkdown } = await import('./indexer.js');
  const { open } = await import('node:fs/promises');
  const files = await walkMarkdown(vaultDir);
  const out: Array<{ notePath: string; bytes: number }> = [];
  for (const abs of files) {
    const s = await stat(abs).catch(() => null);
    if (!s) continue;
    let fh;
    try { fh = await open(abs, 'r'); }
    catch { continue; }
    const buf = Buffer.alloc(64);
    try {
      await fh.read(buf, 0, 64, 0);
      const head = buf.toString('utf8');
      if (!/^---\n/.test(head)) out.push({ notePath: relative(vaultDir, abs), bytes: s.size });
    } finally { await fh.close(); }
  }
  return out.sort((a, b) => a.notePath.localeCompare(b.notePath));
}

/** Notes whose frontmatter contains a given key (any value). */
export async function findNotesWithProperty(
  vaultDir: string, key: string,
): Promise<Array<{ notePath: string; value: unknown }>> {
  const { walkMarkdown } = await import('./indexer.js');
  const files = await walkMarkdown(vaultDir);
  const out: Array<{ notePath: string; value: unknown }> = [];
  for (const abs of files) {
    const rel = relative(vaultDir, abs);
    try {
      const fm = (await getFrontmatter(vaultDir, rel)).frontmatter;
      if (key in fm) out.push({ notePath: rel, value: fm[key] });
    } catch { /* skip */ }
  }
  return out.sort((a, b) => a.notePath.localeCompare(b.notePath));
}

/** Wikilink audit: every wikilink target across vault + resolved? Bounded response (Fix: review MEDIUM #4). */
export async function wikilinkAudit(
  noteLinks: Map<string, string[]>, limit: number = 5000,
): Promise<{ resolved: number; unresolved: Array<{ from: string; target: string }>; counts: Record<string, number>; truncated: boolean }> {
  const allNotes = [...noteLinks.keys()];
  const baseNames = new Set(allNotes.map((p) => p.replace(/\.md$/i, '').split('/').pop()?.toLowerCase() ?? ''));
  const fullPaths = new Set(allNotes.map((p) => p.toLowerCase()));
  const counts: Record<string, number> = {};
  const unresolved: Array<{ from: string; target: string }> = [];
  let resolved = 0;
  let truncated = false;
  for (const [from, targets] of noteLinks) {
    for (const t of targets) {
      counts[t] = (counts[t] ?? 0) + 1;
      const tLower = t.toLowerCase();
      const ok = baseNames.has(tLower) || fullPaths.has(tLower) || fullPaths.has(`${tLower}.md`);
      if (ok) resolved += 1;
      else if (unresolved.length < limit) unresolved.push({ from, target: t });
      else truncated = true;
    }
  }
  return { resolved, unresolved, counts, truncated };
}

/** Archive a note: move to an archive folder + add an archived: <date> frontmatter key. */
export async function archiveNote(
  vaultDir: string, notePath: string, opts: { archiveFolder?: string } = {},
): Promise<{ from: string; to: string }> {
  const folder = opts.archiveFolder ?? 'Archive';
  await createFolder(vaultDir, folder);
  const base = notePath.split('/').pop() ?? notePath;
  const to = `${folder}/${base}`;
  await renamePath(vaultDir, notePath, to);
  try {
    const fm = (await getFrontmatter(vaultDir, to)).frontmatter;
    const today = new Date().toISOString().slice(0, 10);
    fm.archived = today;
    await setFrontmatter(vaultDir, to, fm);
  } catch { /* if frontmatter parse fails, leave content alone */ }
  return { from: notePath, to };
}

/** Remove empty subfolders under root. Returns paths pruned. */
export async function pruneEmptyFolders(
  vaultDir: string, root: string = '',
): Promise<{ pruned: string[] }> {
  const start = await safeRealpath(vaultDir, safeJoin(vaultDir, root));
  const pruned: string[] = [];
  const walk = async (d: string): Promise<boolean> => {
    let entries;
    try { entries = await readdir(d, { withFileTypes: true }); } catch { return false; }
    const kids = entries.filter((e) => !e.name.startsWith('.'));
    let nonEmpty = false;
    for (const e of kids) {
      const p = join(d, e.name);
      // Per-child safeRealpath → symlink-to-dir outside vault never recurses, never gets rmdir'd (Fix: review MEDIUM #1).
      if (e.isSymbolicLink()) { nonEmpty = true; continue; }
      try { await safeRealpath(vaultDir, p); }
      catch (err) { if ((err as VaultFsError).code === 'EESCAPE') { nonEmpty = true; continue; } throw err; }
      if (e.isDirectory()) {
        const empty = !(await walk(p));
        if (!empty) nonEmpty = true;
      } else nonEmpty = true;
    }
    if (!nonEmpty && d !== start) {
      // rm w/ recursive=false rejects dirs on darwin → use rmdir (we already proved it's empty).
      const { rmdir } = await import('node:fs/promises');
      await rmdir(d).catch(() => undefined);
      pruned.push(relative(vaultDir, d));
      return false;
    }
    return true;
  };
  await walk(start);
  return { pruned: pruned.sort() };
}

/** GPT-tokenizer token count (BPE) for a note. Caps at 500KB → never blocks the event loop (Fix: review MEDIUM #2). */
export async function tokenCount(
  vaultDir: string, notePath: string,
): Promise<{ notePath: string; tokens: number; bytes: number; truncated: boolean }> {
  const { bytes } = await readPage(vaultDir, notePath, { byteStart: 0, byteEnd: 1 });
  const cap = 500_000;
  const { text } = await readPage(vaultDir, notePath, { byteStart: 0, byteEnd: cap });
  const { encode } = await import('gpt-tokenizer');
  return { notePath, tokens: encode(text).length, bytes, truncated: bytes > cap };
}

/** Extract every link from a note: wikilinks [[X]], markdown [text](url), embeds ![[X]]. */
export async function extractLinks(
  vaultDir: string, notePath: string,
): Promise<{ notePath: string; wikilinks: string[]; markdownLinks: Array<{ text: string; href: string }>; embeds: string[] }> {
  const { text } = await readPage(vaultDir, notePath);
  const wiki = [...text.matchAll(/(?<!!)\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)].map((m) => m[1]);
  const embeds = [...text.matchAll(/!\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)].map((m) => m[1]);
  const md = [...text.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)].map((m) => ({ text: m[1], href: m[2] }));
  return { notePath, wikilinks: [...new Set(wiki)], markdownLinks: md, embeds: [...new Set(embeds)] };
}

/** Extract markdown tables from a note. Returns each table as an array of row arrays. */
export async function extractTables(
  vaultDir: string, notePath: string,
): Promise<{ notePath: string; tables: Array<{ startLine: number; rows: string[][] }> }> {
  const { text } = await readPage(vaultDir, notePath);
  const lines = text.split(/\r?\n/);
  const tables: Array<{ startLine: number; rows: string[][] }> = [];
  let i = 0;
  while (i < lines.length) {
    if (/^\|.*\|\s*$/.test(lines[i]) && i + 1 < lines.length && /^\|?[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
      const startLine = i + 1;
      const rows: string[][] = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) {
        if (!/^\|?[\s:|-]+\|?\s*$/.test(lines[i])) {
          rows.push(lines[i].replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
        }
        i += 1;
      }
      tables.push({ startLine, rows });
    } else { i += 1; }
  }
  return { notePath, tables };
}

/** Extract blockquotes (lines starting with >) from a note. Returns grouped quotes. */
export async function extractQuotes(
  vaultDir: string, notePath: string,
): Promise<{ notePath: string; quotes: Array<{ startLine: number; text: string }> }> {
  const { text } = await readPage(vaultDir, notePath);
  const lines = text.split(/\r?\n/);
  const quotes: Array<{ startLine: number; text: string }> = [];
  let i = 0;
  while (i < lines.length) {
    if (/^\s*>/.test(lines[i])) {
      const start = i + 1;
      const buf: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      quotes.push({ startLine: start, text: buf.join('\n') });
    } else { i += 1; }
  }
  return { notePath, quotes };
}

/** Convert link style inside a note: 'wiki-to-md' → [[X]] → [X](X.md); 'md-to-wiki' → [text](path.md) → [[path|text]]. */
export async function convertLinks(
  vaultDir: string, notePath: string, mode: 'wiki-to-md' | 'md-to-wiki',
): Promise<{ notePath: string; bytes: number; replacements: number }> {
  const abs = await safeRealpath(vaultDir, safeJoin(vaultDir, notePath));
  let raw;
  try { raw = (await readFile(abs)).toString('utf8'); }
  catch { throw new VaultFsError(`note not found: ${notePath}`, 'ENOTFOUND'); }
  let count = 0;
  let next: string;
  if (mode === 'wiki-to-md') {
    next = raw.replace(/(?<!!)\[\[([^\]|#]+)(\|([^\]]+))?\]\]/g, (_m, target: string, _g2, alias?: string) => {
      count += 1;
      const label = alias ?? target;
      // Strip traversal segments + leading slashes from the href → no clickable escape (Fix: review MEDIUM #1).
      const cleanTarget = target.replace(/\.{2,}/g, '').replace(/^\/+/, '');
      return `[${label}](${cleanTarget.endsWith('.md') ? cleanTarget : cleanTarget + '.md'})`;
    });
  } else {
    next = raw.replace(/\[([^\]]+)\]\(([^)]+\.md)\)/g, (_m, text: string, href: string) => {
      count += 1;
      const target = href.replace(/\.md$/i, '');
      return text === target ? `[[${target}]]` : `[[${target}|${text}]]`;
    });
  }
  if (count > 0) await writeFile(abs, Buffer.from(next, 'utf8'));
  return { notePath, bytes: Buffer.byteLength(next, 'utf8'), replacements: count };
}

/** Render a note's outline as a markdown TOC string. */
export async function renderToc(
  vaultDir: string, notePath: string, opts: { maxDepth?: number } = {},
): Promise<{ notePath: string; toc: string; entries: number }> {
  const { text } = await readPage(vaultDir, notePath);
  const lines = text.split(/\r?\n/);
  const maxDepth = opts.maxDepth ?? 6;
  const out: string[] = [];
  for (const l of lines) {
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(l);
    if (!m) continue;
    const d = m[1].length;
    if (d > maxDepth) continue;
    const slug = m[2].trim().toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
    out.push(`${'  '.repeat(d - 1)}- [${m[2].trim()}](#${slug})`);
  }
  return { notePath, toc: out.join('\n'), entries: out.length };
}

/** Find files within a byte-size range under the vault. */
export async function findBySizeRange(
  vaultDir: string, minBytes: number, maxBytes: number, folderPath: string = '',
): Promise<Array<{ path: string; bytes: number; ext: string }>> {
  const root = await safeRealpath(vaultDir, safeJoin(vaultDir, folderPath));
  const out: Array<{ path: string; bytes: number; ext: string }> = [];
  const walk = async (d: string): Promise<void> => {
    let entries; try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (e.isSymbolicLink()) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) {
        const s = await stat(p);
        if (s.size < minBytes || s.size > maxBytes) continue;
        out.push({ path: relative(vaultDir, p), bytes: s.size, ext: extname(e.name).toLowerCase().replace(/^\./, '') });
      }
    }
  };
  await walk(root);
  out.sort((a, b) => b.bytes - a.bytes);
  return out;
}

/** Find TODO / FIXME / NOTE / HACK markers across the vault. */
export async function findTodos(
  vaultDir: string, opts: { markers?: string[]; pathPrefix?: string; limit?: number } = {},
): Promise<Array<{ notePath: string; line: number; marker: string; text: string }>> {
  const markers = opts.markers ?? ['TODO', 'FIXME', 'NOTE', 'HACK', 'XXX'];
  const re = new RegExp(`\\b(${markers.map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'g');
  const { walkMarkdown } = await import('./indexer.js');
  const files = await walkMarkdown(vaultDir);
  const out: Array<{ notePath: string; line: number; marker: string; text: string }> = [];
  const cap = opts.limit ?? 200;
  for (const abs of files) {
    const rel = relative(vaultDir, abs);
    if (opts.pathPrefix && !rel.startsWith(opts.pathPrefix)) continue;
    const s = await stat(abs).catch(() => null);
    if (!s || s.size > 1_000_000) continue;
    const lines = (await readFile(abs)).toString('utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const m = re.exec(lines[i]);
      re.lastIndex = 0;
      if (m) {
        out.push({ notePath: rel, line: i + 1, marker: m[1], text: lines[i].slice(0, 200) });
        if (out.length >= cap) return out;
      }
    }
  }
  return out;
}

/** Find attachments referenced from no note. Inverse of listAttachments. */
export async function findUnreferencedAttachments(
  vaultDir: string,
): Promise<Array<{ path: string; bytes: number }>> {
  const attachments = (await listAttachments(vaultDir)).attachments;
  if (attachments.length === 0) return [];
  const { walkMarkdown } = await import('./indexer.js');
  const files = await walkMarkdown(vaultDir);
  const referenced = new Set<string>();
  for (const abs of files) {
    // Skip giant files → bounded heap on the inner O(N×M) scan (Fix: review MEDIUM #2).
    const s = await stat(abs).catch(() => null);
    if (!s || s.size > MAX_ANALYTICS_READ_BYTES) continue;
    const src = (await readFile(abs)).toString('utf8');
    for (const a of attachments) {
      const base = a.path.split('/').pop() ?? '';
      // Match in [[X]] / ![[X]] / [text](X) — basename or full path.
      if (src.includes(`[[${base}]]`) || src.includes(`![[${base}]]`) || src.includes(`(${a.path})`) || src.includes(`(${base})`)) {
        referenced.add(a.path);
      }
    }
  }
  return attachments
    .filter((a) => !referenced.has(a.path))
    .map((a) => ({ path: a.path, bytes: a.bytes }));
}

/** Bulk frontmatter fetch for N notes in one call → token-efficient batch read. */
export async function bulkFrontmatter(
  vaultDir: string, notePaths: string[],
): Promise<Array<{ notePath: string; frontmatter: Record<string, unknown>; error?: string }>> {
  const out: Array<{ notePath: string; frontmatter: Record<string, unknown>; error?: string }> = [];
  for (const np of notePaths) {
    try { const r = await getFrontmatter(vaultDir, np); out.push({ notePath: np, frontmatter: r.frontmatter }); }
    catch (e) { out.push({ notePath: np, frontmatter: {}, error: (e as Error).message }); }
  }
  return out;
}

/** Vault-wide link + tag map dump → JSON snapshot for downstream tooling. */
export async function vaultIndexExport(
  vaultDir: string, noteLinks: Map<string, string[]>,
): Promise<{ notes: number; links: Record<string, string[]>; tags: Record<string, string[]> }> {
  const links: Record<string, string[]> = {};
  for (const [k, v] of noteLinks) links[k] = v;
  const tagsByNote: Record<string, string[]> = {};
  for (const np of noteLinks.keys()) {
    try {
      // safeJoin defense-in-depth + per-file cap (Fix: review MEDIUM #4).
      const abs = await safeRealpath(vaultDir, safeJoin(vaultDir, np));
      const s = await stat(abs).catch(() => null);
      if (!s || s.size > MAX_ANALYTICS_READ_BYTES) continue;
      const text = (await readFile(abs)).toString('utf8');
      const tags = [...new Set([...text.matchAll(/(?:^|\s)#([A-Za-z0-9][\w/-]*)/gm)].map((m) => m[1]))];
      if (tags.length > 0) tagsByNote[np] = tags;
    } catch { /* skip */ }
  }
  return { notes: noteLinks.size, links, tags: tagsByNote };
}

/** Split a note at every level-N heading → N new notes (one per section). Originals optionally kept. */
export async function splitNote(
  vaultDir: string, notePath: string, opts: { atDepth?: number; outputFolder?: string; keepOriginal?: boolean } = {},
): Promise<{ created: string[]; removed?: string }> {
  const depth = Math.max(1, Math.min(opts.atDepth ?? 2, 6));
  const { text } = await readPage(vaultDir, notePath);
  const lines = text.split(/\r?\n/);
  const re = new RegExp(`^#{${depth}}\\s+(.+?)\\s*$`);
  const sections: Array<{ title: string; body: string[] }> = [];
  let cur: { title: string; body: string[] } | null = null;
  for (const line of lines) {
    const m = re.exec(line);
    if (m) { if (cur) sections.push(cur); cur = { title: m[1].trim(), body: [line] }; }
    else if (cur) cur.body.push(line);
  }
  if (cur) sections.push(cur);
  if (sections.length === 0) throw new VaultFsError(`no level-${depth} headings in ${notePath}`, 'EBAD');
  const folder = opts.outputFolder ?? notePath.replace(/\.md$/i, '') + '-split';
  await createFolder(vaultDir, folder);
  const created: string[] = [];
  for (const s of sections) {
    // Strip leading dots + path separators → no '..' segment escapes outputFolder (Fix: review MEDIUM #1).
    let safe = s.title.replace(/[^\w\s.-]/g, '').trim().replace(/\s+/g, '-').slice(0, 80);
    safe = safe.replace(/^\.+/, '').replace(/\.+$/, '');
    if (!safe) safe = 'untitled';
    const p = `${folder}/${safe}.md`;
    await createPage(vaultDir, p, s.body.join('\n'), { overwrite: true });
    created.push(p);
  }
  let removed: string | undefined;
  if (opts.keepOriginal === false) {
    const r = await deletePage(vaultDir, notePath);
    removed = r.trashedAt;
  }
  return { created, removed };
}

/** Concat N notes into one. Optional source deletion (soft → .trash). */
export async function mergeNotes(
  vaultDir: string, sourcePaths: string[], targetPath: string,
  opts: { separator?: string; deleteSources?: boolean } = {},
): Promise<{ targetPath: string; bytes: number; mergedFrom: string[]; sourcesTrashed: string[] }> {
  const sep = opts.separator ?? '\n\n---\n\n';
  const parts: string[] = [];
  const merged: string[] = [];
  for (const sp of sourcePaths) {
    try {
      const { text } = await readPage(vaultDir, sp);
      parts.push(text);
      merged.push(sp);
    } catch { /* skip missing */ }
  }
  const body = parts.join(sep);
  const r = await createPage(vaultDir, targetPath, body, { overwrite: true });
  const trashed: string[] = [];
  if (opts.deleteSources) {
    for (const sp of merged) {
      if (sp === targetPath) continue;
      try { const t = await deletePage(vaultDir, sp); trashed.push(t.trashedAt); }
      catch { /* skip */ }
    }
  }
  return { targetPath, bytes: r.bytes, mergedFrom: merged, sourcesTrashed: trashed };
}

/** Find files by extension(s) under the vault. Returns relative paths + sizes. */
export async function findByExtension(
  vaultDir: string, exts: string[], folderPath: string = '',
): Promise<Array<{ path: string; bytes: number; ext: string }>> {
  const root = await safeRealpath(vaultDir, safeJoin(vaultDir, folderPath));
  const normExts = new Set(exts.map((e) => e.toLowerCase().replace(/^\./, '')));
  const out: Array<{ path: string; bytes: number; ext: string }> = [];
  const walk = async (d: string): Promise<void> => {
    let entries; try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (e.isSymbolicLink()) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) {
        const ext = extname(e.name).toLowerCase().replace(/^\./, '');
        if (!normExts.has(ext)) continue;
        const s = await stat(p);
        out.push({ path: relative(vaultDir, p), bytes: s.size, ext });
      }
    }
  };
  await walk(root);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

/** Block ids (^id) referenced inside a note. Useful for citing chunks. */
export async function blockIds(
  vaultDir: string, notePath: string,
): Promise<{ notePath: string; ids: Array<{ id: string; line: number }> }> {
  const { text } = await readPage(vaultDir, notePath);
  const lines = text.split(/\r?\n/);
  const ids: Array<{ id: string; line: number }> = [];
  for (let i = 0; i < lines.length; i += 1) {
    for (const m of lines[i].matchAll(/\s\^([A-Za-z0-9-]+)$/g)) {
      ids.push({ id: m[1], line: i + 1 });
    }
  }
  return { notePath, ids };
}

/** Bulk rename: apply multiple renames in one call. Skips failures, returns per-pair status. */
export async function bulkRename(
  vaultDir: string, renames: Array<{ from: string; to: string }>,
): Promise<Array<{ from: string; to: string; ok: boolean; error?: string }>> {
  const out: Array<{ from: string; to: string; ok: boolean; error?: string }> = [];
  for (const r of renames) {
    try { await renamePath(vaultDir, r.from, r.to); out.push({ ...r, ok: true }); }
    catch (e) { out.push({ ...r, ok: false, error: (e as Error).message }); }
  }
  return out;
}

/** Notes w/ at least one line longer than N chars. Sorted by max line desc. */
const LONGLINES_MAX_FILE_BYTES = 1_000_000;
export async function findLongLines(
  vaultDir: string, minLineLen: number, limit: number = 50,
): Promise<Array<{ notePath: string; maxLineLen: number; line: number }>> {
  const { walkMarkdown } = await import('./indexer.js');
  const files = await walkMarkdown(vaultDir);
  const out: Array<{ notePath: string; maxLineLen: number; line: number }> = [];
  for (const abs of files) {
    // Skip oversized files → mirrors grepVault cap (Fix: review MEDIUM #2).
    const s = await stat(abs).catch(() => null);
    if (!s || s.size > LONGLINES_MAX_FILE_BYTES) continue;
    const lines = (await readFile(abs)).toString('utf8').split(/\r?\n/);
    let maxLen = 0; let at = 0;
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].length > maxLen) { maxLen = lines[i].length; at = i + 1; }
    }
    if (maxLen >= minLineLen) {
      out.push({ notePath: relative(vaultDir, abs), maxLineLen: maxLen, line: at });
    }
  }
  out.sort((a, b) => b.maxLineLen - a.maxLineLen);
  return out.slice(0, limit);
}

/** First N lines or first N bytes of a note. Token-efficient peek. */
export async function excerpt(
  vaultDir: string, notePath: string, opts: { lines?: number; bytes?: number } = {},
): Promise<{ notePath: string; text: string; bytes: number; truncated: boolean }> {
  const { text: full, bytes } = await readPage(vaultDir, notePath, { byteStart: 0, byteEnd: opts.bytes ?? 4096 });
  const lineCap = opts.lines ?? 50;
  const lines = full.split(/\r?\n/);
  const slice = lines.slice(0, lineCap).join('\n');
  const truncated = lines.length > lineCap || full.length < bytes;
  return { notePath, text: slice, bytes: Buffer.byteLength(slice, 'utf8'), truncated };
}

/** Pick N random note paths from the indexed set. */
export function randomNotes(notePaths: string[], n: number = 1): string[] {
  const a = [...notePaths];
  // Fisher-Yates partial shuffle → unbiased random sample.
  for (let i = 0; i < Math.min(n, a.length); i += 1) {
    const j = i + Math.floor(Math.random() * (a.length - i));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

/** Notes modified since a unix-ms timestamp. Sorted newest first. */
export async function notesSince(
  vaultDir: string, sinceMs: number, limit: number = 50,
): Promise<Array<{ notePath: string; mtimeMs: number; bytes: number }>> {
  const { walkMarkdown } = await import('./indexer.js');
  const files = await walkMarkdown(vaultDir);
  const out: Array<{ notePath: string; mtimeMs: number; bytes: number }> = [];
  for (const abs of files) {
    const s = await stat(abs).catch(() => null);
    if (!s || s.mtimeMs < sinceMs) continue;
    out.push({ notePath: relative(vaultDir, abs), mtimeMs: s.mtimeMs, bytes: s.size });
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out.slice(0, limit);
}

/** Stale notes: mtime older than ageDays. Sorted oldest first. */
export async function staleNotes(
  vaultDir: string, ageDays: number, limit: number = 50,
): Promise<Array<{ notePath: string; mtimeMs: number; ageDays: number }>> {
  const cutoff = Date.now() - ageDays * 86_400_000;
  const { walkMarkdown } = await import('./indexer.js');
  const files = await walkMarkdown(vaultDir);
  const out: Array<{ notePath: string; mtimeMs: number; ageDays: number }> = [];
  for (const abs of files) {
    const s = await stat(abs).catch(() => null);
    if (!s || s.mtimeMs >= cutoff) continue;
    out.push({ notePath: relative(vaultDir, abs), mtimeMs: s.mtimeMs, ageDays: (Date.now() - s.mtimeMs) / 86_400_000 });
  }
  out.sort((a, b) => a.mtimeMs - b.mtimeMs);
  return out.slice(0, limit);
}

/** Per-folder note count + byte total. One level deep under the given root. */
export async function sizeBreakdown(
  vaultDir: string, root: string = '',
): Promise<{ root: string; folders: Array<{ folder: string; notes: number; bytes: number }> }> {
  const start = await safeRealpath(vaultDir, safeJoin(vaultDir, root));
  const out: Array<{ folder: string; notes: number; bytes: number }> = [];
  let entries;
  try { entries = await readdir(start, { withFileTypes: true }); } catch { return { root, folders: [] }; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    let notes = 0, bytes = 0;
    const sub = join(start, e.name);
    const walk = async (d: string): Promise<void> => {
      for (const ent of await readdir(d, { withFileTypes: true })) {
        if (ent.name.startsWith('.')) continue;
        if (ent.isSymbolicLink()) continue; // explicit skip → no symlink follow regardless of Node version.
        const p = join(d, ent.name);
        if (ent.isDirectory()) await walk(p);
        else if (ent.isFile() && extname(ent.name).toLowerCase() === '.md') {
          notes += 1; bytes += (await stat(p)).size;
        }
      }
    };
    try { await walk(sub); } catch { /* skip */ }
    out.push({ folder: e.name, notes, bytes });
  }
  out.sort((a, b) => b.bytes - a.bytes);
  return { root, folders: out };
}

/** Wikilink autocomplete: notes whose path or basename starts w/ prefix. */
export function wikilinkCompletions(notePaths: string[], prefix: string, limit: number = 20): string[] {
  const p = prefix.toLowerCase();
  return notePaths
    .filter((np) => {
      const base = np.replace(/\.md$/i, '').split('/').pop()?.toLowerCase() ?? '';
      return np.toLowerCase().startsWith(p) || base.startsWith(p);
    })
    .slice(0, limit);
}

/** Replace text on a specific 1-indexed line range. */
export async function replaceLines(
  vaultDir: string, notePath: string, startLine: number, endLine: number, newText: string,
): Promise<{ notePath: string; bytes: number; replacedLines: number }> {
  if (startLine < 1 || endLine < startLine) throw new VaultFsError(`bad line range ${startLine}-${endLine}`, 'EBAD');
  const abs = await safeRealpath(vaultDir, safeJoin(vaultDir, notePath));
  let raw;
  try { raw = (await readFile(abs)).toString('utf8'); }
  catch { throw new VaultFsError(`note not found: ${notePath}`, 'ENOTFOUND'); }
  const lines = raw.split(/\r?\n/);
  if (startLine > lines.length) throw new VaultFsError(`startLine ${startLine} > ${lines.length}`, 'EBAD');
  const replaced = Math.min(endLine, lines.length) - startLine + 1;
  const next = [...lines.slice(0, startLine - 1), newText, ...lines.slice(Math.min(endLine, lines.length))].join('\n');
  const buf = Buffer.from(next, 'utf8');
  await writeFile(abs, buf);
  return { notePath, bytes: buf.length, replacedLines: replaced };
}

/** Prepend text to the top of a note (above existing content). */
export async function prependToPage(
  vaultDir: string, notePath: string, text: string,
): Promise<{ notePath: string; bytes: number; prepended: number }> {
  const abs = await safeRealpath(vaultDir, safeJoin(vaultDir, notePath));
  let cur;
  try { cur = await readFile(abs); }
  catch { throw new VaultFsError(`note not found: ${notePath}`, 'ENOTFOUND'); }
  const add = Buffer.from(text, 'utf8');
  const next = Buffer.concat([add, cur]);
  await writeFile(abs, next);
  return { notePath, bytes: next.length, prepended: add.length };
}

/** Extract every fenced code block from a note. Returns [{lang, code, startLine}]. */
export async function extractCode(
  vaultDir: string, notePath: string,
): Promise<{ notePath: string; blocks: Array<{ lang: string; code: string; startLine: number }> }> {
  const { text } = await readPage(vaultDir, notePath);
  const lines = text.split(/\r?\n/);
  const blocks: Array<{ lang: string; code: string; startLine: number }> = [];
  let i = 0;
  while (i < lines.length) {
    const open = /^```(\w*)\s*$/.exec(lines[i]);
    if (!open) { i += 1; continue; }
    const startLine = i + 1;
    const lang = open[1] || '';
    const body: string[] = [];
    i += 1;
    while (i < lines.length && !/^```\s*$/.test(lines[i])) { body.push(lines[i]); i += 1; }
    blocks.push({ lang, code: body.join('\n'), startLine });
    i += 1;
  }
  return { notePath, blocks };
}

/** Restore a soft-deleted note from .trash → original path. Picks the latest trash entry. */
export async function restoreTrashed(
  vaultDir: string, originalPath: string,
): Promise<{ notePath: string; from: string }> {
  if (originalPath.includes('\0')) throw new VaultFsError('path contains NUL', 'EBAD');
  const trashRoot = await safeRealpath(vaultDir, safeJoin(vaultDir, '.trash'));
  let stamps;
  try { stamps = await readdir(trashRoot); } catch { throw new VaultFsError('no .trash', 'ENOTFOUND'); }
  stamps.sort().reverse();
  for (const ts of stamps) {
    const stampDir = join(trashRoot, ts);
    const candidate = resolve(stampDir, originalPath);
    // Containment: candidate must stay inside <trashRoot>/<ts>/ (Fix: review HIGH #1).
    const rel = relative(stampDir, candidate);
    if (rel.startsWith('..') || rel === '..' || rel.split(sep).includes('..')) continue;
    try { await stat(candidate); }
    catch { continue; }
    const dest = await safeRealpath(vaultDir, safeJoin(vaultDir, originalPath));
    await mkdir(dirname(dest), { recursive: true });
    await rename(candidate, dest);
    return { notePath: originalPath, from: relative(vaultDir, candidate) };
  }
  throw new VaultFsError(`no trash entry for ${originalPath}`, 'ENOTFOUND');
}

/** Empty .trash → physically delete every trashed note. Returns count + freed bytes. */
export async function cleanupTrash(
  vaultDir: string,
): Promise<{ removedEntries: number; freedBytes: number }> {
  const trashRoot = await safeRealpath(vaultDir, safeJoin(vaultDir, '.trash'));
  let stamps;
  try { stamps = await readdir(trashRoot); } catch { return { removedEntries: 0, freedBytes: 0 }; }
  let entries = 0;
  let freed = 0;
  // Per-child realpath check → symlinks pointing outside the vault are skipped, not followed.
  const sumDir = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      try { await safeRealpath(vaultDir, p); }
      catch (err) { if ((err as VaultFsError).code === 'EESCAPE') continue; throw err; }
      if (e.isDirectory()) await sumDir(p);
      else { entries += 1; freed += (await stat(p)).size; }
    }
  };
  for (const ts of stamps) {
    const stampDir = join(trashRoot, ts);
    try { await sumDir(stampDir); } catch { /* skip */ }
    // rm w/ recursive but on a path we proved is inside the vault.
    await rm(stampDir, { recursive: true, force: true });
  }
  return { removedEntries: entries, freedBytes: freed };
}

/** Replace every wikilink target across the vault. Renames all [[X]] / [[X|alias]] / [[X#anchor]] → [[Y...]]. */
export async function replaceWikilinkTarget(
  vaultDir: string, oldTarget: string, newTarget: string,
): Promise<{ touched: Array<{ notePath: string; replacements: number }> }> {
  const { walkMarkdown } = await import('./indexer.js');
  const files = await walkMarkdown(vaultDir);
  const oldEsc = oldTarget.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Match the target inside [[...]] only, preserving any |alias or #anchor suffix.
  const re = new RegExp(`\\[\\[${oldEsc}(?=[\\]|#])`, 'g');
  const reExact = new RegExp(`\\[\\[${oldEsc}\\]\\]`, 'g');
  // Replacer fns → newTarget literals (no $&, $1, etc. expansion) — Fix: review hardening #2.
  const repPartial = (): string => `[[${newTarget}`;
  const repExact = (): string => `[[${newTarget}]]`;
  const touched: Array<{ notePath: string; replacements: number }> = [];
  for (const abs of files) {
    const rel = relative(vaultDir, abs);
    const raw = (await readFile(abs)).toString('utf8');
    let next = raw.replace(re, repPartial);
    next = next.replace(reExact, repExact);
    if (next !== raw) {
      const count = (raw.match(re)?.length ?? 0) + (raw.match(reExact)?.length ?? 0);
      await writeFile(abs, Buffer.from(next, 'utf8'));
      touched.push({ notePath: rel, replacements: count });
    }
  }
  return { touched };
}

// Bundle caps → bounded memory + bounded MCP payload (Fix: review MEDIUM #2).
const BUNDLE_MAX_BYTES_PER_NOTE = 500_000;
const BUNDLE_MAX_TOTAL_BYTES = 10_000_000;

/** Export multiple notes as one concatenated markdown bundle. Per-note + total byte cap. */
export async function exportBundle(
  vaultDir: string, notePaths: string[], opts: { separator?: string } = {},
): Promise<{ bundle: string; bytes: number; included: number; truncated: boolean }> {
  const sep = opts.separator ?? '\n\n---\n\n';
  const parts: string[] = [];
  let total = 0;
  let truncated = false;
  for (const np of notePaths) {
    try {
      const { text } = await readPage(vaultDir, np, { byteStart: 0, byteEnd: BUNDLE_MAX_BYTES_PER_NOTE });
      const part = `# ${np}\n\n${text}`;
      const partBytes = Buffer.byteLength(part, 'utf8');
      if (total + partBytes > BUNDLE_MAX_TOTAL_BYTES) { truncated = true; break; }
      parts.push(part);
      total += partBytes + Buffer.byteLength(sep, 'utf8');
    } catch { /* skip missing */ }
  }
  const bundle = parts.join(sep);
  return { bundle, bytes: Buffer.byteLength(bundle, 'utf8'), included: parts.length, truncated };
}

// Per-file read cap shared by analytics tools → bounded heap on giant notes (Fix: review MEDIUM #2,#3,#4).
const MAX_ANALYTICS_READ_BYTES = 1_000_000;
const FRONTMATTER_PROBE_BYTES = 16_384;

/** Parse frontmatter (between leading --- fences). Returns parsed object + body bytes start. */
export async function getFrontmatter(
  vaultDir: string, notePath: string,
): Promise<{ notePath: string; frontmatter: Record<string, unknown>; bodyByteOffset: number }> {
  const abs = await safeRealpath(vaultDir, safeJoin(vaultDir, notePath));
  let raw;
  // 16KB cap — frontmatter is always at top of file → never reach this in practice (Fix: review MEDIUM #3).
  try { raw = (await readFile(abs)).subarray(0, FRONTMATTER_PROBE_BYTES).toString('utf8'); }
  catch { throw new VaultFsError(`note not found: ${notePath}`, 'ENOTFOUND'); }
  const m = /^---\n([\s\S]*?)\n---(\n|$)/.exec(raw);
  if (!m) return { notePath, frontmatter: {}, bodyByteOffset: 0 };
  // Minimal YAML: key: value (string|number|bool|list), no nested objects. Power users use proper YAML libs.
  const fm: Record<string, unknown> = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*?)\s*$/.exec(line);
    if (!kv) continue;
    const k = kv[1]; const v = kv[2];
    if (v === '') fm[k] = '';
    else if (v === 'true') fm[k] = true;
    else if (v === 'false') fm[k] = false;
    else if (v === 'null' || v === '~') fm[k] = null;
    else if (/^-?\d+(\.\d+)?$/.test(v)) fm[k] = Number(v);
    else if (/^\[.*\]$/.test(v)) fm[k] = v.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    else fm[k] = v.replace(/^["']|["']$/g, '');
  }
  return { notePath, frontmatter: fm, bodyByteOffset: Buffer.byteLength(m[0], 'utf8') };
}

// Same shape the parser enforces on read → keeps round-trip honest + blocks injection.
const FM_KEY_RE = /^[A-Za-z_][\w-]*$/;

/** Write frontmatter back. Replaces existing --- block or prepends a new one. */
export async function setFrontmatter(
  vaultDir: string, notePath: string, frontmatter: Record<string, unknown>,
): Promise<{ notePath: string; bytes: number }> {
  // Reject structural-char injection in keys (Fix: review finding #3).
  for (const k of Object.keys(frontmatter)) {
    if (!FM_KEY_RE.test(k)) throw new VaultFsError(`invalid frontmatter key: ${JSON.stringify(k)}`, 'EBAD');
  }
  const abs = await safeRealpath(vaultDir, safeJoin(vaultDir, notePath));
  let raw;
  try { raw = (await readFile(abs)).toString('utf8'); }
  catch { throw new VaultFsError(`note not found: ${notePath}`, 'ENOTFOUND'); }
  const serialize = (v: unknown): string => {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'boolean' || typeof v === 'number') return String(v);
    if (Array.isArray(v)) return `[${v.map((x) => serialize(x)).join(', ')}]`;
    return /^[\w\s.,/:-]+$/.test(String(v)) ? String(v) : JSON.stringify(String(v));
  };
  const lines = Object.entries(frontmatter).map(([k, v]) => `${k}: ${serialize(v)}`);
  const block = `---\n${lines.join('\n')}\n---\n`;
  const body = raw.startsWith('---') ? raw.replace(/^---\n[\s\S]*?\n---\n?/, '') : raw;
  const next = block + body;
  const buf = Buffer.from(next, 'utf8');
  await writeFile(abs, buf);
  return { notePath, bytes: buf.length };
}

/** List non-markdown files (attachments) under the vault. Recursive. Returns relative paths + sizes. */
export async function listAttachments(
  vaultDir: string, folderPath: string = '',
): Promise<{ folderPath: string; attachments: Array<{ path: string; bytes: number; ext: string }> }> {
  const root = await safeRealpath(vaultDir, safeJoin(vaultDir, folderPath));
  const out: Array<{ path: string; bytes: number; ext: string }> = [];
  const walk = async (d: string): Promise<void> => {
    let entries;
    try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = join(d, e.name);
      // Per-child realpath check → symlink escapes the vault (Fix: review finding #2).
      let real;
      try { real = await safeRealpath(vaultDir, p); }
      catch (err) { if ((err as VaultFsError).code === 'EESCAPE') continue; throw err; }
      if (e.isDirectory()) await walk(real);
      else if (e.isFile()) {
        const ext = extname(e.name).toLowerCase();
        if (ext === '.md') continue;
        const s = await stat(real);
        out.push({ path: relative(vaultDir, p), bytes: s.size, ext });
      }
    }
  };
  await walk(root);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return { folderPath, attachments: out };
}

// Hard caps → bound worst-case ReDoS + memory blowup (Fix: review finding #1).
const GREP_MAX_PATTERN_LEN = 256;
const GREP_MAX_FILE_BYTES = 1_000_000;
const GREP_MAX_LINE_LEN = 5000;

// Detect obviously catastrophic backtracking shapes. Conservative; rejects only the worst.
function isLikelyCatastrophic(pat: string): boolean {
  // Nested unbounded quantifiers: (X+)+, (X*)*, (X+)*, (X*)+, (.+)+ etc.
  return /(\([^)]*[+*][^)]*\)[+*])/.test(pat);
}

/** Plain-text grep across the vault. Optional regex. Returns line hits w/ pre/post context. */
export async function grepVault(
  vaultDir: string,
  pattern: string,
  opts: { regex?: boolean; ignoreCase?: boolean; context?: number; pathPrefix?: string; maxHits?: number } = {},
): Promise<{ pattern: string; hits: Array<{ notePath: string; line: number; text: string; before: string[]; after: string[] }> }> {
  if (pattern.length > GREP_MAX_PATTERN_LEN) {
    throw new VaultFsError(`pattern too long (>${GREP_MAX_PATTERN_LEN} chars)`, 'EBAD');
  }
  if (opts.regex && isLikelyCatastrophic(pattern)) {
    throw new VaultFsError('pattern rejected: nested unbounded quantifier (ReDoS shape)', 'EBAD');
  }
  const ctx = Math.max(0, Math.min(opts.context ?? 0, 5));
  const cap = opts.maxHits ?? 200;
  const flags = `g${opts.ignoreCase ? 'i' : ''}`;
  let re: RegExp;
  try {
    re = opts.regex
      ? new RegExp(pattern, flags)
      : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
  } catch (e) { throw new VaultFsError(`bad pattern: ${(e as Error).message}`, 'EBAD'); }
  const { walkMarkdown } = await import('./indexer.js');
  const files = await walkMarkdown(vaultDir);
  const hits: Array<{ notePath: string; line: number; text: string; before: string[]; after: string[] }> = [];
  for (const abs of files) {
    const rel = relative(vaultDir, abs);
    if (opts.pathPrefix && !rel.startsWith(opts.pathPrefix)) continue;
    const s = await stat(abs).catch(() => null);
    if (!s || s.size > GREP_MAX_FILE_BYTES) continue; // skip huge files → bounded memory.
    const lines = (await readFile(abs)).toString('utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const ln = lines[i].length > GREP_MAX_LINE_LEN ? lines[i].slice(0, GREP_MAX_LINE_LEN) : lines[i];
      if (!re.test(ln)) continue;
      re.lastIndex = 0;
      hits.push({
        notePath: rel,
        line: i + 1,
        text: ln,
        before: lines.slice(Math.max(0, i - ctx), i),
        after: lines.slice(i + 1, i + 1 + ctx),
      });
      if (hits.length >= cap) return { pattern, hits };
    }
  }
  return { pattern, hits };
}

/** Word + character count for a note. Whitespace-token approx. */
export async function wordCount(
  vaultDir: string, notePath: string,
): Promise<{ notePath: string; words: number; chars: number; lines: number; bytes: number }> {
  const abs = await safeRealpath(vaultDir, safeJoin(vaultDir, notePath));
  let buf;
  try { buf = await readFile(abs); }
  catch { throw new VaultFsError(`note not found: ${notePath}`, 'ENOTFOUND'); }
  const text = buf.toString('utf8');
  const words = text.split(/\s+/).filter(Boolean).length;
  const chars = [...text].length;
  const lines = text.split(/\r?\n/).length;
  return { notePath, words, chars, lines, bytes: buf.length };
}

/** Append text to the periodic note for the given period (defaults: daily, today). */
export async function appendToPeriodic(
  vaultDir: string,
  period: 'daily' | 'weekly' | 'monthly' | 'yearly',
  text: string,
  opts: { date?: string; folder?: string; template?: string } = {},
): Promise<{ notePath: string; bytes: number; appended: number; created: boolean }> {
  const d = opts.date ? new Date(opts.date) : new Date();
  if (Number.isNaN(d.getTime())) throw new VaultFsError(`bad date: ${opts.date}`, 'EBAD');
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const weekOf = (dt: Date): string => {
    const t = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()));
    const day = (t.getUTCDay() + 6) % 7;
    t.setUTCDate(t.getUTCDate() - day + 3);
    const jan4 = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
    const week = 1 + Math.round(((t.getTime() - jan4.getTime()) / 86_400_000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
    return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
  };
  const stem = period === 'daily' ? `${yyyy}-${mm}-${dd}`
    : period === 'weekly' ? weekOf(d)
    : period === 'monthly' ? `${yyyy}-${mm}`
    : `${yyyy}`;
  const notePath = (opts.folder ? `${opts.folder.replace(/\/$/, '')}/` : '') + `${stem}.md`;
  let created = false;
  try { await readPage(vaultDir, notePath); }
  catch {
    await createPage(vaultDir, notePath, opts.template ?? `# ${stem}\n\n`);
    created = true;
  }
  const r = await appendToPage(vaultDir, notePath, text);
  return { ...r, created };
}

/** Diff two notes (line-based unified). Caps at 200 lines either side → token-efficient. */
const DIFF_MAX_BYTES_PER_SIDE = 2_000_000;
export async function diffNotes(
  vaultDir: string, a: string, b: string,
): Promise<{ a: string; b: string; same: boolean; addedLines: number; removedLines: number; diff: string }> {
  // Byte-cap each side → avoid OOM on a giant note (Fix: review finding #4).
  const ra = (await readPage(vaultDir, a, { byteStart: 0, byteEnd: DIFF_MAX_BYTES_PER_SIDE })).text;
  const rb = (await readPage(vaultDir, b, { byteStart: 0, byteEnd: DIFF_MAX_BYTES_PER_SIDE })).text;
  if (ra === rb) return { a, b, same: true, addedLines: 0, removedLines: 0, diff: '' };
  const la = ra.split(/\r?\n/);
  const lb = rb.split(/\r?\n/);
  // O(N+M) line set diff — keeps it cheap. Exact tokens preserved as-is.
  const setA = new Set(la);
  const removed = la.filter((line) => !lb.includes(line));
  const added = lb.filter((line) => !setA.has(line));
  const cap = 200;
  const out = [
    ...removed.slice(0, cap).map((l) => `- ${l}`),
    ...added.slice(0, cap).map((l) => `+ ${l}`),
  ].join('\n');
  return { a, b, same: false, addedLines: added.length, removedLines: removed.length, diff: out };
}

/** Rename one heading by exact text match. Heading depth preserved. */
export async function renameHeading(
  vaultDir: string, notePath: string, oldText: string, newText: string,
): Promise<{ notePath: string; replacements: number; bytes: number }> {
  const abs = await safeRealpath(vaultDir, safeJoin(vaultDir, notePath));
  let raw;
  try { raw = (await readFile(abs)).toString('utf8'); }
  catch { throw new VaultFsError(`note not found: ${notePath}`, 'ENOTFOUND'); }
  const lines = raw.split(/\r?\n/);
  let count = 0;
  const next = lines.map((line) => {
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (m && m[2].trim() === oldText.trim()) { count += 1; return `${m[1]} ${newText.trim()}`; }
    return line;
  }).join('\n');
  const buf = Buffer.from(next, 'utf8');
  if (count > 0) await writeFile(abs, buf);
  return { notePath, replacements: count, bytes: buf.length };
}

/** Copy a note to a new path. Refuses overwrite unless overwrite=true. */
export async function copyPage(
  vaultDir: string, from: string, to: string, opts: { overwrite?: boolean } = {},
): Promise<{ from: string; to: string; bytes: number }> {
  const absFrom = await safeRealpath(vaultDir, safeJoin(vaultDir, from));
  const absTo = await safeRealpath(vaultDir, safeJoin(vaultDir, to));
  let buf;
  try { buf = await readFile(absFrom); }
  catch { throw new VaultFsError(`source not found: ${from}`, 'ENOTFOUND'); }
  if (!opts.overwrite) {
    try { await stat(absTo); throw new VaultFsError(`destination exists: ${to}`, 'EEXISTS'); }
    catch (e) { if ((e as VaultFsError).code === 'EEXISTS') throw e; }
  }
  await mkdir(dirname(absTo), { recursive: true });
  await writeFile(absTo, buf);
  return { from, to, bytes: buf.length };
}

