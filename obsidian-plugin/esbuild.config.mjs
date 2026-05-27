// Bundle src/main.ts → main.js (CJS, single file). Obsidian loads CJS at runtime.
import esbuild from 'esbuild';

const isWatch = process.argv.includes('--watch');

const opts = {
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: ['obsidian', 'electron'],
  format: 'cjs',
  platform: 'browser',
  target: 'es2020',
  outfile: 'main.js',
  sourcemap: isWatch ? 'inline' : false,
  logLevel: 'info',
};

if (isWatch) {
  const ctx = await esbuild.context(opts);
  await ctx.watch();
} else {
  await esbuild.build(opts);
}
