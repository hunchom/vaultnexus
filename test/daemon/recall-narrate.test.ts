import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { seedDemoVault } from '../../scripts/seed-demo-vault.js';
import { VaultIndex } from '../../src/daemon/vault-index.js';
import { FakeEmbedder } from '../../src/core/embedder.js';
import { FakeChatModel } from '../../src/core/fake-chat-model.js';
import type { ChatMessage, ChatModel, ChatComposeOpts } from '../../src/core/chat-model.js';
import { narrateRecallHistory } from '../../src/daemon/recall-narrate.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');

// Walk the seeded vault → list of .md note paths under notes/, POSIX-relative
function listVaultNotes(vaultPath: string): string[] {
  const out = execFileSync('git', ['-C', vaultPath, 'ls-files', 'notes'], { encoding: 'utf8' });
  return out.split('\n').filter((l) => l.endsWith('.md'));
}

// Build a VaultIndex over the seeded vault → index every .md note from working tree
async function buildSeededIndex(
  vaultPath: string,
  chat?: ChatModel,
): Promise<VaultIndex> {
  const idx = new VaultIndex(new FakeEmbedder(64), vaultPath, chat);
  for (const rel of listVaultNotes(vaultPath)) {
    const abs = join(vaultPath, rel);
    if (existsSync(abs)) {
      await idx.addNote(rel, readFileSync(abs, 'utf8'));
    }
  }
  return idx;
}

describe('narrateRecallHistory (orchestrator)', () => {
  let vaultPath: string;
  let cleanupRoot: string;

  beforeAll(() => {
    cleanupRoot = mkdtempSync(join(tmpdir(), 'vn-narrate-'));
    vaultPath = join(cleanupRoot, 'vault');
    seedDemoVault(vaultPath);
  });
  afterAll(() => { rmSync(cleanupRoot, { recursive: true, force: true }); });

  it('< 2 revisions → fallback narration, revisions still returned', async () => {
    // gtd-overview.md has a single commit per the seed timeline
    const idx = await buildSeededIndex(vaultPath, new FakeChatModel());
    const res = await narrateRecallHistory(
      vaultPath,
      new FakeChatModel(),
      'notes/productivity/gtd-overview.md',
    );
    expect(res.narration.startsWith('Note has fewer than two')).toBe(true);
    expect(res.revisions.length).toBe(1);
  });

  it('multi-rev note → calls chat.compose w/ narrate prompt, returns hops chronological', async () => {
    let receivedMsgs: ChatMessage[] | null = null;
    let receivedOpts: ChatComposeOpts | undefined;
    const spy: ChatModel = {
      id: 'spy',
      async compose(msgs, opts) {
        receivedMsgs = msgs;
        receivedOpts = opts;
        return 'spy narration';
      },
    };
    const res = await narrateRecallHistory(
      vaultPath,
      spy,
      'notes/productivity/gtd-effectiveness.md',
      { maxTokens: 400, temperature: 0.2 },
    );
    expect(res.narration).toBe('spy narration');
    expect(res.revisions.length).toBe(3);
    expect(receivedMsgs).not.toBeNull();
    expect(receivedMsgs!.length).toBe(2);
    expect(receivedMsgs![0].role).toBe('system');
    expect(receivedOpts).toEqual({ maxTokens: 400, temperature: 0.2 });
    // returned revisions chronological oldest-first → narration order
    const dates = res.revisions.map((r) => Date.parse(r.commitDate));
    expect(dates).toEqual([...dates].sort((a, b) => a - b));
  });

  it('FakeChatModel echoes the prompt → narration contains [fake-compose]', async () => {
    const res = await narrateRecallHistory(
      vaultPath,
      new FakeChatModel(),
      'notes/productivity/gtd-effectiveness.md',
    );
    expect(res.narration).toContain('[fake-compose]');
    expect(res.revisions.length).toBe(3);
  });

  it('mixed valid + fabricated SHA → invalidShaCitations isolates the fabricated', async () => {
    // pull real shas first → build narration referencing one real prefix + one fake
    const realRevsNewestFirst = execFileSync(
      'git',
      ['-C', vaultPath, 'log', '--follow', '--pretty=format:%H', '--', 'notes/productivity/gtd-effectiveness.md'],
      { encoding: 'utf8' },
    ).trim().split('\n');
    const realShortPrefix = realRevsNewestFirst[0].slice(0, 7);
    const fakeNarration = `Started [sha:${realShortPrefix} @ 2024-03-15] then [sha:badbeef @ 2024-10-22]`;
    const inline: ChatModel = {
      id: 'inline',
      async compose() { return fakeNarration; },
    };
    const res = await narrateRecallHistory(
      vaultPath,
      inline,
      'notes/productivity/gtd-effectiveness.md',
    );
    expect(res.narration).toBe(fakeNarration);
    expect(res.invalidShaCitations).toEqual(['[sha:badbeef @ 2024-10-22]']);
  });

  it('all-valid SHAs → invalidShaCitations is empty', async () => {
    const realRevsNewestFirst = execFileSync(
      'git',
      ['-C', vaultPath, 'log', '--follow', '--pretty=format:%H', '--', 'notes/productivity/gtd-effectiveness.md'],
      { encoding: 'utf8' },
    ).trim().split('\n');
    const a = realRevsNewestFirst[0].slice(0, 7);
    const b = realRevsNewestFirst[1].slice(0, 7);
    const inline: ChatModel = {
      id: 'inline',
      async compose() { return `[sha:${a} @ 2024-03-15] then [sha:${b} @ 2024-06-10]`; },
    };
    const res = await narrateRecallHistory(
      vaultPath,
      inline,
      'notes/productivity/gtd-effectiveness.md',
    );
    expect(res.invalidShaCitations).toEqual([]);
  });

  it('< 2 revisions fallback → invalidShaCitations is empty', async () => {
    const res = await narrateRecallHistory(
      vaultPath,
      new FakeChatModel(),
      'notes/productivity/gtd-overview.md',
    );
    expect(res.narration.startsWith('Note has fewer than two')).toBe(true);
    expect(res.invalidShaCitations).toEqual([]);
  });
});

