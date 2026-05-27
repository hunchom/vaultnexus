// Confirmation-drift signal — concept §10.9. Lexicon v1 frozen; see docs/specs/drift-lexicon.md.
// Pure I/O-free: deterministic across machines → same revision → same score.

export const HEDGE_WORDS_V1 = [
  'maybe', 'perhaps', 'might', 'could', 'seems', 'appears', 'possibly',
  'somewhat', 'tentatively', 'arguably', 'roughly', 'apparently', 'probably', 'kind of',
] as const;

export const ASSERTION_WORDS_V1 = [
  'definitely', 'clearly', 'obviously', 'certainly', 'must', 'always', 'never',
  'only', 'every', 'essential', 'useless', 'impossible',
] as const;

/** Result emitted when drift rule fires. `samples` always populated (caller can re-derive slopes). */
export interface DriftEvent {
  notePath: string;
  convictionSlope: number; // points/day
  supportingClaimSlope: number; // links/day
  samples: Array<{ date: string; conviction: number; supportingClaims: number }>;
  reason: 'conviction-up-supporting-flat';
}

// Word-bounded global regex for one lexicon term. Multi-word terms keep the space verbatim — \b on outer edges.
function termRegex(term: string): RegExp {
  // v1 lexicon is alpha+space-only → no regex-escape needed. Future versions: escape first.
  return new RegExp(`\\b${term}\\b`, 'gi');
}

// Count whole-word matches of `term` in lowercased `text`. Phrase terms (e.g. 'kind of') matched verbatim.
function countTerm(text: string, term: string): number {
  const matches = text.match(termRegex(term));
  return matches ? matches.length : 0;
}

// Total word tokens — split on non-letters → drops punctuation, numbers, whitespace. Apostrophes preserved inside words.
function wordCount(text: string): number {
  const tokens = text.toLowerCase().split(/[^a-z']+/).filter((t) => t.length > 0);
  return tokens.length;
}

/** Conviction score: (assertion_density − hedge_density). Empty → 0. Range ≈ [−0.05, +0.10] in real prose. */
export function conviction(text: string): number {
  const total = wordCount(text);
  if (total === 0) return 0;
  const lower = text.toLowerCase();
  let hedges = 0;
  for (const w of HEDGE_WORDS_V1) hedges += countTerm(lower, w);
  let assertions = 0;
  for (const w of ASSERTION_WORDS_V1) assertions += countTerm(lower, w);
  return (assertions - hedges) / total;
}

// Least-squares slope of y vs t. n<2 → 0. Zero t-variance (all dates equal) → 0 (guard div-by-zero).
function leastSquaresSlope(points: Array<{ t: number; y: number }>): number {
  if (points.length < 2) return 0;
  const n = points.length;
  const tMean = points.reduce((s, p) => s + p.t, 0) / n;
  const yMean = points.reduce((s, p) => s + p.y, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    const dt = p.t - tMean;
    num += dt * (p.y - yMean);
    den += dt * dt;
  }
  if (den === 0) return 0;
  return num / den;
}

// date string → days from anchor (Date.parse / 86_400_000 ms). Anchor = first sample's parsed ms.
function toDays(date: string, anchorMs: number): number {
  return (Date.parse(date) - anchorMs) / 86_400_000;
}

/** Slope of conviction over days-since-first. n<2 → 0. Equal-date case → 0. */
export function convictionSlope(samples: Array<{ date: string; score: number }>): number {
  if (samples.length < 2) return 0;
  const anchor = Date.parse(samples[0].date);
  const points = samples.map((s) => ({ t: toDays(s.date, anchor), y: s.score }));
  return leastSquaresSlope(points);
}

/** Slope of supporting-claim count over days-since-first. n<2 → 0. Equal-date case → 0. */
export function supportingClaimSlope(samples: Array<{ date: string; count: number }>): number {
  if (samples.length < 2) return 0;
  const anchor = Date.parse(samples[0].date);
  const points = samples.map((s) => ({ t: toDays(s.date, anchor), y: s.count }));
  return leastSquaresSlope(points);
}

/** Single revision input to driftFlag. `supportingClaimCount` = wikilink count in body. */
export interface DriftRevision {
  date: string;
  content: string;
  supportingClaimCount: number;
}

/** Tunables for the drift rule. Defaults: minCS 0.0005 pts/day, maxSS 0.005 links/day. */
export interface DriftOpts {
  minConvictionSlope?: number;
  maxSupportingSlope?: number;
}

/**
 * Drift rule: fire iff convictionSlope ≥ minCS AND supportingClaimSlope ≤ maxSS AND n≥3.
 *
 * AND-with-tolerance is load-bearing (concept §10.9): healthy settling has conviction-up
 * AND supporting-up → must NOT fire. Pathological drift has conviction-up + supporting-flat
 * → fires. n<3 → null (meaningful trajectory needs ≥3 points).
 */
export function driftFlag(
  notePath: string,
  revisions: DriftRevision[],
  opts: DriftOpts = {},
): DriftEvent | null {
  if (revisions.length < 3) return null;
  const minCS = opts.minConvictionSlope ?? 0.0005;
  const maxSS = opts.maxSupportingSlope ?? 0.005;
  const samples = revisions.map((r) => ({
    date: r.date,
    conviction: conviction(r.content),
    supportingClaims: r.supportingClaimCount,
  }));
  const cs = convictionSlope(samples.map((s) => ({ date: s.date, score: s.conviction })));
  const ss = supportingClaimSlope(samples.map((s) => ({ date: s.date, count: s.supportingClaims })));
  if (cs >= minCS && ss <= maxSS) {
    return {
      notePath,
      convictionSlope: cs,
      supportingClaimSlope: ss,
      samples,
      reason: 'conviction-up-supporting-flat',
    };
  }
  return null;
}
