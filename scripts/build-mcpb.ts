#!/usr/bin/env tsx
// build-mcpb → dist-mcpb/vaultnexus-<version>.mcpb
// zip layout: manifest.json + server/{dist,package.json,node_modules(prod)}
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface PackageJson {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
}

interface ManifestJson {
  manifest_version: string;
  name: string;
  version: string;
  [k: string]: unknown;
}

interface BuildOptions {
  repoRoot?: string;
  outDir?: string;
  skipBuild?: boolean;
  // skipNodeModules → useful for tests that mirror a fake repo without real pnpm workspace
  skipNodeModules?: boolean;
}

interface BuildResult {
  mcpbPath: string;
  version: string;
  stagingDir: string;
  manifest: ManifestJson;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(HERE, '..');

export async function buildMcpb(opts: BuildOptions = {}): Promise<BuildResult> {
  const repoRoot = opts.repoRoot ? resolve(opts.repoRoot) : DEFAULT_REPO_ROOT;
  const outDir = opts.outDir ? resolve(opts.outDir) : join(repoRoot, 'dist-mcpb');

  const pkg = readPackageJson(join(repoRoot, 'package.json'));
  const manifest = readManifest(join(repoRoot, 'mcpb', 'manifest.json'));

  // version sync → package.json wins
  manifest.version = pkg.version;

  // compile src → dist (idempotent; skip in tests for speed)
  if (!opts.skipBuild) {
    runTsBuild(repoRoot);
  }
  const distDir = join(repoRoot, 'dist');
  if (!existsSync(join(distDir, 'bridge', 'main.js'))) {
    throw new Error(`build-mcpb: ${distDir}/bridge/main.js missing (tsc output)`);
  }

  // staging → outDir/build/{server/{dist,node_modules,package.json}, manifest.json}
  const staging = join(outDir, 'build');
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(join(staging, 'server'), { recursive: true });

  // dist → server/dist (strip *.map → bundle slim)
  cpSync(distDir, join(staging, 'server', 'dist'), {
    recursive: true,
    filter: (s) => !basename(s).endsWith('.map'),
  });

  // package.json (deps-only) → server/package.json
  // strip devDeps + scripts → host won't run lifecycle hooks
  const trimmed: PackageJson & { type?: string; engines?: unknown; bin?: unknown } = {
    name: pkg.name,
    version: pkg.version,
    dependencies: pkg.dependencies ?? {},
  };
  // preserve ESM marker → runtime needs it
  const fullPkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8'));
  if (fullPkg.type) trimmed.type = fullPkg.type;
  if (fullPkg.engines) trimmed.engines = fullPkg.engines;
  if (fullPkg.bin) trimmed.bin = fullPkg.bin;
  writeFileSync(
    join(staging, 'server', 'package.json'),
    JSON.stringify(trimmed, null, 2) + '\n',
  );

  // prod node_modules → server/node_modules (pnpm deploy → real transitives via .pnpm)
  if (!opts.skipNodeModules) {
    copyProdNodeModules(repoRoot, pkg.name, join(staging, 'server'));
  }

  // manifest → staging root (version-synced)
  writeFileSync(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  // zip → outDir/vaultnexus-<version>.mcpb
  mkdirSync(outDir, { recursive: true });
  const mcpbPath = join(outDir, `${pkg.name}-${pkg.version}.mcpb`);
  rmSync(mcpbPath, { force: true });
  zipDir(staging, mcpbPath);

  return { mcpbPath, version: pkg.version, stagingDir: staging, manifest };
}

function readPackageJson(path: string): PackageJson {
  const raw = JSON.parse(readFileSync(path, 'utf-8'));
  if (!raw.version) throw new Error(`build-mcpb: package.json missing version`);
  return raw;
}

function readManifest(path: string): ManifestJson {
  const raw = JSON.parse(readFileSync(path, 'utf-8'));
  for (const req of ['manifest_version', 'name', 'version']) {
    if (!raw[req]) throw new Error(`build-mcpb: manifest.json missing ${req}`);
  }
  return raw;
}

function runTsBuild(repoRoot: string): void {
  // local tsc → reproducible (no npx fetch)
  const localTsc = join(repoRoot, 'node_modules', '.bin', 'tsc');
  if (!existsSync(localTsc)) {
    throw new Error(`build-mcpb: ${localTsc} missing → run pnpm install first`);
  }
  execFileSync(localTsc, ['-p', 'tsconfig.build.json'], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, PATH: process.env.PATH ?? '' },
  });
}

