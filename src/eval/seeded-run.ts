#!/usr/bin/env node
/** Plan 22 CLI — `pnpm eval:seeded` runs the paraphrase eval against the seeded Plan 14
 *  vault (30 notes, 3 communities). Prints recall@1/3/10, nDCG@10, MRR + per-query rows.
 *
 *  Env:
 *    VAULTNEXUS_EVAL_FTS_ONLY=1  → vector path short-circuited; FTS5+RRF ranks. Used
 *                                  to measure lexical leakage — every query whose
 *                                  target retrieves under this mode is a leaky one.
 *    VAULTNEXUS_EVAL_MIN_RECALL  → gate recall@1 floor (exit 1 if below).
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectEmbedder } from '../daemon/select-embedder.js';
import { runSeededEval } from './seeded-harness.js';
import { SEEDED_GOLD_QUERIES } from './seeded-gold.js';

/** Parse env-var truthiness for VAULTNEXUS_EVAL_FTS_ONLY. Returns true | false | 'invalid'.
 *  Accepts 1/true/yes/on (true), 0/false/no/off/'' (false), case-insensitive, trimmed.
 *  Anything else → 'invalid' → caller exits 2 with a clear diagnostic. */
export function parseFtsOnly(raw: string | undefined): boolean | 'invalid' {
  const v = (raw ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['', '0', 'false', 'no', 'off'].includes(v)) return false;
  return 'invalid';
}

const rawMin = process.env.VAULTNEXUS_EVAL_MIN_RECALL;
const THRESHOLD = Number(rawMin ?? 0);
if (rawMin !== undefined && Number.isNaN(THRESHOLD)) {
  process.stderr.write(`eval:seeded: VAULTNEXUS_EVAL_MIN_RECALL='${rawMin}' not a number\n`);
  process.exit(1);
}
const FTS_ONLY_PARSED = parseFtsOnly(process.env.VAULTNEXUS_EVAL_FTS_ONLY);
if (FTS_ONLY_PARSED === 'invalid') {
  process.stderr.write(
    `eval:seeded: VAULTNEXUS_EVAL_FTS_ONLY='${process.env.VAULTNEXUS_EVAL_FTS_ONLY}' not recognized — expected 1/true/yes/on or 0/false/no/off\n`,
  );
  process.exit(2);
}
const FTS_ONLY = FTS_ONLY_PARSED;

async function main(): Promise<void> {
  // seed script lives outside src/ → spawn it instead of importing across rootDir boundary.
  // Dual-resolution: dist/eval/seeded-run.js needs ../../scripts; src/eval/seeded-run.ts (tsx) needs ../../scripts.
  const here = dirname(fileURLToPath(import.meta.url));
  const seedScript = resolve(here, '../../scripts/seed-demo-vault.ts');
  const vaultDir = mkdtempSync(join(tmpdir(), 'vn-eval-seeded-'));
  try {
    execFileSync('npx', ['tsx', seedScript, vaultDir], { stdio: 'ignore' });
    const embedder = await selectEmbedder();
    const isFake = embedder.constructor.name === 'FakeEmbedder';
    process.stderr.write(
      `eval:seeded: embedder=${embedder.constructor.name} dims=${embedder.dimensions} ftsOnly=${FTS_ONLY}\n`,
    );

    const r = await runSeededEval(vaultDir, embedder, SEEDED_GOLD_QUERIES, { ftsOnly: FTS_ONLY });
    const ec = embedder as { close?: () => void };
    if (typeof ec.close === 'function') ec.close();
    process.stdout.write(
      `\nqueries=${r.queries}  recall@1=${r.recallAt1.toFixed(3)}  recall@3=${r.recallAt3.toFixed(3)}` +
        `  recall@10=${r.recallAt10.toFixed(3)}  nDCG@10=${r.ndcgAt10.toFixed(3)}  MRR=${r.mrr.toFixed(3)}\n\n`,
    );
    for (const p of r.perQuery) {
      const tag = p.recall1 > 0 ? 'TOP1 ' : p.recall10 > 0 ? 'top-k' : 'MISS ';
      process.stdout.write(
        `  ${tag} rr=${p.rr.toFixed(2)}  ${p.query.slice(0, 100)}\n` +
          `         → ${p.rankedNotes.slice(0, 3).join(', ') || '(none)'}\n` +
          `         ★ ${p.targets.join(', ')}\n`,
      );
    }
    if (isFake && !FTS_ONLY) {
      process.stderr.write(
        '\neval:seeded: FakeEmbedder is non-semantic — paraphrase recall expected low. Set VAULTNEXUS_EMBED_* for a real run.\n',
      );
    }
    if (THRESHOLD > 0 && r.recallAt1 < THRESHOLD) {
      process.stderr.write(`\neval:seeded: recall@1 ${r.recallAt1.toFixed(3)} < threshold ${THRESHOLD}\n`);
      process.exit(1);
    }
  } finally {
    rmSync(vaultDir, { recursive: true, force: true });
  }
}

// Entrypoint guard: only run main() when invoked as a CLI, not when imported
// by tests for parseFtsOnly. Compares import.meta.url to process.argv[1] URL.
const invokedAsCli =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedAsCli) {
  main().catch((e) => {
    process.stderr.write(`eval:seeded: fatal ${String(e)}\n`);
    process.exit(1);
  });
}
