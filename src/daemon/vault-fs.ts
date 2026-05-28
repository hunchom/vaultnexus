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

/** Parse frontmatter (between leading --- fences). Returns parsed object + body bytes start. */
export async function getFrontmatter(
  vaultDir: string, notePath: string,
): Promise<{ notePath: string; frontmatter: Record<string, unknown>; bodyByteOffset: number }> {
  const abs = await safeRealpath(vaultDir, safeJoin(vaultDir, notePath));
  let raw;
  try { raw = (await readFile(abs)).toString('utf8'); }
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

/** Write frontmatter back. Replaces existing --- block or prepends a new one. */
export async function setFrontmatter(
  vaultDir: string, notePath: string, frontmatter: Record<string, unknown>,
): Promise<{ notePath: string; bytes: number }> {
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
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) {
        const ext = extname(e.name).toLowerCase();
        if (ext === '.md') continue;
        const s = await stat(p);
        out.push({ path: relative(vaultDir, p), bytes: s.size, ext });
      }
    }
  };
  await walk(root);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return { folderPath, attachments: out };
}

/** Plain-text grep across the vault. Optional regex. Returns line hits w/ pre/post context. */
export async function grepVault(
  vaultDir: string,
  pattern: string,
  opts: { regex?: boolean; ignoreCase?: boolean; context?: number; pathPrefix?: string; maxHits?: number } = {},
): Promise<{ pattern: string; hits: Array<{ notePath: string; line: number; text: string; before: string[]; after: string[] }> }> {
  const ctx = Math.max(0, Math.min(opts.context ?? 0, 5));
  const cap = opts.maxHits ?? 200;
  const flags = `g${opts.ignoreCase ? 'i' : ''}`;
  const re = opts.regex
    ? new RegExp(pattern, flags)
    : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
  const { walkMarkdown } = await import('./indexer.js');
  const files = await walkMarkdown(vaultDir);
  const hits: Array<{ notePath: string; line: number; text: string; before: string[]; after: string[] }> = [];
  for (const abs of files) {
    const rel = relative(vaultDir, abs);
    if (opts.pathPrefix && !rel.startsWith(opts.pathPrefix)) continue;
    const lines = (await readFile(abs)).toString('utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      if (!re.test(lines[i])) continue;
      re.lastIndex = 0;
      hits.push({
        notePath: rel,
        line: i + 1,
        text: lines[i],
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
export async function diffNotes(
  vaultDir: string, a: string, b: string,
): Promise<{ a: string; b: string; same: boolean; addedLines: number; removedLines: number; diff: string }> {
  const ra = (await readPage(vaultDir, a)).text;
  const rb = (await readPage(vaultDir, b)).text;
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