// pnpm deploy → temp dir → copy node_modules with symlinks preserved.
// pnpm flat layout: top-level node_modules/<dep> → symlink → .pnpm/<pkg>@<ver>/node_modules/<dep>.
// Transitives (bindings, ajv, etc.) ONLY exist under .pnpm/. The old walker
// missed them → 46/67 deps dropped silently → runtime "Cannot find module" crashes.
// pnpm deploy is purpose-built for this → emits a self-contained tree with
// hoisted symlinks + .pnpm virtual store. cpSync verbatimSymlinks → preserves
// relative symlinks → node resolution follows them at runtime.
function copyProdNodeModules(repoRoot: string, pkgName: string, serverDir: string): void {
  const srcRoot = join(repoRoot, 'node_modules');
  if (!existsSync(srcRoot)) {
    throw new Error(`build-mcpb: node_modules/ missing → run pnpm install first`);
  }

  // pnpm deploy populates a full project layout → we want only its node_modules
  const deployTmp = mkdtempSync(join(tmpdir(), 'vn-mcpb-deploy-'));
  try {
    runPnpmDeploy(repoRoot, pkgName, deployTmp);

    const deployedNm = join(deployTmp, 'node_modules');
    if (!existsSync(deployedNm)) {
      throw new Error(`build-mcpb: pnpm deploy produced no node_modules at ${deployedNm}`);
    }

    const dest = join(serverDir, 'node_modules');
    mkdirSync(dest, { recursive: true });

    cpSync(deployedNm, dest, {
      recursive: true,
      verbatimSymlinks: true, // preserve relative symlinks → runtime resolves correctly
      filter: (s) => {
        const base = basename(s);
        // size trims; safe-ish for runtime
        if (base === '.bin' || base === '.cache') return false;
        if (base === 'test' || base === 'tests' || base === '__tests__') return false;
        if (base === 'docs' || base === 'doc' || base === 'example' || base === 'examples') return false;
        if (base.endsWith('.md') || base.endsWith('.markdown')) return false;
        if (base.endsWith('.map')) return false; // source maps → bundle slim
        if (base === '.github' || base === '.gitignore') return false;
        return true;
      },
    });
  } finally {
    rmSync(deployTmp, { recursive: true, force: true });
  }
}

function runPnpmDeploy(repoRoot: string, pkgName: string, target: string): void {
  // pnpm v10+ requires --legacy unless inject-workspace-packages=true is set.
  // --prod → strips devDeps; --filter=<name> → selects this package from workspace root.
  // target must NOT pre-exist (pnpm deploy creates it).
  rmSync(target, { recursive: true, force: true });

  // pnpm caches a workspace-state file that makes deploy a silent no-op when it
  // thinks nothing changed → produces empty target. Clear it → forces real deploy.
  // → https://github.com/pnpm/pnpm/issues/8635
  const stateFile = join(repoRoot, 'node_modules', '.pnpm-workspace-state-v1.json');
  if (existsSync(stateFile)) {
    rmSync(stateFile, { force: true });
  }

  try {
    execFileSync(
      'pnpm',
      ['--filter', pkgName, 'deploy', '--legacy', '--prod', target],
      {
        cwd: repoRoot,
        stdio: 'inherit',
        env: { ...process.env, PATH: process.env.PATH ?? '' },
      },
    );
  } catch (err) {
    throw new Error(
      `build-mcpb: pnpm deploy failed → ensure pnpm v10+ on PATH and run from workspace root. ${(err as Error).message}`,
    );
  }
}

function zipDir(src: string, outPath: string): void {
  // -r recurse; -y preserve symlinks (critical → pnpm tree has relative symlinks);
  // -X strip extra attrs; -q quiet. cwd src → paths are relative.
  execFileSync('zip', ['-r', '-y', '-q', '-X', outPath, '.'], {
    cwd: src,
    stdio: 'inherit',
  });
}

// CLI entry
const invokedDirectly =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('build-mcpb.ts') ||
  process.argv[1]?.endsWith('build-mcpb.js');

if (invokedDirectly) {
  buildMcpb()
    .then((r) => {
      const sizeMb = (statSync(r.mcpbPath).size / 1024 / 1024).toFixed(1);
      process.stdout.write(`built ${r.mcpbPath} (${sizeMb} MB)\n`);
    })
    .catch((err) => {
      process.stderr.write(`build-mcpb failed: ${(err as Error).message}\n`);
      process.exit(1);
    });
}
