/** Plan 22 — harness behavior + leakage-floor regression.
 *  T2 path: harness runs to completion against seeded vault → well-formed metrics.
 *  T3 path: with vector path neutralized (ConstantEmbedder), recall@1 stays well below
 *           the saturation point — FTS5 alone must NOT carry the corpus. Plan 09 rule.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeEmbedder } from '../../src/core/embedder.js';
import { seedDemoVault } from '../../scripts/seed-demo-vault.js';
import { runSeededEval, ConstantEmbedder } from '../../src/eval/seeded-harness.js';
import { SEEDED_GOLD_QUERIES } from '../../src/eval/seeded-gold.js';

describe('runSeededEval against Plan 14 seeded vault', () => {
  let vaultDir: string;

  beforeAll(() => {
    vaultDir = mkdtempSync(join(tmpdir(), 'vn-seeded-harness-'));
    seedDemoVault(vaultDir);
  });

  afterAll(() => {
    rmSync(vaultDir, { recursive: true, force: true });
  });

  it('runs to completion → emits a metrics object with all 5 headline fields', async () => {
    const r = await runSeededEval(vaultDir, new FakeEmbedder(64), SEEDED_GOLD_QUERIES);
    expect(r.queries).toBe(SEEDED_GOLD_QUERIES.length);
    for (const m of [r.recallAt1, r.recallAt3, r.recallAt10, r.ndcgAt10, r.mrr]) {
      expect(typeof m).toBe('number');
      expect(m).toBeGreaterThanOrEqual(0);
      expect(m).toBeLessThanOrEqual(1);
    }
    expect(r.perQuery).toHaveLength(SEEDED_GOLD_QUERIES.length);
    expect(r.recallAt1).toBeLessThanOrEqual(r.recallAt3);
    expect(r.recallAt3).toBeLessThanOrEqual(r.recallAt10);
  });

  it('ftsOnly mode → recall@1 < 0.4 (lexical leakage floor; vector half must do the lift)', async () => {
    // ConstantEmbedder degenerates the vector ranker → RRF fusion is FTS-driven.
    // If FTS5 alone retrieves a target's host note at rank 1 for ≥40% of queries,
    // the corpus has too much lexical overlap and Plan 25 router lift would be drowned.
    const r = await runSeededEval(vaultDir, new FakeEmbedder(64), SEEDED_GOLD_QUERIES, {
      ftsOnly: true,
    });
    expect(r.recallAt1).toBeLessThan(0.4);
  });

  it('ConstantEmbedder collapses vector path → multiple chunks share max cosine', async () => {
    // Sanity check on the leakage probe → constant vectors produce constant cosine,
    // so any ranking signal is FTS5 RRF. Without this property, T3's interpretation breaks.
    const ce = new ConstantEmbedder(8);
    const [a, b] = await ce.embed(['hello', 'world']);
    expect(a).toEqual(b);
  });
});
