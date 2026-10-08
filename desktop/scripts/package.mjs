/**
 * Full packaging pipeline: renderer export -> electron main compile ->
 * runtime staging -> electron-builder (NSIS + portable for Windows x64).
 *
 * Run from desktop/: `npm run package`
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const repo = path.resolve(desktop, '..');

function log(text) {
  console.log(`[package] ${text}`);
}

function run(command, args, cwd, opts = {}) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: true, ...opts });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (exit ${result.status})`);
  }
}

function mustExist(file, hint) {
  if (!existsSync(file)) {
    throw new Error(`Missing ${path.relative(repo, file)} - ${hint}`);
  }
}

// electron-builder wants build/icon.png (>= 256px) - reuse the repo logo.
const buildDir = path.join(desktop, 'build');
mkdirSync(buildDir, { recursive: true });
const logoSource = path.join(repo, 'logo', 'logo-circle.png');
if (existsSync(logoSource)) {
  copyFileSync(logoSource, path.join(buildDir, 'icon.png'));
  log('icon copied from logo/logo-circle.png');
}

log('building renderer (next static export)...');
run('npx', ['next', 'build'], desktop);

log('compiling electron main...');
run('npx', ['tsc', '-p', 'tsconfig.electron.json'], desktop);

log('staging agent runtime...');
run('node', [path.join('scripts', 'stage-agent-runtime.mjs')], desktop, {
  env: { ...process.env, ARAGON_SKIP_BUILD: '1' },
});

mustExist(path.join(desktop, 'out', 'index.html'), 'renderer export incomplete');
mustExist(
  path.join(desktop, 'agent-runtime', 'node_modules', '@aragon-agent', 'cli', 'dist', 'launcher.js'),
  'runtime staging incomplete',
);
mustExist(path.join(desktop, 'dist-electron', 'electron', 'main.js'), 'electron compile failed');

log('running electron-builder...');
run('npx', ['electron-builder', '--win', '--config', 'electron-builder.yml'], desktop);

log('done - see desktop/release/');
