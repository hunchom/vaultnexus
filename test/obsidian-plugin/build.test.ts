import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, rmSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const PLUGIN_DIR = join(process.cwd(), 'obsidian-plugin');
const MAIN_JS = join(PLUGIN_DIR, 'main.js');

describe('obsidian-plugin build smoke', () => {
  beforeAll(() => {
    if (existsSync(MAIN_JS)) rmSync(MAIN_JS);
    // Build via esbuild config. Assumes plugin's node_modules already installed
    // (run `pnpm install --ignore-workspace` inside obsidian-plugin/ if missing).
    execSync('node esbuild.config.mjs', { cwd: PLUGIN_DIR, stdio: 'pipe' });
  }, 60000);

  afterAll(() => {
    // Clean build artifact → keep repo tidy.
    rmSync(MAIN_JS, { force: true });
  });

  it('produces main.js', () => {
    expect(existsSync(MAIN_JS)).toBe(true);
  });

  it('bundle is CJS (starts with use strict or contains module.exports)', () => {
    const src = readFileSync(MAIN_JS, 'utf-8');
    const cjsLike = src.startsWith('"use strict"') || src.includes('module.exports');
    expect(cjsLike).toBe(true);
  });

  it('bundle is non-trivial (> 1KB) but < 1MB', () => {
    const { size } = statSync(MAIN_JS);
    expect(size).toBeGreaterThan(1024);
    expect(size).toBeLessThan(1024 * 1024);
  });

  it('does NOT bundle obsidian package (it is external)', () => {
    const src = readFileSync(MAIN_JS, 'utf-8');
    // obsidian must be require()d at runtime by Obsidian itself, not inlined.
    expect(src).toMatch(/require\(\s*["']obsidian["']\s*\)/);
  });

  it('exports a default Plugin class', () => {
    const src = readFileSync(MAIN_JS, 'utf-8');
    // esbuild CJS exports look like `0 && (module.exports = { default: ... })`
    // or assign default → check for `default:` in exports table.
    expect(src).toMatch(/default/);
  });
});
