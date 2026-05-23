import { describe, it, expect } from 'vitest';
import { runEval } from '../../src/eval/harness.js';
import { FakeEmbedder } from '../../src/core/embedder.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function tinyCorpus(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vn-eval-'));
  writeFileSync(join(dir, 'cats.md'), '# Cats\n\nthe quick brown fox jumps\n');
  writeFileSync(join(dir, 'dogs.md'), '# Dogs\n\nlazy hounds sleep all day\n');
  return dir;
}

describe('runEval', () => {
  it('aggregates metrics over queries and corpus', async () => {
    const dir = tinyCorpus();
    const r = await runEval(dir, new FakeEmbedder(64), [
      { query: 'the quick brown fox jumps', relevant: ['cats.md'] },
      { query: 'lazy hounds sleep all day', relevant: ['dogs.md'] },
    ], 5);
    expect(r.queries).toBe(2);
    expect(r.recallAt10).toBeCloseTo(1); // exact text → Fake nails both
    expect(r.mrr).toBeCloseTo(1);
    expect(r.perQuery[0].rankedNotes[0]).toBe('cats.md');
  });
  it('reports a miss as recall 0 for that query', async () => {
    const dir = tinyCorpus();
    const r = await runEval(dir, new FakeEmbedder(64), [
      { query: 'completely unrelated nonexistent words xyzzy', relevant: ['cats.md'] },
    ], 5);
    expect(r.perQuery[0].recall).toBe(0);
  });
});
