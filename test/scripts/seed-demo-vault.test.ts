import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import matter from 'gray-matter';
import { seedDemoVault } from '../../scripts/seed-demo-vault.js';
import { noteRevisions, noteContentAt } from '../../src/daemon/git-history.js';
import { VaultIndex } from '../../src/daemon/vault-index.js';
import { FakeEmbedder } from '../../src/core/embedder.js';

// strong-assertion lexicon → conviction density per spec Task 3 step 1
const LEXICON = ['only', 'always', 'never', 'essential', 'useless', 'must'];

function convictionCount(text: string): number {
  const lower = text.toLowerCase();
  let total = 0;
  for (const w of LEXICON) {
    const m = lower.match(new RegExp(`\\b${w}\\b`, 'g'));
    if (m) total += m.length;
  }
  return total;
}

function listMdFiles(root: string, sub = ''): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(root, sub))) {
    const rel = sub ? `${sub}/${e}` : e;
    if (statSync(join(root, rel)).isDirectory()) out.push(...listMdFiles(root, rel));
    else if (e.endsWith('.md')) out.push(rel);
  }
  return out;
}

describe('seed-demo-vault', () => {
  let target: string;

  beforeAll(() => {
    target = mkdtempSync(join(tmpdir(), 'vn-seed-test-'));
    // mkdtemp creates the dir → seeder accepts empty existing target
    seedDemoVault(target);
  });

  afterAll(() => {
    rmSync(target, { recursive: true, force: true });
  });

  it('seeds the expected note corpus (~30 .md files including productivity/index.md)', () => {
    const mds = listMdFiles(join(target, 'notes'));
    expect(mds.length).toBeGreaterThanOrEqual(29);
    expect(mds).toContain('productivity/index.md');
  });

  it('initializes a git repo with at least 14 commits', () => {
    const head = execFileSync('git', ['-C', target, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    const log = execFileSync('git', ['-C', target, 'log', '--oneline'], { encoding: 'utf8' });
    const count = log.split('\n').filter(Boolean).length;
    expect(count).toBeGreaterThanOrEqual(14);
  });

  it('gtd-effectiveness.md has exactly 3 dated revisions in the expected window', async () => {
    const revs = await noteRevisions(target, 'notes/productivity/gtd-effectiveness.md');
    expect(revs.length).toBe(3);
    // noteRevisions returns newest-first → oldest at end
    const oldest = revs[revs.length - 1];
    const newest = revs[0];
    expect(oldest.commitDate.startsWith('2024-03-15')).toBe(true);
    expect(newest.commitDate.startsWith('2024-10-22')).toBe(true);
  });

  it('conviction-lexicon density strictly increases across r1 → r2 → r3', async () => {
    const revs = await noteRevisions(target, 'notes/productivity/gtd-effectiveness.md');
    // ascending chronological → r1 first
    const chrono = [...revs].sort((a, b) => Date.parse(a.commitDate) - Date.parse(b.commitDate));
    const counts: number[] = [];
    for (const r of chrono) {
      const body = await noteContentAt(target, r.sha, 'notes/productivity/gtd-effectiveness.md');
      expect(body).toBeDefined();
      counts.push(convictionCount(body!));
    }
    expect(counts.length).toBe(3);
    expect(counts[0]).toBeLessThan(counts[1]);
    expect(counts[1]).toBeLessThan(counts[2]);
  });

  it('ai-capabilities-2027.md carries a parseable forecast frontmatter block', () => {
    const src = readFileSync(join(target, 'notes/decisions/ai-capabilities-2027.md'), 'utf8');
    const parsed = matter(src);
    const forecast = (parsed.data as { forecast?: { claim?: string; by?: unknown; marked_at?: unknown } }).forecast;
    expect(forecast).toBeDefined();
    expect(typeof forecast?.claim).toBe('string');
    expect(forecast?.by).toBeDefined();
    expect(forecast?.marked_at).toBeDefined();
  });
});

describe('seed-demo-vault E2E with VaultIndex', () => {
  let target: string;
  let index: VaultIndex;

  beforeAll(async () => {
    target = mkdtempSync(join(tmpdir(), 'vn-seed-e2e-'));
    seedDemoVault(target);
    index = new VaultIndex(new FakeEmbedder(64), target);
    const mds = listMdFiles(join(target, 'notes')).map((p) => `notes/${p}`);
    for (const rel of mds) {
      const src = readFileSync(join(target, rel), 'utf8');
      await index.addNote(rel, src);
    }
  });

  afterAll(() => {
    index.close();
    rmSync(target, { recursive: true, force: true });
  });

  it('VaultIndex.history walks the 3 stance-shift commits end-to-end', async () => {
    const revs = await index.history('notes/productivity/gtd-effectiveness.md');
    expect(revs.length).toBe(3);
  });
});
