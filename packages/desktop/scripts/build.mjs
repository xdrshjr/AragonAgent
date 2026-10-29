#!/usr/bin/env node
// Build the desktop app: main/host/shared with tsc, the preload as ONE CommonJS file with
// esbuild, and the renderer with Vite. Run `--only=main|preload|renderer` to rebuild one part.
//
// Why the preload is bundled: a sandboxed preload can `require` almost nothing, and it must be
// CommonJS even though this package is `"type": "module"`, so it gets its own `.cjs` output.
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bakeFlavorFile, chooseFlavor } from './lib/flavor.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const only = (process.argv.find((arg) => arg.startsWith('--only=')) ?? '').slice('--only='.length);
const wants = (part) => only === '' || only === part;

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) {
    console.error(`desktop build: "${command} ${args.join(' ')}" failed`);
    process.exit(result.status ?? 1);
  }
}

if (only === '') {
  // The TypeScript outputs only; the renderer is rebuilt below with `emptyOutDir`.
  for (const dir of ['main', 'host', 'shared', 'preload']) rmSync(join(root, 'dist', dir), { recursive: true, force: true });
}

if (wants('main')) {
  run('npx', ['tsc', '-p', 'tsconfig.json']);
  // Bake the flavor into the COMPILED file only (never the source). No flag = unbaked: such a build
  // is `dev` unpackaged and `release` once packaged, so the only way to get `e2e` is to ask for it.
  const flavor = chooseFlavor(process.argv.slice(2), process.env);
  if (flavor) {
    bakeFlavorFile(join(root, 'dist', 'main', 'build-flavor.js'), flavor);
    console.log(`desktop build: baked flavor "${flavor}"`);
  }
}

if (wants('preload')) {
  const { build } = await import('esbuild');
  await build({
    entryPoints: [join(root, 'src', 'preload', 'index.ts')],
    outfile: join(root, 'dist', 'preload', 'index.cjs'),
    bundle: true, platform: 'node', format: 'cjs', target: 'node20',
    external: ['electron'], sourcemap: false, logLevel: 'info',
  });
}

if (wants('renderer')) {
  const { build } = await import('vite');
  await build({ configFile: join(root, 'vite.config.ts'), logLevel: 'info' });
}
console.log('desktop build: done');
