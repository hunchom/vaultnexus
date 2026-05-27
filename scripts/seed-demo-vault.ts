#!/usr/bin/env tsx
// Replays baked commit timeline → seeded demo vault. Determinism via fixed dates.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, readdirSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface TimelineEntry {
  date: string;
  message: string;
  files: string[];
  // optional path-map: target POSIX path → source path under repoRoot to substitute at this commit
  stanceShift?: Record<string, string>;
}

// scripts/ → repo root
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const SOURCE_VAULT = join(REPO_ROOT, 'demo-vault-seeded');
const TIMELINE_PATH = join(REPO_ROOT, 'docs/seed/commit-timeline.json');

/** Walk dir → POSIX-relative file paths. */
function walk(root: string, sub = ''): string[] {
  const dir = join(root, sub);
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const rel = sub ? `${sub}/${entry}` : entry;
    const abs = join(root, rel);
    if (statSync(abs).isDirectory()) out.push(...walk(root, rel));
    else out.push(rel);
  }
  return out;
}

/** Replay timeline into `target`. Returns absolute target path. */
export function seedDemoVault(target: string): string {
  const absTarget = resolve(target);
  if (existsSync(absTarget)) {
    const contents = readdirSync(absTarget);
    if (contents.length > 0) throw new Error('target must be empty or not exist');
  } else {
    mkdirSync(absTarget, { recursive: true });
  }
  const timeline: TimelineEntry[] = JSON.parse(readFileSync(TIMELINE_PATH, 'utf8'));
  execFileSync('git', ['init', '--initial-branch=main', absTarget], { stdio: 'ignore' });
  for (const entry of timeline) {
    // stage each listed file: substitute from stanceShift map → fall back to canonical source
    for (const relPath of entry.files) {
      const targetPath = join(absTarget, relPath);
      mkdirSync(dirname(targetPath), { recursive: true });
      const stashRel = entry.stanceShift?.[relPath];
      const sourcePath = stashRel ? join(SOURCE_VAULT, stashRel) : join(SOURCE_VAULT, relPath);
      copyFileSync(sourcePath, targetPath);
    }
    execFileSync('git', ['-C', absTarget, 'add', ...entry.files], { stdio: 'ignore' });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_AUTHOR_DATE: entry.date,
      GIT_COMMITTER_DATE: entry.date,
    };
    execFileSync(
      'git',
      ['-C', absTarget, '-c', 'user.email=demo@vaultnexus', '-c', 'user.name=Demo',
        'commit', '--date', entry.date, '-m', entry.message],
      { env, stdio: 'ignore' },
    );
  }
  // sanity: every non-stash note ends up tracked → guards against silent timeline drift
  const allSourceNotes = walk(join(SOURCE_VAULT, 'notes')).map((p) => `notes/${p}`);
  const trackedRaw = execFileSync('git', ['-C', absTarget, 'ls-files'], { encoding: 'utf8' });
  const tracked = new Set(trackedRaw.split('\n').filter(Boolean));
  const missing = allSourceNotes.filter((p) => !tracked.has(p));
  if (missing.length > 0) {
    throw new Error(`timeline missing notes: ${missing.join(', ')}`);
  }
  return absTarget;
}

// CLI entry: `tsx scripts/seed-demo-vault.ts <target>` → seeds, prints abs path
const invokedAsCli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsCli) {
  const target = process.argv[2];
  if (!target) {
    console.error('usage: seed-demo-vault <target-dir>');
    process.exit(2);
  }
  const result = seedDemoVault(target);
  console.log(result);
}
