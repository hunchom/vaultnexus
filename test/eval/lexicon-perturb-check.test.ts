import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { seedDemoVault } from '../../scripts/seed-demo-vault.js';
import { runLexiconPerturbCheck, jaccard } from '../../src/eval/lexicon-perturb-check.js';

const exec = promisify(execFile);

describe('jaccard()', () => {
  it('identical sets → 1', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(1);
  });
  it('disjoint sets → 0', () => {
    expect(jaccard(new Set(['a']), new Set(['b']))).toBe(0);
  });
  it('both empty → 1 (vacuous identity)', () => {
    expect(jaccard(new Set(), new Set())).toBe(1);
  });
  it('one empty, other non-empty → 0', () => {
    expect(jaccard(new Set(), new Set(['a']))).toBe(0);
  });
  it('half overlap → 1/3', () => {
    // |{a}| / |{a,b,c}| = 1/3
    expect(jaccard(new Set(['a', 'b']), new Set(['a', 'c']))).toBeCloseTo(1 / 3, 5);
  });
});

describe('runLexiconPerturbCheck on seeded Plan 14 vault', () => {
  let vaultDir: string;

  beforeAll(() => {
    vaultDir = mkdtempSync(join(tmpdir(), 'vn-lex-perturb-'));
    seedDemoVault(vaultDir);
  });

  it('completes without errors and emits well-formed report', async () => {
    const report = await runLexiconPerturbCheck(vaultDir, 5);
    expect(report.perturbations).toBe(5);
    expect(report.byPerturbation).toHaveLength(5);
    // jaccard summary bounded [0,1]
    expect(report.jaccardMean).toBeGreaterThanOrEqual(0);
    expect(report.jaccardMean).toBeLessThanOrEqual(1);
    expect(report.jaccardMin).toBeGreaterThanOrEqual(0);
    expect(report.jaccardMax).toBeLessThanOrEqual(1);
  });

  it('baseline flags include gtd-effectiveness (Plan 14 canonical stance-shift)', async () => {
    const report = await runLexiconPerturbCheck(vaultDir, 5);
    const baseline = report.byPerturbation.find((p) => p.id === 'v1');
    expect(baseline).toBeDefined();
    expect(baseline!.flagged).toContain('notes/productivity/gtd-effectiveness.md');
    expect(baseline!.jaccard).toBe(1); // baseline vs baseline → identical
    expect(report.baselineFlagged).toBeGreaterThanOrEqual(1);
  });

  it('perturbations preserving "essential"/"must"/"only" still flag gtd-effectiveness', async () => {
    // demo fixture's shift uses essential/must/only → dropping a hedge word (which isn't in the
    // final revision much) should NOT remove the flag. drop-hedge-0 drops 'maybe' (position 0).
    const report = await runLexiconPerturbCheck(vaultDir, 10);
    const dropHedge = report.byPerturbation.find((p) => p.id === 'drop-hedge-0');
    expect(dropHedge).toBeDefined();
    expect(dropHedge!.flagged).toContain('notes/productivity/gtd-effectiveness.md');
  });

  // T4 — CLI smoke: tsx invocation of the harness emits parseable JSON
  it('CLI invocation prints parseable JSON', async () => {
    const cliPath = resolve(__dirname, '../../src/eval/lexicon-perturb-check.ts');
    const tsxBin = resolve(__dirname, '../../node_modules/.bin/tsx');
    const { stdout } = await exec(tsxBin, [cliPath, vaultDir, '5'], { maxBuffer: 4 * 1024 * 1024 });
    const parsed = JSON.parse(stdout);
    expect(parsed.perturbations).toBe(5);
    expect(Array.isArray(parsed.byPerturbation)).toBe(true);
    expect(typeof parsed.jaccardMean).toBe('number');
  }, 30_000);
});
