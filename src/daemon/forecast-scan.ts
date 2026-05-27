import { readFile } from 'node:fs/promises';
import { relative } from 'node:path';
import matter from 'gray-matter';
import { walkMarkdown } from './indexer.js';
import {
  parseForecastFromData,
  parseResolvedFromData,
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
// One matter() per note → both helpers reuse parsed data (halves YAML cost vs prior 2× call).
export async function scanVaultForecasts(vaultPath: string): Promise<ForecastLedger> {
  const files = await walkMarkdown(vaultPath);
  const pending: Forecast[] = [];
  const resolved: ResolvedForecast[] = [];
  for (const abs of files) {
    const src = await readFile(abs, 'utf8');
    const notePath = relative(vaultPath, abs);
    let data: Record<string, unknown>;
    try {
      data = (matter(src).data ?? {}) as Record<string, unknown>;
    } catch {
      continue; // unparseable YAML → skip note
    }
    const fc = parseForecastFromData(data, notePath);
    if (!fc) continue;
    const res = parseResolvedFromData(data);
    if (res) resolved.push({ ...fc, outcome: res.outcome, resolvedAt: res.resolvedAt });
    else pending.push(fc);
  }
  return { pending, resolved, brier: brierScore(resolved) };
}
