import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedDemoVault } from '../../scripts/seed-demo-vault.js';
import { runDriftCheck } from '../../src/eval/drift-check.js';

describe('drift-check on Plan 14 fixture', () => {
  let vaultDir: string;

  beforeAll(() => {
    vaultDir = mkdtempSync(join(tmpdir(), 'vn-drift-check-'));
    seedDemoVault(vaultDir);
  });

  it('fires on the canonical stance-shift fixture (gtd-effectiveness.md)', async () => {
    const result = await runDriftCheck(vaultDir, 'notes/productivity/gtd-effectiveness.md');
    expect(result.revisions).toBe(3);
    expect(result.flag).not.toBeNull();
    expect(result.flag!.reason).toBe('conviction-up-supporting-flat');
    expect(result.flag!.notePath).toBe('notes/productivity/gtd-effectiveness.md');
    expect(result.flag!.convictionSlope).toBeGreaterThan(0);
    expect(result.flag!.supportingClaimSlope).toBeLessThanOrEqual(0.005);
  });

  it('does not fire on single-revision note (gtd-overview.md)', async () => {
    const result = await runDriftCheck(vaultDir, 'notes/productivity/gtd-overview.md');
    expect(result.revisions).toBe(1);
    expect(result.flag).toBeNull();
  });

  it('returns zero revisions for non-existent note', async () => {
    const result = await runDriftCheck(vaultDir, 'notes/does-not-exist.md');
    expect(result.revisions).toBe(0);
    expect(result.flag).toBeNull();
  });
});
