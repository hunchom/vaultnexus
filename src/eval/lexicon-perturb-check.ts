#!/usr/bin/env node
// Plan 21 — lexicon-perturbation harness (concept §10.9a).
// Measures Jaccard stability of Plan 15 drift-flagged set under small lexicon perturbations.
// NO MCP TOOL — research surface, drift remains gated until §10.9 spike passes.
import { argv, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { relative, resolve } from 'node:path';
import { walkMarkdown } from '../daemon/indexer.js';
import { noteRevisions, noteContentAt } from '../daemon/git-history.js';
import { extractWikilinks } from '../core/wikilinks.js';
import {
  driftFlag,
  HEDGE_WORDS_V1,
  ASSERTION_WORDS_V1,
  type DriftRevision,
} from '../core/drift.js';
import { perturbations, type Perturbation } from '../core/lexicon-perturb.js';

/** Per-perturbation result: which notes fired, and Jaccard vs baseline. */
export interface PerturbationResult {
  id: string;
  flagged: string[];
  jaccard: number;
}

/** Final harness JSON output. */
export interface LexiconPerturbReport {
  perturbations: number;
  baselineFlagged: number;
  jaccardMean: number;
  jaccardMin: number;
  jaccardMax: number;
  byPerturbation: PerturbationResult[];
}

/** Jaccard sim |A∩B|/|A∪B|. Both empty → 1 (vacuously identical). */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 1 : inter / union;
}

/**
 * Run the perturbation harness on `vaultPath`.
 *
 * Discovers all notes with ≥3 revisions, runs `driftFlag` per perturbation, returns
 * stability report. `n` caps perturbation count (default 10).
 */
export async function runLexiconPerturbCheck(
  vaultPath: string,
  n: number = 10,
): Promise<LexiconPerturbReport> {
  const absVault = resolve(vaultPath);

  // discover all multi-revision notes once → reuse DriftRevisions per perturbation
  const files = await walkMarkdown(absVault);
  const multiRev: Array<{ notePath: string; revs: DriftRevision[] }> = [];
  for (const abs of files) {
    const notePath = relative(absVault, abs).split('\\').join('/');
    const revs = await noteRevisions(absVault, notePath);
    if (revs.length < 3) continue;
    // walk revisions newest→oldest from git, build chronological DriftRevisions
    const driftRevs: DriftRevision[] = [];
    for (const r of revs) {
      const content = await noteContentAt(absVault, r.sha, notePath);
      if (content === undefined) continue; // pre-rename SHA → skip
      driftRevs.push({
        date: r.commitDate,
        content,
        supportingClaimCount: extractWikilinks(content).length,
      });
    }
    driftRevs.reverse(); // chronological → slope anchor = oldest
    if (driftRevs.length < 3) continue;
    multiRev.push({ notePath, revs: driftRevs });
  }

  const perts: Perturbation[] = perturbations(HEDGE_WORDS_V1, ASSERTION_WORDS_V1, n);

  // baseline flagged set → for Jaccard reference
  const baselineId = 'v1';
  const flaggedByPert = new Map<string, Set<string>>();
  for (const p of perts) {
    const fired = new Set<string>();
    for (const { notePath, revs } of multiRev) {
      const flag = driftFlag(notePath, revs, {}, { hedge: p.hedge, assertion: p.assertion });
      if (flag !== null) fired.add(notePath);
    }
    flaggedByPert.set(p.id, fired);
  }

  const baselineSet = flaggedByPert.get(baselineId) ?? new Set<string>();
  const byPerturbation: PerturbationResult[] = perts.map((p) => {
    const fired = flaggedByPert.get(p.id) ?? new Set<string>();
    return {
      id: p.id,
      flagged: [...fired].sort(),
      jaccard: jaccard(baselineSet, fired),
    };
  });

  // summary stats over NON-baseline perturbations → baseline jaccard=1 by definition, would skew mean
  const nonBaseline = byPerturbation.filter((r) => r.id !== baselineId);
  const jaccards = nonBaseline.map((r) => r.jaccard);
  const jaccardMean = jaccards.length === 0 ? 1 : jaccards.reduce((s, x) => s + x, 0) / jaccards.length;
  const jaccardMin = jaccards.length === 0 ? 1 : Math.min(...jaccards);
  const jaccardMax = jaccards.length === 0 ? 1 : Math.max(...jaccards);

  return {
    perturbations: perts.length,
    baselineFlagged: baselineSet.size,
    jaccardMean,
    jaccardMin,
    jaccardMax,
    byPerturbation,
  };
}

async function main(): Promise<void> {
  const vaultPath = argv[2];
  const n = argv[3] ? parseInt(argv[3], 10) : 10;
  if (!vaultPath) {
    console.error('usage: lexicon-perturb-check <vaultPath> [n]');
    process.exit(2);
  }
  const report = await runLexiconPerturbCheck(vaultPath, n);
  stdout.write(JSON.stringify(report, null, 2) + '\n');
}

// CLI shim → fires only when invoked directly, not on import
const invokedAsCli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsCli) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
