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
