#!/usr/bin/env node
// CLI + library for the confirmation-drift signal (concept §10.9).
// NO MCP TOOL — research surface only until the §10.9 precision-gate spike passes.
import { argv, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { noteRevisions, noteContentAt } from '../daemon/git-history.js';
import { extractWikilinks } from '../core/wikilinks.js';
import { driftFlag, type DriftEvent, type DriftOpts, type DriftRevision } from '../core/drift.js';

/** Result of a drift check on one note. `flag` null when rule did not fire. */
export interface DriftCheckResult {
  flag: DriftEvent | null;
  revisions: number;
}

// CLI tuning vs library defaults (concept §10.9): library minCS=0.0005 was a guess; the canonical
// Plan 14 fixture's conviction-slope is ≈0.00033/day across 221 days, below 0.0005. The CLI
// surfaces realistic drift events for users, so we use a tuned default here. The §10.9 spike
// re-tunes both against owner-labeled corpora; library defaults stay frozen for that calibration.
const CLI_DEFAULT_OPTS: DriftOpts = {
  minConvictionSlope: 0.0002,
  maxSupportingSlope: 0.005,
};

/**
 * Walk git history for `notePath` in `vaultPath`, compute drift signal.
 *
 * Revisions where noteContentAt returns undefined (pre-rename SHA, Plan 13 BLOCKER) are
 * SKIPPED, not treated as empty. If skipping drops valid revisions below 3, flag is null.
 */
export async function runDriftCheck(
  vaultPath: string,
  notePath: string,
  opts: DriftOpts = CLI_DEFAULT_OPTS,
): Promise<DriftCheckResult> {
  const revs = await noteRevisions(vaultPath, notePath);
  if (revs.length === 0) return { flag: null, revisions: 0 };
  // Walk newest→oldest from noteRevisions, then build DriftRevisions in CHRONOLOGICAL order
  // for slope math (anchor = oldest). Filter undefined-content revisions silently.
  const driftRevs: DriftRevision[] = [];
  for (const r of revs) {
    const content = await noteContentAt(vaultPath, r.sha, notePath);
    if (content === undefined) continue; // pre-rename SHA → skip
    driftRevs.push({
      date: r.commitDate,
      content,
      supportingClaimCount: extractWikilinks(content).length,
    });
  }
  // noteRevisions returns newest-first → reverse to chronological for slope anchor = oldest
  driftRevs.reverse();
  const flag = driftFlag(notePath, driftRevs, opts);
  return { flag, revisions: driftRevs.length };
}

async function main(): Promise<void> {
  const notePath = argv[2];
  const vaultPath = argv[3] ? resolve(argv[3]) : process.cwd();
  if (!notePath) {
    console.error('usage: drift-check <notePath> [vaultPath]');
    process.exit(2);
  }
  const result = await runDriftCheck(vaultPath, notePath);
  stdout.write(JSON.stringify(result) + '\n');
}

// CLI shim — fires only when invoked directly (tsx scripts or compiled bin), not on import
const invokedAsCli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsCli) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
