#!/usr/bin/env tsx
// build-mcpb → produces dist-mcpb/vaultnexus-<version>.mcpb
// zip layout: manifest.json + server/{dist,package.json,node_modules(prod)}
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  readdirSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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

  // Compile src → dist (idempotent; skip in tests for speed)
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

  // dist → server/dist
  cpSync(distDir, join(staging, 'server', 'dist'), { recursive: true });

  // package.json (deps-only) → server/package.json
  // strip devDeps + scripts → host won't try to run lifecycle hooks
  const trimmed: PackageJson & { type?: string; engines?: unknown; bin?: unknown } = {
    name: pkg.name,
    version: pkg.version,
    dependencies: pkg.dependencies ?? {},
  };
  // preserve ESM marker — runtime needs it
  const fullPkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8'));
  if (fullPkg.type) trimmed.type = fullPkg.type;
  if (fullPkg.engines) trimmed.engines = fullPkg.engines;
  if (fullPkg.bin) trimmed.bin = fullPkg.bin;
  writeFileSync(
    join(staging, 'server', 'package.json'),
    JSON.stringify(trimmed, null, 2) + '\n',
  );

  // prod node_modules → server/node_modules
  copyProdNodeModules(repoRoot, join(staging, 'server', 'node_modules'), trimmed.dependencies ?? {});

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
  execFileSync('npx', ['tsc', '-p', 'tsconfig.build.json'], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, PATH: process.env.PATH ?? '' },
  });
}

// Copy each prod dep from node_modules → staging.
// Walks the resolved tree once per dep so transitive deps come along.
// Strips .bin, .cache, *.md, test/, docs/ → keep size sane.
function copyProdNodeModules(
  repoRoot: string,
  dest: string,
  deps: Record<string, string>,
): void {
  const srcRoot = join(repoRoot, 'node_modules');
  if (!existsSync(srcRoot)) {
    throw new Error(`build-mcpb: node_modules/ missing → run pnpm install first`);
  }
  mkdirSync(dest, { recursive: true });

  const visited = new Set<string>();
  const queue: string[] = Object.keys(deps);

  while (queue.length > 0) {
    const name = queue.shift()!;
    if (visited.has(name)) continue;
    visited.add(name);

    const src = join(srcRoot, name);
    if (!existsSync(src)) continue; // optional dep / missing → skip
    const target = join(dest, name);
    if (name.includes('/')) mkdirSync(dirname(target), { recursive: true });

    cpSync(src, target, {
      recursive: true,
      filter: (s) => {
        const base = s.split('/').pop() ?? '';
        // size trims; safe-ish for runtime
        if (base === '.bin' || base === '.cache') return false;
        if (base === 'test' || base === 'tests' || base === '__tests__') return false;
        if (base === 'docs' || base === 'doc' || base === 'example' || base === 'examples') return false;
        if (base.endsWith('.md') || base.endsWith('.markdown')) return false;
        if (base === '.github' || base === '.gitignore') return false;
        return true;
      },
    });

    // enqueue transitive prod deps
    const subPkgPath = join(src, 'package.json');
    if (existsSync(subPkgPath)) {
      try {
        const subPkg = JSON.parse(readFileSync(subPkgPath, 'utf-8'));
        if (subPkg.dependencies) queue.push(...Object.keys(subPkg.dependencies));
      } catch {
        // bad package.json → skip
      }
    }
  }

  // walk node_modules root for scoped/hoisted siblings the deep walk missed
  // pnpm flat layout → some subdeps resolved at root, not under their parent
  for (const entry of readdirSync(srcRoot)) {
    if (entry.startsWith('.')) continue;
    if (entry.startsWith('@')) {
      // scoped → recurse one level
      const scopeDir = join(srcRoot, entry);
      if (!statSync(scopeDir).isDirectory()) continue;
      for (const scoped of readdirSync(scopeDir)) {
        const full = `${entry}/${scoped}`;
        if (visited.has(full)) continue;
        // only copy if any visited dep declared it transitively
        // skip otherwise → avoid pulling devDeps
      }
    }
  }
}

function zipDir(src: string, outPath: string): void {
  // -r recurse; -X strip extra attrs; -q quiet. Run inside src so paths are relative.
  execFileSync('zip', ['-r', '-q', '-X', outPath, '.'], {
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
