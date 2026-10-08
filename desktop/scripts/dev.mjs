/**
 * Dev orchestration: ensure the CLI is built, compile the Electron main once,
 * wait for the Next dev server, then run `tsc --watch` + electron together.
 *
 * Run from desktop/: `npm run dev`
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const repo = path.resolve(desktop, '..');
const cliDist = path.join(repo, 'packages', 'cli', 'dist', 'launcher.js');

function log(tag, text) {
  console.log(`[${tag}] ${text}`);
}

if (!existsSync(cliDist)) {
  log('dev', 'CLI runtime not built - building packages/core and packages/cli first...');
  const built = spawnSync('npm', ['run', 'build', '-w', 'packages/core', '-w', 'packages/cli'], {
    cwd: repo,
    stdio: 'inherit',
    shell: true,
  });
  if (built.status !== 0) {
    console.error('Failed to build the CLI runtime. See output above.');
    process.exit(1);
  }
}

// Compile the main process ONCE up front: launching electron before main.js
// exists just opens an error dialog.
log('dev', 'compiling electron main...');
const compiled = spawnSync('npx', ['tsc', '-p', 'tsconfig.electron.json'], {
  cwd: desktop,
  stdio: 'inherit',
  shell: true,
});
if (compiled.status !== 0) {
  console.error('Electron main failed to compile. See output above.');
  process.exit(1);
}

const children = [];

function run(name, command, args, color) {
  const child = spawn(command, args, {
    cwd: desktop,
    shell: true,
    env: { ...process.env, FORCE_COLOR: '1' },
  });
  const pipe = (stream) => {
    stream.setEncoding('utf8');
    let carry = '';
    stream.on('data', (chunk) => {
      carry += chunk;
      const lines = carry.split('\n');
      carry = lines.pop() ?? '';
      for (const line of lines) console.log(`${color}[${name}]${'\x1b[0m'} ${line}`);
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);
  child.on('exit', (code) => {
    log(name, `exited (${code})`);
    if (name === 'electron') {
      for (const other of children) {
        if (other !== child && other.exitCode === null) other.kill();
      }
    }
  });
  children.push(child);
  return child;
}

async function waitForNext() {
  // NB: no `shell: true` here and no `=>` in the probe script - cmd.exe treats
  // `>` as redirection and would shred an arrow function into garbage.
  const probeScript =
    "require('http').get('http://localhost:3000',function(){process.exit(0)}).on('error',function(){process.exit(1)})";
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const probe = spawnSync('node', ['-e', probeScript]);
    if (probe.status === 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  return false;
}

run('next', 'npx', ['next', 'dev', '-p', '3000'], '\x1b[35m');
log('dev', 'waiting for http://localhost:3000 ...');
const ready = await waitForNext();
if (!ready) {
  log('dev', 'next dev did not answer within 60s - launching electron anyway.');
}

run('tsc', 'npx', ['tsc', '-p', 'tsconfig.electron.json', '--watch', '--preserveWatchOutput'], '\x1b[36m');
run('electron', 'npx', ['electron', '.'], '\x1b[33m');

function shutdown() {
  for (const child of children) {
    if (child.exitCode === null) child.kill();
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
