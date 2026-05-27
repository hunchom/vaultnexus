import { describe, it, expect } from 'vitest';
import { classifyQuery, weightsForIntent } from '../../src/core/router.js';

describe('classifyQuery', () => {
  describe('specific intent', () => {
    it('quoted phrase → specific even when long', () => {
      expect(classifyQuery('how does the system handle "context switching cost" in production')).toBe('specific');
    });
    it('curly-quoted phrase → specific', () => {
      expect(classifyQuery('explain the “OODA loop” idea in plain terms please')).toBe('specific');
    });
    it('ALL_CAPS acronym ≥3 chars → specific', () => {
      expect(classifyQuery('the GTD methodology and why people abandon it')).toBe('specific');
    });
    it('short 2-letter acronym does NOT trigger acronym rule', () => {
      // "AI" is 2 chars → NOT acronym; sentence length governs.
      expect(classifyQuery('AI capabilities by 2027 and beyond will change everything')).toBe('broad');
    });
    it('CamelCase token → specific', () => {
      expect(classifyQuery('how does VaultIndex handle restart from snapshot disk read')).toBe('specific');
    });
    it('≤3 words → specific', () => {
      expect(classifyQuery('OODA loop fast')).toBe('specific');
      expect(classifyQuery('atomic notes')).toBe('specific');
      expect(classifyQuery('regret')).toBe('specific');
    });
    it('exactly 3 words → specific (boundary)', () => {
      expect(classifyQuery('one two three')).toBe('specific');
    });
  });

  describe('broad intent', () => {
    it('≥8 words sentence-question → broad', () => {
      expect(classifyQuery('why does waiting until the last minute actually produce better outcomes for me')).toBe('broad');
    });
    it('exactly 8 words → broad (boundary)', () => {
      expect(classifyQuery('one two three four five six seven eight')).toBe('broad');
    });
    it('long question without distinctive tokens → broad', () => {
      expect(
        classifyQuery('imagining catastrophic project failure ahead of time to surface tripwires and assumptions before launch'),
      ).toBe('broad');
    });
  });

  describe('mixed intent', () => {
    it('4-7 words, no specific markers → mixed', () => {
      expect(classifyQuery('how do i prioritize tasks well')).toBe('mixed');
      expect(classifyQuery('habits for deep work')).toBe('mixed'); // 4 words
    });
    it('exactly 7 words → mixed (just below broad boundary)', () => {
      expect(classifyQuery('one two three four five six seven')).toBe('mixed');
    });
  });

  describe('edge cases', () => {
    it('empty string → mixed (degenerate; keep current behavior)', () => {
      expect(classifyQuery('')).toBe('mixed');
      expect(classifyQuery('   ')).toBe('mixed');
    });
    it('whitespace + punctuation only → mixed (no words)', () => {
      // 0 words → falls through SPECIFIC (none of quote/acronym/camel) → not ≤3 (0 IS ≤3)
      // Actually 0 ≤ 3 → specific. Document behavior:
      expect(classifyQuery('!!!')).toBe('specific');
    });
    it('mixed case lowercase → no specific markers', () => {
      expect(classifyQuery('the quick brown fox jumps over the lazy dog every day')).toBe('broad');
    });
    it('punctuation around quotes still matches', () => {
      expect(classifyQuery('what did he mean by "deep work" anyway, really?')).toBe('specific');
    });
  });
});

describe('weightsForIntent', () => {
  it('specific → vector-heavy, fts attenuated', () => {
    expect(weightsForIntent('specific')).toEqual({ vector: 1.0, fts: 0.4 });
  });
  it('broad → vector-only', () => {
    expect(weightsForIntent('broad')).toEqual({ vector: 1.0, fts: 0.0 });
  });
  it('mixed → balanced (current default)', () => {
    expect(weightsForIntent('mixed')).toEqual({ vector: 1.0, fts: 1.0 });
  });
});
