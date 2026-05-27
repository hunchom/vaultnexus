/** Plan 25 — query router. Pure heuristic classifier; no LLM, no embeddings.
 *
 *  intent → fusion weights downstream:
 *    specific → vector-heavy, FTS still useful for the literal token        (1.0, 0.4)
 *    broad    → vector-only / vector-strong (FTS hurts paraphrase queries)  (1.0, 0.0)
 *    mixed    → balanced RRF (current default)                              (1.0, 1.0)
 *
 *  Heuristics ranked by signal strength:
 *    SPECIFIC  ← any of: contains "..." quoted phrase
 *                       | ALL_CAPS acronym ≥3 chars (e.g. "OODA", "GTD")
 *                       | CamelCase token (e.g. "VaultIndex")
 *                       | total word count ≤ 3
 *    BROAD     ← ≥8 words AND no quotes AND no all-caps acronym
 *    MIXED     ← everything else
 *
 *  Order matters: SPECIFIC checks short-circuit before BROAD's length test, so a
 *  long sentence with a quoted phrase still routes specific. */

export type QueryIntent = 'specific' | 'broad' | 'mixed';

export interface RouterWeights {
  vector: number;
  fts: number;
}

/** intent → fusion weights. Stable mapping; tweak weights here only. */
export function weightsForIntent(intent: QueryIntent): RouterWeights {
  switch (intent) {
    case 'specific': return { vector: 1.0, fts: 0.4 };
    case 'broad':    return { vector: 1.0, fts: 0.0 };
    case 'mixed':    return { vector: 1.0, fts: 1.0 };
  }
}

const QUOTED = /"[^"]+"|“[^”]+”/;             // ASCII + curly quotes
const ACRONYM = /\b[A-Z]{3,}\b/;              // ≥3 contiguous uppercase letters
const CAMEL = /\b[A-Z][a-z]+[A-Z][a-zA-Z]*\b/; // ≥2 humps, leading letter+lower then Upper

/** word = run of letters/digits, including unicode. Apostrophes/hyphens split. */
function wordCount(s: string): number {
  return (s.match(/[\p{L}\p{N}]+/gu) ?? []).length;
}

export function classifyQuery(query: string): QueryIntent {
  const q = query.trim();
  if (q.length === 0) return 'mixed'; // degenerate → keep current behavior

  // SPECIFIC short-circuits — distinctive token wins over length heuristic.
  if (QUOTED.test(q)) return 'specific';
  if (ACRONYM.test(q)) return 'specific';
  if (CAMEL.test(q)) return 'specific';

  const n = wordCount(q);
  if (n <= 3) return 'specific';
  if (n >= 8) return 'broad';
  return 'mixed';
}
