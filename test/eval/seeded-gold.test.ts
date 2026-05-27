/** Plan 22 — gold corpus invariants. Validates that:
 *  (a) the corpus is large enough to break recall@10 saturation (≥15),
 *  (b) every target points at a real file in demo-vault-seeded/notes/,
 *  (c) no query string contains the target's basename (case-insensitive lexical leak).
 *
 *  The leakage-floor regression (FTS-only recall@1 < 0.4) lives in seeded-harness.test.ts
 *  → it needs the indexer; this file is pure path/string validation.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEEDED_GOLD_QUERIES } from '../../src/eval/seeded-gold.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '../..');
const VAULT_SOURCE = join(REPO_ROOT, 'demo-vault-seeded'); // canonical source notes live here

describe('SEEDED_GOLD_QUERIES corpus invariants', () => {
  it('contains at least 15 queries (broke recall@10 saturation contract)', () => {
    expect(SEEDED_GOLD_QUERIES.length).toBeGreaterThanOrEqual(15);
  });

  it('every target maps to a real file under demo-vault-seeded/', () => {
    const missing: string[] = [];
    for (const q of SEEDED_GOLD_QUERIES) {
      for (const t of q.targets) {
        const abs = join(VAULT_SOURCE, t);
        if (!existsSync(abs)) missing.push(t);
      }
    }
    expect(missing).toEqual([]);
  });

  it('targets are POSIX paths under notes/ — no backslashes, no leading slash', () => {
    for (const q of SEEDED_GOLD_QUERIES) {
      for (const t of q.targets) {
        expect(t.startsWith('notes/')).toBe(true);
        expect(t.includes('\\')).toBe(false);
      }
    }
  });

  it('no query string contains its target basename (no trivial lexical leak)', () => {
    // function-word slug tokens ("why", "vs", "the") aren't lexical signals → exempt
    const SLUG_STOPWORDS = new Set([
      'why', 'how', 'vs', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'is', 'it',
      'a', 'an', 'i', 'my', 'me', 'we', 'us', 'be', 'by', 'for', 'from', 'with',
      'this', 'that', 'over', 'under', 'into', 'out',
    ]);
    const leaks: Array<{ q: string; t: string; basename: string }> = [];
    for (const q of SEEDED_GOLD_QUERIES) {
      const ql = q.query.toLowerCase();
      for (const t of q.targets) {
        const base = basename(t, '.md').toLowerCase();
        const tokens = base
          .split('-')
          .filter((tok) => tok.length >= 3 && !SLUG_STOPWORDS.has(tok));
        for (const tok of tokens) {
          const re = new RegExp(`(^|[^a-z])${tok}([^a-z]|$)`);
          if (re.test(ql)) leaks.push({ q: q.query, t, basename: tok });
        }
      }
    }
    expect(leaks).toEqual([]);
  });

  it('every query has ≥1 target', () => {
    for (const q of SEEDED_GOLD_QUERIES) {
      expect(q.targets.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('every query is non-trivial (≥30 chars, paraphrase quality floor)', () => {
    for (const q of SEEDED_GOLD_QUERIES) {
      expect(q.query.length).toBeGreaterThanOrEqual(30);
    }
  });

  // ── body-overlap leak guard (Reviewer 4 finding) ────────────────────────────
  // Slug-basename overlap catches obvious cases ("why-obsidian" → query contains
  // "obsidian"). It does NOT catch paraphrases that lift distinctive vocabulary
  // straight from the target body — e.g. body says "Sunday afternoon coffee
  // forty-five-minute" and the query echoes the same phrase. That kind of leak
  // turns the FTS-only floor measurement into noise. Cap at ≤ 3 shared
  // distinctive tokens (length > 2, filtered against common stopwords) between
  // every query and the body of each of its targets.
  it('every query shares ≤ 3 distinctive content tokens with its target body', () => {
    const STOPWORDS = new Set([
      'the','a','an','and','or','of','to','in','is','on','for','with','that','this','it',
      'be','as','by','at','from','do','does','my','your','their','our','i','you','we','they',
      'what','why','how','when','where','if','then','than','so','but','not','no','yes',
      'can','will','should','would','could','may','might','also','just','very','more','most',
      'some','any','all','each','every','only','one','two','three','well','am','are','was',
      'were','been','being','have','has','had','having','about','into','out','up','down',
      'over','under','through','during','before','after','above','below','between','among',
      'me','him','her','them','its','his','hers','theirs','ours','yours','mine','myself',
      'yourself','himself','herself','itself','ourselves','yourselves','themselves','these',
      'those','there','now','too','still','already','yet','say','says','said',
    ]);
    const tokenize = (s: string): Set<string> => {
      const matches = s.toLowerCase().match(/[a-z0-9]+/g) ?? [];
      return new Set(matches.filter((w) => w.length > 2 && !STOPWORDS.has(w)));
    };
    const leaks: Array<{ q: string; target: string; shared: string[] }> = [];
    for (const q of SEEDED_GOLD_QUERIES) {
      const qTokens = tokenize(q.query);
      for (const target of q.targets) {
        const bodyText = readFileSync(join(VAULT_SOURCE, target), 'utf8');
        const bTokens = tokenize(bodyText);
        const shared = [...qTokens].filter((t) => bTokens.has(t)).sort();
        if (shared.length > 3) leaks.push({ q: q.query, target, shared });
      }
    }
    expect(leaks).toEqual([]);
  });
});
