import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanVaultForecasts } from '../../src/daemon/forecast-scan.js';

function note(parts: string[]): string { return parts.join('\n'); }

describe('scanVaultForecasts', () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'vn-forecast-scan-'));
  });
  afterEach(() => { rmSync(vault, { recursive: true, force: true }); });

  it('partitions pending vs resolved + computes brier across resolved', async () => {
    mkdirSync(join(vault, 'notes'), { recursive: true });
    writeFileSync(join(vault, 'notes/p1.md'), note([
      '---',
      'forecast:',
      '  claim: "pending one"',
      '  by: 2027-01-01',
      '  marked_at: 2024-11-01',
      '---',
      '',
      'body',
    ]));
    writeFileSync(join(vault, 'notes/p2.md'), note([
      '---',
      'forecast:',
      '  claim: "pending two"',
      '  by: 2027-01-01',
      '  marked_at: 2024-11-01',
      '  probability: 0.6',
      '---',
    ]));
    writeFileSync(join(vault, 'notes/r1.md'), note([
      '---',
      'forecast:',
      '  claim: "resolved true"',
      '  by: 2027-01-01',
      '  marked_at: 2024-11-01',
      '  probability: 0.7',
      'resolved:',
      '  outcome: true',
      '  resolved_at: 2024-12-01',
      '---',
    ]));
    writeFileSync(join(vault, 'notes/r2.md'), note([
      '---',
      'forecast:',
      '  claim: "resolved false"',
      '  by: 2027-01-01',
      '  marked_at: 2024-11-01',
      '  probability: 0.3',
      'resolved:',
      '  outcome: false',
      '  resolved_at: 2024-12-01',
      '---',
    ]));
    writeFileSync(join(vault, 'notes/plain.md'), '# no forecast here\nbody\n');

    const led = await scanVaultForecasts(vault);
    expect(led.pending.map((p) => p.claim).sort()).toEqual(['pending one', 'pending two']);
    expect(led.resolved.length).toBe(2);
    expect(led.brier).toBeCloseTo(0.09, 10);
  });

  it('empty vault → empty arrays, brier null', async () => {
    const led = await scanVaultForecasts(vault);
    expect(led).toEqual({ pending: [], resolved: [], brier: null });
  });

  it('only pending → brier null', async () => {
    writeFileSync(join(vault, 'p.md'), note([
      '---',
      'forecast:',
      '  claim: "x"',
      '  by: 2027-01-01',
      '  marked_at: 2024-11-01',
      '---',
    ]));
    const led = await scanVaultForecasts(vault);
    expect(led.pending.length).toBe(1);
    expect(led.brier).toBeNull();
  });
});
