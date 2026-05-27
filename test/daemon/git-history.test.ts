import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { noteRevisions, isGitRepo, noteContentAt } from '../../src/daemon/git-history.js';
import { VaultIndex } from '../../src/daemon/vault-index.js';
import { FakeEmbedder } from '../../src/core/embedder.js';

// Seed a deterministic 3-commit history on `notes/a.md` w/ ISO commit dates.
function seedRepo(): { repo: string; cleanup: () => void } {
  const repo = mkdtempSync(join(tmpdir(), 'vn-git-'));
  execFileSync('git', ['init', '--initial-branch=main', repo]);
  mkdirSync(join(repo, 'notes'));
  const env = (date: string): NodeJS.ProcessEnv => ({
    ...process.env,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
    GIT_AUTHOR_NAME: 'T',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 'T',
    GIT_COMMITTER_EMAIL: 't@t',
  });
  const commit = (msg: string, date: string): void => {
    execFileSync('git', ['-C', repo, 'add', '.']);
    execFileSync(
      'git',
      ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-m', msg],
      { env: env(date) },
    );
  };
  writeFileSync(join(repo, 'notes/a.md'), 'first\n');
  commit('c1', '2024-01-01T00:00:00Z');
  writeFileSync(join(repo, 'notes/a.md'), '---\ndate: 2024-02-15\n---\n# Hello\nsecond\n');
  commit('c2', '2024-02-01T00:00:00Z');
  writeFileSync(join(repo, 'notes/a.md'), 'third\n');
  commit('c3', '2024-03-01T00:00:00Z');
  return { repo, cleanup: () => rmSync(repo, { recursive: true, force: true }) };
}

describe('git-history', () => {
  let fx: { repo: string; cleanup: () => void };
  beforeAll(() => { fx = seedRepo(); });
  afterAll(() => { fx.cleanup(); });

  it('isGitRepo: true inside a git worktree, false elsewhere', async () => {
    expect(await isGitRepo(fx.repo)).toBe(true);
    const nonGit = mkdtempSync(join(tmpdir(), 'vn-nogit-'));
    try { expect(await isGitRepo(nonGit)).toBe(false); }
    finally { rmSync(nonGit, { recursive: true, force: true }); }
  });

  it('noteContentAt: snapshot of the 2nd commit (newest-first index 1) matches seeded content', async () => {
    const revs = await noteRevisions(fx.repo, 'notes/a.md');
    // newest-first: [c3, c2, c1] → 2nd commit = revs[1]
    const content = await noteContentAt(fx.repo, revs[1].sha, 'notes/a.md');
    expect(content).toBe('---\ndate: 2024-02-15\n---\n# Hello\nsecond\n');
  });

  it('noteRevisions w/ withContent: snapshot + frontmatterDate on the c2 revision', async () => {
    const revs = await noteRevisions(fx.repo, 'notes/a.md', { withContent: true });
    expect(revs.length).toBe(3);
    // c2 lives at index 1 (newest-first); has frontmatter `date: 2024-02-15`
    expect(revs[1].content).toBe('---\ndate: 2024-02-15\n---\n# Hello\nsecond\n');
    expect(revs[1].frontmatterDate).toBeDefined();
    expect(revs[1].frontmatterDate!.startsWith('2024-02-15')).toBe(true);
    // c1 + c3 have no frontmatter → undefined
    expect(revs[0].frontmatterDate).toBeUndefined();
    expect(revs[2].frontmatterDate).toBeUndefined();
  });

  it('noteRevisions: 3 revisions, descending by commitDate, valid sha + ISO', async () => {
    const revs = await noteRevisions(fx.repo, 'notes/a.md');
    expect(revs.length).toBe(3);
    for (const r of revs) {
      expect(r.sha).toMatch(/^[0-9a-f]{40}$/);
      expect(Number.isNaN(Date.parse(r.commitDate))).toBe(false);
      expect(r.message).toBeTruthy();
      expect(r.authorEmail).toBe('t@t');
    }
    const dates = revs.map((r) => Date.parse(r.commitDate));
    expect(dates).toEqual([...dates].sort((a, b) => b - a));
  });
});

