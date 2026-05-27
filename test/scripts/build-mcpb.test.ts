import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildMcpb } from '../../scripts/build-mcpb.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');
const MANIFEST_PATH = join(REPO_ROOT, 'mcpb', 'manifest.json');
const PKG_PATH = join(REPO_ROOT, 'package.json');

// shared build → expensive (full tsc + node_modules copy + zip). Reuse across tests.
let buildResult: Awaited<ReturnType<typeof buildMcpb>>;
let outDir: string;
let zipListing: string;

beforeAll(async () => {
  outDir = mkdtempSync(join(tmpdir(), 'vn-mcpb-test-'));
  buildResult = await buildMcpb({ outDir });
  // pnpm-deployed bundle has ~233 deps → unzip listing exceeds default 1 MB buffer
  zipListing = execFileSync('unzip', ['-l', buildResult.mcpbPath], {
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });
}, 240000);

afterAll(() => {
  if (outDir && existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
});

describe('T1 build-mcpb script', () => {
  it('produces a .mcpb file in the output dir', () => {
    expect(existsSync(buildResult.mcpbPath)).toBe(true);
    expect(buildResult.mcpbPath.endsWith('.mcpb')).toBe(true);
    expect(statSync(buildResult.mcpbPath).size).toBeGreaterThan(1024); // sanity → not empty
  });

  it('zip contains manifest.json at root', () => {
    expect(zipListing).toMatch(/\smanifest\.json\s*$/m);
  });

  it('zip contains server/dist/bridge/main.js', () => {
    expect(zipListing).toMatch(/server\/dist\/bridge\/main\.js/);
  });

  it('zip contains server/dist/daemon/main.js', () => {
    expect(zipListing).toMatch(/server\/dist\/daemon\/main\.js/);
  });

  it('zip contains server/package.json', () => {
    expect(zipListing).toMatch(/server\/package\.json/);
  });

  it('zip contains server/node_modules with at least one dep', () => {
    // @modelcontextprotocol/sdk → declared prod dep, present as symlink → .pnpm/...
    expect(zipListing).toMatch(/server\/node_modules\/@modelcontextprotocol\/sdk/);
  });

  it('zip contains transitive deps via .pnpm virtual store (bindings, ajv)', () => {
    // pnpm flat layout: transitives ONLY exist under .pnpm/<pkg>@<ver>/node_modules/<dep>
    // → catches the regression where old walker silently dropped 46/67 transitives
    expect(zipListing).toMatch(/server\/node_modules\/\.pnpm\/bindings@/);
    expect(zipListing).toMatch(/server\/node_modules\/\.pnpm\/ajv@/);
  });
});

describe('T2 manifest validity', () => {
  it('mcpb/manifest.json is parseable JSON', () => {
    const raw = readFileSync(MANIFEST_PATH, 'utf-8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('declares required top-level fields', () => {
    const m = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));
    expect(m.manifest_version).toBeTruthy();
    expect(m.name).toBe('vaultnexus');
    expect(m.version).toBeTruthy();
    expect(m.description).toBeTruthy();
    expect(m.author).toBeTruthy();
    expect(m.author.name).toBeTruthy();
    expect(m.server).toBeTruthy();
    expect(m.server.type).toBe('node');
    expect(m.server.entry_point).toBe('server/dist/bridge/main.js');
  });

  it('declares mcp_config command + args + env', () => {
    const m = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));
    expect(m.server.mcp_config).toBeTruthy();
    expect(m.server.mcp_config.command).toBe('node');
    expect(Array.isArray(m.server.mcp_config.args)).toBe(true);
    expect(m.server.mcp_config.args.join(' ')).toContain('${__dirname}');
    expect(m.server.mcp_config.env).toBeTruthy();
  });

  it('packaged manifest matches source schema', () => {
    expect(buildResult.manifest.manifest_version).toBeTruthy();
    expect(buildResult.manifest.server).toBeTruthy();
  });
});

describe('T3 version sync', () => {
  it('mcpb filename embeds package.json version', () => {
    const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf-8'));
    expect(buildResult.mcpbPath).toContain(`vaultnexus-${pkg.version}.mcpb`);
    expect(buildResult.version).toBe(pkg.version);
  });

  it('packaged manifest.version reflects package.json version', () => {
    const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf-8'));
    expect(buildResult.manifest.version).toBe(pkg.version);
  });

  it('version bump propagates to filename + manifest', async () => {
    // bump → rebuild into isolated tmp pkg → assert → no side effect on repo
    const tmpRoot = mkdtempSync(join(tmpdir(), 'vn-mcpb-bump-'));
    try {
      // shallow-mirror repo (manifest + package.json + pre-built dist + node_modules symlink)
      const bumpedPkg = JSON.parse(readFileSync(PKG_PATH, 'utf-8'));
      bumpedPkg.version = '9.9.9-test';
      writeFileSync(join(tmpRoot, 'package.json'), JSON.stringify(bumpedPkg, null, 2));
      // mcpb/manifest.json mirror
      const mcpbDir = join(tmpRoot, 'mcpb');
      execFileSync('mkdir', ['-p', mcpbDir]);
      writeFileSync(join(mcpbDir, 'manifest.json'), readFileSync(MANIFEST_PATH, 'utf-8'));
      // symlink dist + node_modules + tsconfig → don't recompile
      execFileSync('ln', ['-s', join(REPO_ROOT, 'dist'), join(tmpRoot, 'dist')]);
      execFileSync('ln', ['-s', join(REPO_ROOT, 'node_modules'), join(tmpRoot, 'node_modules')]);

      // skipNodeModules → fake repo isn't a pnpm workspace; we only verify version propagation
      const bumped = await buildMcpb({
        repoRoot: tmpRoot,
        outDir: join(tmpRoot, 'out'),
        skipBuild: true,
        skipNodeModules: true,
      });
      expect(bumped.mcpbPath).toContain('vaultnexus-9.9.9-test.mcpb');
      expect(bumped.version).toBe('9.9.9-test');
      expect(bumped.manifest.version).toBe('9.9.9-test');
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  }, 120000);
});

describe('T4 user-config schema', () => {
  it('declares vault_path as required directory', () => {
    const m = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));
    expect(m.user_config).toBeTruthy();
    expect(m.user_config.vault_path).toBeTruthy();
    expect(m.user_config.vault_path.type).toBe('directory');
    expect(m.user_config.vault_path.required).toBe(true);
  });

  it('mcp_config.env wires vault_path → VAULTNEXUS_VAULT', () => {
    // daemon reads VAULTNEXUS_VAULT (src/daemon/main.ts), not VAULTNEXUS_VAULT_PATH
    const m = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));
    const env = m.server.mcp_config.env ?? {};
    expect(env.VAULTNEXUS_VAULT).toBe('${user_config.vault_path}');
  });

  it('mcp_config.env wires chat_api_key → VAULTNEXUS_CHAT_KEY (daemon name)', () => {
    // daemon reads VAULTNEXUS_CHAT_KEY (src/daemon/select-chat-model.ts), not _CHAT_API_KEY
    const m = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));
    const env = m.server.mcp_config.env ?? {};
    expect(env.VAULTNEXUS_CHAT_KEY).toBe('${user_config.chat_api_key}');
  });

  it('compatibility.platforms reflects single-platform reality', () => {
    // we only ship the build-host native better-sqlite3 binary → don't lie
    const m = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));
    expect(Array.isArray(m.compatibility.platforms)).toBe(true);
    expect(m.compatibility.platforms.length).toBeLessThanOrEqual(1);
  });
});
