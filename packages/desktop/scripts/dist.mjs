#!/usr/bin/env node
// Build an installer (or, with --dir, just the unpacked app).
//
//   node scripts/dist.mjs [--flavor=release|e2e] [--platform=win|mac|linux] [--dir] [--output=<dir>]
//
// `release` is the default and is what users get. `e2e` (also `ARAGON_E2E_BUILD=1`) differs in
// exactly two ways - the baked flavor and the inspector fuse - and goes to its own output
// directory so the two can never be confused. Signing is off and nothing is published: this script
// builds files, it does not release them.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chooseFlavor } from './lib/flavor.mjs';
import { fuseFlags } from './lib/fuses.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const value = (name) => argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);

const flavor = chooseFlavor(argv, process.env) ?? 'release';
if (flavor !== 'release' && flavor !== 'e2e') {
  console.error(`dist: flavor must be release or e2e (got "${flavor}")`);
  process.exit(2);
}
const platformName = value('platform') ?? ({ win32: 'win', darwin: 'mac', linux: 'linux' })[process.platform];
const nodePlatform = { win: 'win32', mac: 'darwin', linux: 'linux' }[platformName];
if (!nodePlatform) {
  console.error(`dist: unknown platform "${platformName}"`);
  process.exit(2);
}
const output = value('output') ?? (flavor === 'e2e' ? 'release-e2e' : 'release');

function run(command, args, env = {}) {
  const result = spawnSync(command, args, {
    cwd: root, stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, ...env },
  });
  if (result.status !== 0) {
    console.error(`dist: "${command} ${args.join(' ')}" failed`);
    process.exit(result.status ?? 1);
  }
}

run('node', ['scripts/build.mjs', `--flavor=${flavor}`]);
run('node', ['scripts/stage.mjs']);
run('npx', [
  'electron-builder', `--${platformName}`, ...(argv.includes('--dir') ? ['--dir'] : []),
  '--config', 'electron-builder.yml', '--publish', 'never',
  `-c.directories.output=${output}`, ...fuseFlags(flavor, nodePlatform),
], { CSC_IDENTITY_AUTO_DISCOVERY: 'false' });
console.log(`dist: ${flavor} build for ${platformName} written to ${output}/`);