describe('git-history edge cases', () => {
  it('noteRevisions: [] when repoPath is not a git worktree', async () => {
    const nonGit = mkdtempSync(join(tmpdir(), 'vn-edge-nogit-'));
    try { expect(await noteRevisions(nonGit, 'notes/a.md')).toEqual([]); }
    finally { rmSync(nonGit, { recursive: true, force: true }); }
  });

  it('noteRevisions: [] for a file never committed', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'vn-edge-uncommitted-'));
    try {
      execFileSync('git', ['init', '--initial-branch=main', repo]);
      mkdirSync(join(repo, 'notes'));
      writeFileSync(join(repo, 'notes/a.md'), 'never committed\n');
      expect(await noteRevisions(repo, 'notes/a.md')).toEqual([]);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it('noteRevisions: maxRevisions caps the returned slice', async () => {
    const fx = seedRepo();
    try {
      const revs = await noteRevisions(fx.repo, 'notes/a.md', { maxRevisions: 2 });
      expect(revs.length).toBe(2);
    } finally { fx.cleanup(); }
  });

  it('noteRevisions: since filter excludes earlier commits', async () => {
    const fx = seedRepo();
    try {
      // since=2024-02-15 → only c3 (2024-03-01) passes; c1 (2024-01-01) + c2 (2024-02-01) excluded
      const revs = await noteRevisions(fx.repo, 'notes/a.md', { since: '2024-02-15' });
      expect(revs.length).toBe(1);
      expect(Date.parse(revs[0].commitDate)).toBeGreaterThan(Date.parse('2024-02-15'));
    } finally { fx.cleanup(); }
  });

  it('returns [] when repo has commits but the file is not tracked', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'vn-edge-absent-'));
    try {
      execFileSync('git', ['init', '--initial-branch=main', repo]);
      writeFileSync(join(repo, 'other.md'), 'hello\n');
      execFileSync('git', ['-C', repo, 'add', '.']);
      execFileSync(
        'git',
        ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-m', 'init'],
      );
      const revs = await noteRevisions(repo, 'absent.md');
      expect(revs).toEqual([]);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it('noteRevisions: until filter excludes later commits', async () => {
    const fx = seedRepo();
    try {
      // until=2024-02-15 → c1 (2024-01-01) + c2 (2024-02-01) pass; c3 (2024-03-01) excluded
      const revs = await noteRevisions(fx.repo, 'notes/a.md', { until: '2024-02-15' });
      expect(revs.length).toBe(2);
      for (const r of revs) {
        expect(Date.parse(r.commitDate)).toBeLessThan(Date.parse('2024-02-15'));
      }
    } finally { fx.cleanup(); }
  });

  it('withContent on renamed file returns partial content (pre-rename revisions content undefined, no crash)', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'vn-edge-rename-content-'));
    try {
      execFileSync('git', ['init', '--initial-branch=main', repo]);
      mkdirSync(join(repo, 'notes'));
      const env = (d: string): NodeJS.ProcessEnv => ({
        ...process.env,
        GIT_AUTHOR_DATE: d, GIT_COMMITTER_DATE: d,
        GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t',
      });
      // c1: notes/a.md = "v1 alpha"
      writeFileSync(join(repo, 'notes/a.md'), 'v1 alpha\n');
      execFileSync('git', ['-C', repo, 'add', '.']);
      execFileSync(
        'git',
        ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-m', 'add a'],
        { env: env('2024-01-01T00:00:00Z') },
      );
      // c2: git mv notes/a.md notes/b.md (no content change)
      execFileSync('git', ['-C', repo, 'mv', 'notes/a.md', 'notes/b.md']);
      execFileSync(
        'git',
        ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-m', 'rename a→b'],
        { env: env('2024-02-01T00:00:00Z') },
      );
      // c3: modify notes/b.md → "v2 beta"
      writeFileSync(join(repo, 'notes/b.md'), 'v2 beta\n');
      execFileSync('git', ['-C', repo, 'add', '.']);
      execFileSync(
        'git',
        ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-m', 'modify b'],
        { env: env('2024-03-01T00:00:00Z') },
      );
      const revs = await noteRevisions(repo, 'notes/b.md', { withContent: true });
      expect(revs.length).toBe(3);
      // post-rename revision → content "v2 beta"
      const hasV2 = revs.some((r) => r.content !== undefined && r.content.includes('v2 beta'));
      expect(hasV2).toBe(true);
      // pre-rename revision → git show <sha>:notes/b.md fails → content undefined
      const hasUndefined = revs.some((r) => r.content === undefined);
      expect(hasUndefined).toBe(true);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it('noteRevisions: --follow surfaces history across renames', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'vn-edge-rename-'));
    try {
      execFileSync('git', ['init', '--initial-branch=main', repo]);
      mkdirSync(join(repo, 'notes'));
      const env = (d: string): NodeJS.ProcessEnv => ({
        ...process.env,
        GIT_AUTHOR_DATE: d, GIT_COMMITTER_DATE: d,
        GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t',
      });
      writeFileSync(join(repo, 'notes/a.md'), 'A\n');
      execFileSync('git', ['-C', repo, 'add', '.']);
      execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-m', 'add a'],
        { env: env('2024-01-01T00:00:00Z') });
      renameSync(join(repo, 'notes/a.md'), join(repo, 'notes/b.md'));
      execFileSync('git', ['-C', repo, 'add', '-A']);
      execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-m', 'rename a→b'],
        { env: env('2024-02-01T00:00:00Z') });
      const revs = await noteRevisions(repo, 'notes/b.md');
      expect(revs.length).toBe(2);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
});

describe('VaultIndex.history', () => {
  let fx: { repo: string; cleanup: () => void };
  beforeAll(() => { fx = seedRepo(); });
  afterAll(() => { fx.cleanup(); });

  it('returns [] when vaultPath is unset', async () => {
    const idx = new VaultIndex(new FakeEmbedder(32));
    expect(await idx.history('notes/a.md')).toEqual([]);
  });

  it('returns revisions when vaultPath points at a git repo', async () => {
    const idx = new VaultIndex(new FakeEmbedder(32), fx.repo);
    await idx.addNote('notes/a.md', 'third\n');
    const revs = await idx.history('notes/a.md');
    expect(revs.length).toBe(3);
    expect(revs[0].sha).toMatch(/^[0-9a-f]{40}$/);
  });
});

export { seedRepo };
