import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface GoldQuery { query: string; relevant: string[]; } // relevant = corpus note paths

/** Labeled queries — paraphrased to share few keywords with their target note. */
export const GOLD_QUERIES: GoldQuery[] = [
  { query: 'why investing early in life pays off so disproportionately', relevant: ['compounding.md'] },
  { query: 'what the brain does overnight to lock in things you studied', relevant: ['sleep.md'] },
  { query: 'how a leaf turns light into stored fuel', relevant: ['photosynthesis.md'] },
  { query: 'the cue routine reward loop that makes actions automatic', relevant: ['habits.md'] },
  { query: 'how unreliable machines agree on one value when some fail', relevant: ['consensus.md'] },
  { query: 'why a seared crust tastes richer than boiled meat', relevant: ['maillard.md'] },
  { query: 'the best schedule of reviews so you stop forgetting material', relevant: ['spaced-repetition.md'] },
  { query: 'your fallback if a deal falls through and the power it gives you', relevant: ['negotiation.md'] },
  { query: 'ways to make studied information stick for the long term', relevant: ['sleep.md', 'spaced-repetition.md'] },
  { query: 'biological process that converts sunlight into chemical energy', relevant: ['photosynthesis.md'] },
  { query: 'tradeoff between staying available and staying consistent during a network split', relevant: ['consensus.md'] },
  { query: 'chemistry behind brown flavorful crust on roasted food', relevant: ['maillard.md'] },
];

/** Read corpus dir → list of notePath + source. */
export function loadCorpus(dir: string): Array<{ path: string; source: string }> {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => ({ path: f, source: readFileSync(join(dir, f), 'utf8') }));
}
