import { readdir, readFile } from 'node:fs/promises';
import { join, relative, extname } from 'node:path';
import type { VaultIndex } from './vault-index.js';

/** Absolute paths of .md files under dir, recursive; skips dotfiles/dotdirs (.git, .obsidian). */
export async function walkMarkdown(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function rec(d: string): Promise<void> {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) await rec(p);
      else if (e.isFile() && extname(e.name).toLowerCase() === '.md') out.push(p);
    }
  }
  await rec(dir);
  return out.sort();
}

/** Index every .md note under dir (notePath = path relative to dir). Returns count. */
export async function indexVault(dir: string, index: VaultIndex): Promise<number> {
  const files = await walkMarkdown(dir);
  for (const abs of files) {
    const source = await readFile(abs, 'utf8');
    await index.addNote(relative(dir, abs), source);
  }
  return files.length;
}
