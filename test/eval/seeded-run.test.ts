/** Plan 22 + Reviewer 4 — VAULTNEXUS_EVAL_FTS_ONLY truthiness parsing.
 *  Originally accepted only the literal '1'; users typing 'true' or 'yes' silently
 *  got false. Fixed to accept the conventional set + reject garbage with exit 2. */

import { describe, it, expect } from 'vitest';
import { parseFtsOnly } from '../../src/eval/seeded-run.js';

describe('parseFtsOnly (VAULTNEXUS_EVAL_FTS_ONLY truthiness)', () => {
  it('returns true for every conventional truthy spelling', () => {
    for (const v of ['1', 'true', 'yes', 'on', 'TRUE', 'Yes', ' on ', 'ON']) {
      expect(parseFtsOnly(v)).toBe(true);
    }
  });

  it('returns false for every conventional falsy spelling and for undefined / empty', () => {
    for (const v of [undefined, '', '0', 'false', 'no', 'off', 'FALSE', 'No', ' off ']) {
      expect(parseFtsOnly(v)).toBe(false);
    }
  });

  it('returns "invalid" for garbage so caller can exit 2 with diagnostic', () => {
    for (const v of ['maybe', '2', 'truthy', 'enable', 'yep', 'x']) {
      expect(parseFtsOnly(v)).toBe('invalid');
    }
  });
});
