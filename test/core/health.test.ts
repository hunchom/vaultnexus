import { describe, it, expect } from 'vitest';
import { health, VERSION } from '../../src/core/health.js';

describe('health', () => {
  it('reports ok status and the package version', () => {
    expect(VERSION).toBe('0.0.1');
    expect(health()).toEqual({ status: 'ok', version: '0.0.1' });
  });

  it('is pure (same result every call)', () => {
    expect(health()).toEqual(health());
  });
});
