import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const README = readFileSync(join(process.cwd(), 'obsidian-plugin', 'README.md'), 'utf-8');

describe('obsidian-plugin/README.md', () => {
  it('contains install steps (daemon + build + copy)', () => {
    expect(README).toMatch(/Install/i);
    expect(README).toMatch(/dev:daemon/);
    expect(README).toMatch(/pnpm build/);
    expect(README).toMatch(/\.obsidian\/plugins\/vaultnexus/);
  });

  it('contains a first-search walkthrough', () => {
    expect(README).toMatch(/First search/i);
    expect(README).toMatch(/command palette/i);
    expect(README).toMatch(/Enter/);
  });

  it('mentions the loopback port + endpoint', () => {
    expect(README).toMatch(/127\.0\.0\.1/);
    expect(README).toMatch(/38473/);
    expect(README).toMatch(/\/search/);
  });

  it('flags desktop-only constraint', () => {
    expect(README.toLowerCase()).toMatch(/desktop only|desktop-only/);
  });
});