describe('VaultIndex.narrateHistory', () => {
  let vaultPath: string;
  let cleanupRoot: string;

  beforeAll(() => {
    cleanupRoot = mkdtempSync(join(tmpdir(), 'vn-narrate-vi-'));
    vaultPath = join(cleanupRoot, 'vault');
    seedDemoVault(vaultPath);
  });
  afterAll(() => { rmSync(cleanupRoot, { recursive: true, force: true }); });

  it('throws when no ChatModel injected', async () => {
    const idx = await buildSeededIndex(vaultPath /* no chat */);
    await expect(
      idx.narrateHistory('notes/productivity/gtd-effectiveness.md'),
    ).rejects.toThrow(/ChatModel/);
  });

  it('multi-rev note → narration contains [fake-compose], revisions=3 chronological', async () => {
    const idx = await buildSeededIndex(vaultPath, new FakeChatModel());
    const res = await idx.narrateHistory('notes/productivity/gtd-effectiveness.md');
    expect(res.revisions.length).toBe(3);
    expect(res.narration).toContain('[fake-compose]');
    const dates = res.revisions.map((r) => Date.parse(r.commitDate));
    expect(dates).toEqual([...dates].sort((a, b) => a - b));
  });

  it('single-rev note → fallback string, revisions length 1', async () => {
    const idx = await buildSeededIndex(vaultPath, new FakeChatModel());
    const res = await idx.narrateHistory('notes/productivity/gtd-overview.md');
    expect(res.narration.startsWith('Note has fewer than two')).toBe(true);
    expect(res.revisions.length).toBe(1);
    expect(res.invalidShaCitations).toEqual([]);
  });

  it('FakeChatModel (no SHA markers in output) → invalidShaCitations empty', async () => {
    const idx = await buildSeededIndex(vaultPath, new FakeChatModel());
    const res = await idx.narrateHistory('notes/productivity/gtd-effectiveness.md');
    expect(res.invalidShaCitations).toEqual([]);
  });
});
