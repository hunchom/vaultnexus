/** Plan 22 — gold corpus invariants. Validates that:
 *  (a) the corpus is large enough to break recall@10 saturation (≥15),
 *  (b) every target points at a real file in demo-vault-seeded/notes/,
 *  (c) no query string contains the target's basename (case-insensitive lexical leak).
 *
 *  The leakage-floor regression (FTS-only recall@1 < 0.4) lives in seeded-harness.test.ts
 *  → it needs the indexer; this file is pure path/string validation.
 */

import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
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
});
