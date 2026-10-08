/**
 * Stage the self-contained agent runtime for packaging.
 *
 * Produces desktop/agent-runtime/: a plain npm install of `npm pack`ed
 * @aragon-agent/core + @aragon-agent/cli tarballs (production deps only,
 * optional deps skipped - no isolated-vm, no ajv download), so the packaged
 * app can spawn `ELECTRON_RUN_AS_NODE <resources>/agent-runtime/.../launcher.js`
 * with zero dependency on the user's Node installation or the monorepo.
 *
 * Steps:
 *   1. build core + cli (unless dist already present and ARAGON_SKIP_BUILD=1)
 *   2. npm pack both packages into a temp dir
 *   3. clean desktop/agent-runtime, write a stub package.json
 *   4. npm install the two tarballs --omit=dev --omit=optional
 */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const repo = path.resolve(desktop, '..');
const coreDir = path.join(repo, 'packages', 'core');
const cliDir = path.join(repo, 'packages', 'cli');
const outDir = path.join(desktop, 'agent-runtime');

function log(text) {
  console.log(`[stage-runtime] ${text}`);
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: true });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (exit ${result.status})`);
  }
}

const skipBuild = process.env.ARAGON_SKIP_BUILD === '1';
const coreBuilt = existsSync(path.join(coreDir, 'dist', 'index.js'));
const cliBuilt = existsSync(path.join(cliDir, 'dist', 'launcher.js'));

if (!skipBuild || !coreBuilt || !cliBuilt) {
  log('building packages/core and packages/cli...');
  run('npm', ['run', 'build', '-w', 'packages/core', '-w', 'packages/cli'], repo);
} else {
  log('skipping workspace build (ARAGON_SKIP_BUILD=1 and dist present)');
}

const tmp = mkdtempSync(path.join(os.tmpdir(), 'aragon-runtime-'));
try {
  log(`packing into ${tmp}...`);
  run('npm', ['pack', coreDir, '--pack-destination', tmp], repo);
  run('npm', ['pack', cliDir, '--pack-destination', tmp], repo);

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    path.join(outDir, 'package.json'),
    JSON.stringify(
      {
        name: 'aragon-agent-desktop-runtime',
        version: '0.0.0',
        private: true,
        description: 'Bundled aragon agent runtime for the AragonAgent desktop app.',
      },
      null,
      2,
    ),
  );

  // npm pack names files <name>-<version>.tgz; resolve them dynamically.
  const { readdirSync } = await import('node:fs');
  const files = readdirSync(tmp).filter((file) => file.endsWith('.tgz'));
  if (files.length !== 2) {
    throw new Error(`expected 2 tarballs, found: ${files.join(', ')}`);
  }
  const tarballs = files.map((file) => path.join(tmp, file));

  log('installing runtime dependencies (prod only)...');
  run('npm', ['install', '--omit=dev', '--omit=optional', '--no-audit', '--no-fund', ...tarballs], outDir);

  const launcher = path.join(outDir, 'node_modules', '@aragon-agent', 'cli', 'dist', 'launcher.js');
  if (!existsSync(launcher)) {
    throw new Error(`staged launcher missing: ${launcher}`);
  }

  // Copy the skills runtime assets the CLI ships (`skills/` is in its files list).
  const cliSkills = path.join(cliDir, 'skills');
  if (existsSync(cliSkills)) {
    cpSync(cliSkills, path.join(outDir, 'node_modules', '@aragon-agent', 'cli', 'skills'), {
      recursive: true,
    });
  }

  log(`runtime staged at ${outDir} (launcher: ${launcher})`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
