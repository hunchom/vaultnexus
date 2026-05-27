import matter from 'gray-matter';

// Frontmatter-declared probabilistic forecast → backbone of Brier-score ledger
export interface Forecast {
  notePath: string;
  claim: string;
  by: string;
  markedAt: string;
  probability: number;
}

// Forecast + user-recorded outcome → feeds brierScore()
export interface ResolvedForecast extends Forecast {
  outcome: boolean;
  resolvedAt: string;
}

interface ResolvedRaw {
  outcome: boolean;
  resolvedAt: string;
}

// All emitted timestamps (by / markedAt / resolvedAt) → full ISO via toISOString().
// YAML date scalar '2027-12-31' → Date object → '2027-12-31T00:00:00.000Z'. String → verbatim. Number → str.
function toIsoLike(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return undefined;
}

// probability ∈ [0,1] else default 0.5 (max uncertainty)
function normProb(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) return 0.5;
  return v;
}

// undefined when no forecast frontmatter or missing required fields. Pure — no I/O, no parse.
export function parseForecastFromData(
  data: Record<string, unknown>,
  notePath: string,
): Forecast | undefined {
  const raw = data.forecast as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== 'object') return undefined;
  const claim = typeof raw.claim === 'string' && raw.claim.length > 0 ? raw.claim : undefined;
  const by = toIsoLike(raw.by);
  const markedAt = toIsoLike(raw.marked_at);
  if (!claim || !by || !markedAt) return undefined;
  return { notePath, claim, by, markedAt, probability: normProb(raw.probability) };
}

// undefined when no resolved frontmatter or outcome isn't bool. Pure — no I/O, no parse.
export function parseResolvedFromData(data: Record<string, unknown>): ResolvedRaw | undefined {
  const raw = data.resolved as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== 'object') return undefined;
  if (typeof raw.outcome !== 'boolean') return undefined;
  const resolvedAt = toIsoLike(raw.resolved_at);
  if (!resolvedAt) return undefined;
  return { outcome: raw.outcome, resolvedAt };
}

// Thin string-wrapper → call matter() once, delegate to data helper. Kept for back-compat w/ tests + callers.
// New callers that have a parsed `data` object → call parseForecastFromData directly to skip double parse.
export function parseForecast(content: string, notePath: string): Forecast | undefined {
  let fm: Record<string, unknown>;
  try {
    fm = (matter(content).data ?? {}) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  return parseForecastFromData(fm, notePath);
}

// Thin string-wrapper → matches parseForecast pattern. Prefer parseResolvedFromData when data is in hand.
export function parseResolved(content: string): ResolvedRaw | undefined {
  let fm: Record<string, unknown>;
  try {
    fm = (matter(content).data ?? {}) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  return parseResolvedFromData(fm);
}

// Brier = mean((p - outcome)^2); null on empty → caller flags "no signal yet"
export function brierScore(resolved: ResolvedForecast[]): number | null {
  if (resolved.length === 0) return null;
  let sum = 0;
  for (const r of resolved) {
    const o = r.outcome ? 1 : 0;
    const d = r.probability - o;
    sum += d * d;
  }
  return sum / resolved.length;
}
