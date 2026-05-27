import { readFile } from 'node:fs/promises';
import { relative } from 'node:path';
import { walkMarkdown } from './indexer.js';
import {
  parseForecast,
  parseResolved,
  brierScore,
  type Forecast,
  type ResolvedForecast,
} from '../core/forecast.js';

export interface ForecastLedger {
  pending: Forecast[];
  resolved: ResolvedForecast[];
  brier: number | null;
}

// Walk every .md → partition by resolved-frontmatter presence → score.
// notePath = vault-relative (matches addNote() convention).
export async function scanVaultForecasts(vaultPath: string): Promise<ForecastLedger> {
  const files = await walkMarkdown(vaultPath);
  const pending: Forecast[] = [];
  const resolved: ResolvedForecast[] = [];
  for (const abs of files) {
    const src = await readFile(abs, 'utf8');
    const notePath = relative(vaultPath, abs);
    const fc = parseForecast(src, notePath);
    if (!fc) continue;
    const res = parseResolved(src);
    if (res) resolved.push({ ...fc, outcome: res.outcome, resolvedAt: res.resolvedAt });
    else pending.push(fc);
  }
  return { pending, resolved, brier: brierScore(resolved) };
}
