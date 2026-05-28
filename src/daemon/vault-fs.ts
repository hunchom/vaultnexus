// Filesystem ops scoped to a vault root. Every public fn re-resolves the input
// under vaultDir + asserts no escape → no path traversal via .. or absolute paths.
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve, dirname, extname, sep } from 'node:path';

export class VaultFsError extends Error {
  constructor(message: string, public readonly code: 'ENOTFOUND' | 'EEXISTS' | 'EESCAPE' | 'EBAD' | 'EFAIL') {
    super(message);
    this.name = 'VaultFsError';
  }
}

function safeJoin(vaultDir: string, p: string): string {
  if (typeof p !== 'string') throw new VaultFsError('path required', 'EBAD');
  const norm = p.replace(/^\/+/, '');                 // strip leading / → vault-relative
  const abs = resolve(vaultDir, norm);
  const rel = relative(vaultDir, abs);
  if (rel.startsWith('..') || rel === '..' || rel.split(sep).includes('..')) {
    throw new VaultFsError(`path escapes vault: ${p}`, 'EESCAPE');
  }
  return abs;
}

export interface DirEntry { name: string; path: string; kind: 'note' | 'folder' | 'other'; }
export interface VaultListing {
  cwd: string;
  folders: string[];
  notes: string[];
}

/** List contents of a folder (relative to vault root). Skips dotfiles/dotdirs. */
export async function listFolder(vaultDir: string, p: string = ''): Promise<VaultListing> {
  const abs = safeJoin(vaultDir, p);
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
  const abs = safeJoin(vaultDir, notePath);
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
  const abs = safeJoin(vaultDir, notePath);
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
  const abs = safeJoin(vaultDir, folderPath);
  await mkdir(abs, { recursive: true });
  return { folderPath };
}

/** Append text to an existing note. Returns new size. */
export async function appendToPage(
  vaultDir: string, notePath: string, text: string,
): Promise<{ notePath: string; bytes: number; appended: number }> {
  const abs = safeJoin(vaultDir, notePath);
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
  const abs = safeJoin(vaultDir, notePath);
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
  return { notePath, bytes: buf.length, insertedAtByte: Buffer.byteLength(pre, 'utf8') + 1 };
}

/** Replace first or all occurrences of literal `find` with `replace`. */
export async function replaceInPage(
  vaultDir: string, notePath: string, find: string, replace: string, opts: { all?: boolean } = {},
): Promise<{ notePath: string; replacements: number; bytes: number }> {
  const abs = safeJoin(vaultDir, notePath);
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
  const abs = safeJoin(vaultDir, notePath);
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
  const abs = safeJoin(vaultDir, folderPath);
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
  const absFrom = safeJoin(vaultDir, from);
  const absTo = safeJoin(vaultDir, to);
  try { await stat(absFrom); }
  catch { throw new VaultFsError(`source not found: ${from}`, 'ENOTFOUND'); }
  try { await stat(absTo); throw new VaultFsError(`destination exists: ${to}`, 'EEXISTS'); }
  catch (e) { if ((e as VaultFsError).code === 'EEXISTS') throw e; /* ENOENT → ok */ }
  await mkdir(dirname(absTo), { recursive: true });
  await rename(absFrom, absTo);
  return { from, to };
}

/** Rename one heading by exact text match. Heading depth preserved. */
export async function renameHeading(
  vaultDir: string, notePath: string, oldText: string, newText: string,
): Promise<{ notePath: string; replacements: number; bytes: number }> {
  const abs = safeJoin(vaultDir, notePath);
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
  const absFrom = safeJoin(vaultDir, from);
  const absTo = safeJoin(vaultDir, to);
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

