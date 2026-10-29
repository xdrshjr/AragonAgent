#!/usr/bin/env node
// The CI steps for the desktop app, in ONE place. A workflow file only calls this, so everything CI
// does can be run on a developer machine, and nothing about the pipeline is tied to a particular CI
// vendor (spec D-6).
//
//   node scripts/ci-desktop.mjs verify            typecheck + unit tests (no display needed)
//   node scripts/ci-desktop.mjs e2e-win           E2E on source, E2E on the packaged E2E build,
//                                                 then the RELEASE build verified + smoke-tested
//   node scripts/ci-desktop.mjs package <win|mac|linux>   unsigned build + verify-bundle + smoke
//
// Every step is a plain command, run INSIDE this package (no `-w packages/...`: the engine is a
// published npm dependency here, not a workspace sibling). A failing step stops the run with its
// exit code. `bench` never fails the run: shared CI machines are too noisy to judge a latency
// budget on (see README, "Performance baseline") - it uploads the report and nothing more.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..');
const [mode, platformArg] = process.argv.slice(2);

/** The environment every step runs in: no ELECTRON_RUN_AS_NODE (it turns Electron into plain Node). */
function stepEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function run(label, command, args, options = {}) {
  console.log(`\n== ${label}\n$ ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, {
    // `shell` is for .cmd shims (npm, npx) on Windows.
    cwd: options.cwd ?? desktop, stdio: 'inherit', shell: options.shell ?? process.platform === 'win32', env: stepEnv(options.env),
  });
  if (result.status !== 0) {
    if (options.soft) { console.warn(`(${label} failed with ${result.status}; reported, not fatal)`); return; }
    console.error(`\nci-desktop: step "${label}" failed (exit ${result.status ?? 'signal'})`);
    process.exit(result.status ?? 1);
  }
}

const npm = (label, script, extra = []) => run(label, 'npm', ['run', script, ...(extra.length ? ['--', ...extra] : [])]);

function packagedApp(dir, platform) {
  if (platform === 'win') return join(desktop, dir, 'win-unpacked');
  if (platform === 'mac') return join(desktop, dir, existsSync(join(desktop, dir, 'mac-arm64')) ? 'mac-arm64' : 'mac');
  return join(desktop, dir, 'linux-unpacked');
}

const hostPlatform = { win32: 'win', darwin: 'mac', linux: 'linux' }[process.platform];

function exeOf(appDir, platform) {
  if (platform === 'win') return join(appDir, 'AragonAgent.exe');
  if (platform === 'mac') return join(appDir, 'AragonAgent.app', 'Contents', 'MacOS', 'AragonAgent');
  return join(appDir, 'aragonagent');
}

/** `--smoke` needs a display on Linux; `xvfb-run` supplies one on a headless runner. */
function smoke(appDir, platform) {
  const exe = exeOf(appDir, platform);
  const args = ['--smoke', ...(platform === 'linux' ? ['--no-sandbox'] : [])];
  if (platform === 'linux' && process.env.DISPLAY === undefined) run('smoke (xvfb)', 'xvfb-run', ['-a', exe, ...args]);
  else run('smoke', exe, args);
}

switch (mode) {
  case 'verify':
    // The layering check and the test-case ledger are NOT here any more: both compare this package
    // against the engine sources, which are not part of this repo, and neither is that spec tree
    // of this repository (the engine is a published npm dependency). What is left still catches the
    // failures that made those steps worth having: a type error, or a unit test that broke.
    npm('typecheck (main/host/shared, renderer, tests)', 'typecheck');
    npm('tests (unit; no display, no E2E)', 'test');
    break;

  case 'e2e-win': {
    npm('build (dev flavor, for source E2E)', 'build');
    // E2E_REPEAT=3 (release review) runs the whole suite three times and fails on any case that is not green
    // every time; the default is one plain run.
    const repeat = Number(process.env.E2E_REPEAT ?? 1) || 1;
    const e2e = (label, env) => (repeat > 1
      ? run(label, 'npm', ['run', 'test:e2e:repeat', '--', `--runs=${repeat}`], { env })
      : run(label, 'npm', ['run', 'test:e2e'], { env }));
    e2e('E2E against the source build', {});
    npm('E2E-flavor package', 'dist:e2e');
    e2e('E2E against the packaged E2E build', { ARAGON_E2E_APP: exeOf(packagedApp('release-e2e', 'win'), 'win') });
    run('release-flavor package', 'node', ['scripts/dist.mjs', '--dir', '--flavor=release'], { cwd: desktop });
    const app = packagedApp('release', 'win');
    run('verify-bundle (release: flavor + fuses)', 'node', ['scripts/verify-bundle.mjs', '--app', app, '--flavor', 'release', '--platform', 'win32'], { cwd: desktop });
    smoke(app, 'win');
    run('bench (report only, never fails)', 'node', ['scripts/bench.mjs', '--suite=startup,stream', '--runs=5'], { cwd: desktop, soft: true });
    break;
  }

  case 'package': {
    const platform = platformArg ?? hostPlatform;
    if (!['win', 'mac', 'linux'].includes(platform)) { console.error(`ci-desktop: unknown platform "${platform}"`); process.exit(2); }
    if (platform !== hostPlatform) { console.error(`ci-desktop: cannot build ${platform} on ${hostPlatform}`); process.exit(2); }
    run('release package (unsigned, nothing published)', 'node', ['scripts/dist.mjs', '--flavor=release', '--platform=' + platform], { cwd: desktop });
    const nodePlatform = { win: 'win32', mac: 'darwin', linux: 'linux' }[platform];
    const app = packagedApp('release', platform);
    run('verify-bundle', 'node', ['scripts/verify-bundle.mjs', '--app', app, '--flavor', 'release', '--platform', nodePlatform], { cwd: desktop });
    smoke(app, platform);
    break;
  }

  default:
    console.error('usage: ci-desktop.mjs verify | e2e-win | package [win|mac|linux]');
    process.exit(2);
}
console.log(`\nci-desktop: ${mode} OK`);
