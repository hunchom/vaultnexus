import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';

const exec = promisify(execFile);

describe('reason-stream-cli (Plan 23)', () => {
  let vaultDir: string;

  beforeAll(() => {
    vaultDir = mkdtempSync(join(tmpdir(), 'vn-reason-stream-cli-'));
    mkdirSync(join(vaultDir, 'gtd'), { recursive: true });
    writeFileSync(
      join(vaultDir, 'gtd/inbox.md'),
      '# Inbox\n\nGTD says capture everything in one trusted place\n',
      'utf8',
    );
    writeFileSync(
      join(vaultDir, 'gtd/review.md'),
      '# Weekly Review\n\nWeekly review keeps the GTD system trustworthy\n\nlink [[inbox]]\n',
      'utf8',
    );
  });

  it('prints streamed text + final hops/invalidCitations footer + exits 0', async () => {
    const cliPath = resolve(__dirname, '../../src/eval/reason-stream-cli.ts');
    const tsxBin = resolve(__dirname, '../../node_modules/.bin/tsx');
    const { stdout, stderr } = await exec(
      tsxBin,
      [cliPath, 'What about GTD?', '--vault', vaultDir],
      { maxBuffer: 4 * 1024 * 1024, env: { ...process.env, VAULTNEXUS_CHAT_PROVIDER: 'fake' } },
    );
    // body → something streamed (FakeChatModel echoes user content which contains question)
    expect(stdout.length).toBeGreaterThan(0);
    // footer line shape: "---\nhops: N, invalidCitations: M\n"
    expect(stdout).toMatch(/\n---\nhops: \d+, invalidCitations: \d+\n?$/);
    // stderr ok for diagnostics, do not assert silence
    expect(stderr).toBeDefined();
  }, 30_000);

  it('missing question arg → exits non-zero with usage', async () => {
    const cliPath = resolve(__dirname, '../../src/eval/reason-stream-cli.ts');
    const tsxBin = resolve(__dirname, '../../node_modules/.bin/tsx');
    await expect(
      exec(tsxBin, [cliPath], { maxBuffer: 1024 * 1024 }),
    ).rejects.toMatchObject({ code: 2 });
  }, 15_000);
});
