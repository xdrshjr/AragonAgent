#!/usr/bin/env node
// Assemble `build-staging/engine`: the engine EXACTLY as a user gets it from `npm i -g`, plus the
// desktop's session-host files.
//
// Why `npm install --omit=dev --omit=optional` from the REGISTRY instead of copying node_modules:
//   - the installed copy of @aragon-agent/{core,tui,cli} is then the published shape, and a
//     dependency a package forgot to declare fails HERE with ERR_MODULE_NOT_FOUND instead of on a
//     user's machine (the same guarantee `verify-packed-install` gives the CLI);
//   - `--omit=optional` is not optional: core declares `isolated-vm` as an optional dependency,
//     and `--omit=dev` alone still installs it - compiling a native addon for NODE's ABI (not
//     Electron's) on some build machines and silently skipping it on others. The host never loads
//     the sandbox, so it is dead weight at best and a non-reproducible binary at worst.
//
// The engine is NOT part of this repository: `@aragon-agent/{core,tui,cli}` are published npm
// packages, and the versions come from this package's own `dependencies` - never `latest` - so the
// staged tree is the same engine `npm install` gives a developer. The manifest records both the
// declared range and what the registry resolved it to.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGINE, readDeclaredEngineRanges, satisfies } from './lib/engine-versions.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const staging = join(root, 'build-staging');
const engine = join(staging, 'engine');

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) {
    console.error(`stage: "${command} ${args.join(' ')}" failed (exit ${result.status})`);
    process.exit(result.status ?? 1);
  }
}

if (!existsSync(join(root, 'dist', 'host', 'entry.js'))) {
  console.error('stage: run `npm run build` first (dist/host/entry.js is missing).');
  process.exit(1);
}

// 1. What the desktop itself declares. An engine specifier that is not a registry range (a
//    `workspace:`/`file:`/`link:` protocol or `*`) would install something else here, so it is
//    rejected rather than guessed at.
let declared;
try {
  declared = readDeclaredEngineRanges(root);
} catch (error) {
  console.error(`stage: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
const dependencies = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).dependencies ?? {};

rmSync(staging, { recursive: true, force: true });
mkdirSync(engine, { recursive: true });

// 2. Install the engine at its declared versions plus the desktop's own direct runtime dependencies
//    into one node_modules. The flags are a user's install of the published packages, minus the
//    things a build machine must not do (audit, fund, lockfile).
const specs = Object.entries(dependencies).map(([dep, range]) => `${dep}@${range}`);
writeFileSync(join(engine, 'package.json'), JSON.stringify({ name: 'aragon-engine', private: true, type: 'module' }, null, 2));
run('npm', [
  'install', '--omit=dev', '--omit=optional', '--no-audit', '--no-fund', '--no-package-lock',
  ...specs,
], engine);

// 3. Read back what the registry resolved. A range that no longer resolves to something inside it
//    (a yanked version, a hand-edited range) is a failure here, not a surprise on a user's machine.
const installed = {};
const problems = [];
for (const name of ENGINE) {
  const manifestPath = join(engine, 'node_modules', '@aragon-agent', name, 'package.json');
  if (!existsSync(manifestPath)) {
    problems.push(`@aragon-agent/${name} is not installed`);
    continue;
  }
  const version = JSON.parse(readFileSync(manifestPath, 'utf8')).version;
  installed[name] = version;
  const ok = satisfies(version, declared[name]);
  if (ok === null) problems.push(`@aragon-agent/${name}: cannot compare installed ${version} with declared ${declared[name]}`);
  else if (!ok) problems.push(`@aragon-agent/${name}: installed ${version} does not satisfy declared ${declared[name]}`);
}
if (existsSync(join(engine, 'node_modules', 'isolated-vm'))) problems.push('isolated-vm was installed (--omit=optional did not take effect)');
if (problems.length > 0) {
  console.error(problems.map((line) => `stage: ${line}`).join('\n'));
  process.exit(1);
}

// 4. The host: compiled desktop code that statically imports the engine, so it must sit beside
//    `engine/node_modules` for ordinary resolution to find it.
mkdirSync(join(engine, 'host'), { recursive: true });
cpSync(join(root, 'dist', 'host'), join(engine, 'host'), {
  recursive: true,
  filter: (source) => !source.endsWith('.d.ts') && !source.includes('__tests__'),
});
mkdirSync(join(engine, 'shared'), { recursive: true });
cpSync(join(root, 'dist', 'shared'), join(engine, 'shared'), {
  recursive: true,
  filter: (source) => !source.endsWith('.d.ts') && !source.includes('__tests__'),
});
// The compiled host imports `../shared/*.js`; the engine dir's package.json makes both ESM.

writeFileSync(join(staging, 'manifest.json'), JSON.stringify({
  source: 'registry',
  engine: { core: installed.core, tui: installed.tui, cli: installed.cli },
  declared,
  stagedAt: new Date().toISOString(),
}, null, 2));
console.log(`stage: engine ready in ${engine} (core ${installed.core}, tui ${installed.tui}, cli ${installed.cli} - from the npm registry)`);
