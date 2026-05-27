import type { Revision } from '../daemon/git-history.js';

/** Parsed SHA citation marker from narration text. raw = literal `[sha:<hex>@<date>]` as model emitted. */
export interface ShaCitation {
  raw: string;
  sha: string;
  date: string;
}

// short SHA (7-40 hex) + ISO-8601-ish date; whitespace around '@' tolerated
const SHA_CITATION_RE = /\[sha:([a-f0-9]{7,40})\s*@\s*([0-9T:\-Z.]+)\]/g;

/** Pulls every `[sha:<hex>@<date>]` marker from `text`. Order = textual order. */
export function extractShaCitations(text: string): ShaCitation[] {
  const out: ShaCitation[] = [];
  for (const m of text.matchAll(SHA_CITATION_RE)) {
    out.push({ raw: m[0], sha: m[1], date: m[2] });
  }
  return out;
}

/**
 * Splits `citations` by UNIQUE SHA-prefix match against revisions.
 * Model emits short SHA → revision has full.
 * 0 matches → invalid (not found). 2+ matches → invalid (ambiguous prefix; e.g. degenerate `[sha:aaaaaaa @ ...]`).
 * Exactly 1 match → valid.
 */
export function validateShaCitations(
  citations: ShaCitation[],
  revisions: Revision[],
): { valid: ShaCitation[]; invalid: ShaCitation[] } {
  const valid: ShaCitation[] = [];
  const invalid: ShaCitation[] = [];
  for (const c of citations) {
    const matches = revisions.filter((r) => r.sha.startsWith(c.sha));
    if (matches.length === 1) valid.push(c);
    else invalid.push(c); // 0 = not found, 2+ = ambiguous prefix
  }
  return { valid, invalid };
}
