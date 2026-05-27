import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MANIFEST_PATH = join(process.cwd(), 'obsidian-plugin', 'manifest.json');

describe('obsidian-plugin/manifest.json', () => {
  it('parses as JSON', () => {
    const raw = readFileSync(MANIFEST_PATH, 'utf-8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('has the fields Obsidian requires', () => {
    const m = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));
    // Per Obsidian plugin spec: id, name, version, minAppVersion, description, author all required.
    for (const k of ['id', 'name', 'version', 'minAppVersion', 'description', 'author']) {
      expect(m[k], `manifest missing ${k}`).toBeTruthy();
      expect(typeof m[k]).toBe('string');
    }
  });

  it('uses the vaultnexus plugin id', () => {
    const m = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));
    expect(m.id).toBe('vaultnexus');
  });

  it('version follows semver-ish dotted form', () => {
    const m = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));
    expect(m.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(m.minAppVersion).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('declares desktop-only (loopback HTTP unavailable on mobile)', () => {
    const m = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));
    expect(m.isDesktopOnly).toBe(true);
  });
});
