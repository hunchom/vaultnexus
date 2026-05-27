import type { ReasonHop } from '../daemon/reason-trace.js';

/** Parsed citation marker. raw = literal `[ref:notePath:byteStart-byteEnd]` as model emitted. */
export interface Citation {
  raw: string;
  notePath: string;
  byteStart: number;
  byteEnd: number;
}

// [^:\]]+ → notePath (any char except ':' and ']'); paths in vault never contain ':'
const CITATION_RE = /\[ref:([^:\]]+):(\d+)-(\d+)\]/g;

/** Pulls every `[ref:notePath:byteStart-byteEnd]` marker from `text`. Order = textual order. */
export function extractCitations(text: string): Citation[] {
  const out: Citation[] = [];
  for (const m of text.matchAll(CITATION_RE)) {
    out.push({
      raw: m[0],
      notePath: m[1],
      byteStart: Number(m[2]),
      byteEnd: Number(m[3]),
    });
  }
  return out;
}

/** Splits `citations` by exact (notePath, byteStart, byteEnd) match against any hop's chunk. */
export function validateCitations(
  citations: Citation[],
  hops: ReasonHop[],
): { valid: Citation[]; invalid: Citation[] } {
  // hop triples → set for O(1) lookup. key = notePath|byteStart|byteEnd
  const keys = new Set<string>();
  for (const h of hops) keys.add(`${h.chunk.notePath}|${h.chunk.byteStart}|${h.chunk.byteEnd}`);
  const valid: Citation[] = [];
  const invalid: Citation[] = [];
  for (const c of citations) {
    const k = `${c.notePath}|${c.byteStart}|${c.byteEnd}`;
    (keys.has(k) ? valid : invalid).push(c);
  }
  return { valid, invalid };
}
