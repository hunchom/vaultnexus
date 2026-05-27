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

/** Splits `citations` by SHA-prefix match against any revision. Model emits short SHA → revision has full. */
export function validateShaCitations(
  citations: ShaCitation[],
  revisions: Revision[],
): { valid: ShaCitation[]; invalid: ShaCitation[] } {
  const shas = revisions.map((r) => r.sha);
  const valid: ShaCitation[] = [];
  const invalid: ShaCitation[] = [];
  for (const c of citations) {
    const hit = shas.some((s) => s.startsWith(c.sha));
    (hit ? valid : invalid).push(c);
  }
  return { valid, invalid };
}
