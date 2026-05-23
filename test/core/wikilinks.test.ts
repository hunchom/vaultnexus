import { describe, it, expect } from 'vitest';
import { extractWikilinks } from '../../src/core/wikilinks.js';

describe('extractWikilinks', () => {
  it('plain, alias, heading, and embed forms → bare target', () => {
    expect(extractWikilinks('see [[Habits]] and [[Systems|my systems]]')).toEqual(['Habits', 'Systems']);
    expect(extractWikilinks('[[Note#Section]] and ![[Embedded]]')).toEqual(['Note', 'Embedded']);
  });
  it('dedupes, preserves first-seen order, ignores empties', () => {
    expect(extractWikilinks('[[A]] x [[A]] y [[B]]')).toEqual(['A', 'B']);
    expect(extractWikilinks('no links here')).toEqual([]);
    expect(extractWikilinks('[[ ]] [[]]')).toEqual([]);
  });
  it('trims whitespace inside brackets', () => {
    expect(extractWikilinks('[[  Spaced Note  ]]')).toEqual(['Spaced Note']);
  });
});
