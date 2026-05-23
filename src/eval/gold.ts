import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface GoldQuery { query: string; relevant: string[]; } // relevant = corpus note paths

/** Labeled queries — paraphrased to share no distinctive token with their target note (stopwords only),
 *  so the vector half (not FTS5 keyword match) must do the retrieving. */
export const GOLD_QUERIES: GoldQuery[] = [
  { query: 'why investing early in life pays off so disproportionately', relevant: ['compounding.md'] },
  { query: 'what the brain does overnight to lock in things you studied', relevant: ['sleep.md'] },
  { query: 'how a leaf turns light into stored fuel', relevant: ['photosynthesis.md'] },
  { query: 'how a repeated choice turns into something you do on autopilot', relevant: ['habits.md'] },
  { query: 'how unreliable machines agree on one value when some fail', relevant: ['consensus.md'] },
  { query: 'why pan-frying food at high heat builds deep savory flavor and color', relevant: ['maillard.md'] },
  { query: 'why spreading practice out over time beats last-minute cramming', relevant: ['spaced-repetition.md'] },
  { query: 'what lets you hold firm in a deal because you have a strong backup option', relevant: ['negotiation.md'] },
  { query: 'ways to make studied information stick for the long term', relevant: ['sleep.md', 'spaced-repetition.md'] },
  { query: 'biological process that converts sunlight into chemical energy', relevant: ['photosynthesis.md'] },
  { query: 'tradeoff between staying available and staying consistent during a network split', relevant: ['consensus.md'] },
  { query: 'the science of why roasting makes the outside of food taste toasty and rich', relevant: ['maillard.md'] },
];

/** Read corpus dir → list of notePath + source. */
export function loadCorpus(dir: string): Array<{ path: string; source: string }> {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => ({ path: f, source: readFileSync(join(dir, f), 'utf8') }));
}
