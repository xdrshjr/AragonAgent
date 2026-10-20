#!/usr/bin/env node
/**
 * `npm run verify:test-gate` - the pre-flight gate of the release pipeline
 * (release-gate-and-native-panels §5.3).
 *
 * WHY THIS EXISTS. The release failed with 252 "failed" test files whose every
 * first error was `ENOENT ... %TEMP%/<nanoid>/ssr/.tmp-...`, and every one of them
 * passed when run alone. That is an environment fault wearing a code fault's
 * clothes, and the release script had no way to tell the two apart - so it stopped
 * the release, which is the safe half, and told nobody which half it was, which is
 * the useless half. This script is the part that names it.
 *
 * IT DOES EXACTLY THREE THINGS:
 *
 *  1. Version gate (default mode). Two manifests declare `vitest`, the installed
 *     tree provides `vitest` and `vite`, and a second nested copy of the runtime
 *     under `packages/cli` or `packages/core` is the only physical evidence that
 *     the two workspaces run on different test runtimes. All three numbers must be
 *     identical and exact; `^4.1.0` is what made "green yesterday, red today"
 *     possible in the first place.
 *
 *     The authority is the INSTALLED TREE, never `npm ls --json`: that command
 *     exits non-zero on any extraneous/peer complaint and its JSON shape follows the
 *     workspace count, so it is a display layer, not an assertion source.
 *
 *  2. Environment gate (default mode). The one directory the test runner depends on
 *     must be writable and must have room. A `%TEMP%` that is full or read-only
 *     produces the same wall of import-time failures, and it is worth one line of
 *     explanation before that happens rather than after.
 *
 *  3. Signature attribution (`--classify <logfile>`). Runs AFTER a failing test
 *     command, reads the captured log, and answers one question: was every failing
 *     file's first error the module-mirror ENOENT? If yes -> `environment` (exit 0,
 *     the release script may retry once). If even one failure is anything else ->
 *     `real` (exit 1, the release stops and never hides the error). Invoked through
 *     `npm run`, the flag needs a `--` separator in front of it - npm otherwise takes
 *     `--classify` as a config key and runs this script with the log path alone, which
 *     would run the gates and exit 0, i.e. answer "environment" for every failure. The
 *     argument guard in `main` makes that misuse fail instead of invert the verdict.
 *
 * WHAT THIS SCRIPT IS NOT. It does not run the tests, and it is not a fix. The fix
 * is `pool: 'threads'` in both vitest configs - the mirror directory does not exist
 * under that pool, so the race cannot happen. The classification and the single
 * conditional retry exist only for runs that still hit the old failure on somebody
 * else's machine, and the retry lives in `publish-latest.ps1`, not in a config:
 * `retry`, `--passWithNoTests` and exclusions are banned by I-12.
 */

import { accessSync, constants, existsSync, readFileSync, statfsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFESTS = ['packages/cli/package.json', 'packages/core/package.json'];
const NESTED_RUNTIMES = ['packages/cli/node_modules/vitest', 'packages/core/node_modules/vitest'];
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;
const MIN_FREE_BYTES = 500 * 1024 * 1024;
/** The module mirror's directory names, one per vitest environment. */
const MIRROR_DIRECTORY = /[\\/](ssr|client)[\\/]/;
/**
 * WHAT THE PALETTE LOOKS LIKE, AND WHY IT IS REMOVED FIRST.
 *
 * Vitest colors its report whenever the stream looks like a terminal, and the release
 * captures that stream through PowerShell unchanged, so a stored log legitimately begins
 * a banner with `ESC[41mESC[1m FAIL`. Every matcher below is anchored on plain text
 * (`^\s*FAIL`, `ENOENT`, `AssertionError`), so a colorized log matched NOTHING and the
 * gate answered "no FAIL line ... not a captured vitest failure" for a real failure it
 * had just been handed - the useless half of the job this gate exists to do. Color is
 * presentation, never evidence: strip it once, then judge the text.
 */
const ANSI_ESCAPES = [
  /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, // OSC (report titles, hyperlinks)
  /\u001b\[[0-9;:?]*[ -/]*[@-~]/g, // CSI (colors, cursor movement)
  /\u001b[@-Z\\-_]/g, // two-character escapes
];

function stripAnsi(text) {
  return ANSI_ESCAPES.reduce((plain, pattern) => plain.replace(pattern, ''), text);
}
/** A failure that is genuinely the test's own: these must never be classified away. */
const REAL_FAILURE = /AssertionError|Assertion failed|expected .+ to (?:be|equal|match)|snapshot .+ mismatched/i;

function environmentGuidance(failingFiles) {
  return [
    '[test-gate] 这个失败不是代码问题：vitest 的模块镜像目录在运行中被删除。',
    `失败的 ${failingFiles} 个文件全部在导入期 ENOENT（%TEMP%/<id>/<env>/...），单独重跑必绿。`,
    '处置：npm test -w packages/cli 重跑一次（环境瞬时故障），若复现请检查 %TEMP% 清理策略。',
  ].join('\n');
}

/** A gate failure with a message meant for a human, not a stack trace. */
class GateError extends Error {}

function readJson(relativePath) {
  const absolutePath = resolve(REPO_ROOT, relativePath);
  if (!existsSync(absolutePath)) {
    throw new GateError(`[test-gate] missing ${relativePath} - run this from the repository root`);
  }
  return JSON.parse(readFileSync(absolutePath, 'utf8'));
}

function readDeclaredVitest(relativePath) {
  const manifest = readJson(relativePath);
  const declared = manifest.devDependencies?.vitest;
  if (typeof declared !== 'string') {
    throw new GateError(`[test-gate] ${relativePath} does not declare devDependencies.vitest`);
  }
  return declared;
}

function readInstalledVersion(packageName) {
  const manifest = readJson(`node_modules/${packageName}/package.json`);
  if (typeof manifest.version !== 'string') {
    throw new GateError(`[test-gate] node_modules/${packageName}/package.json has no version`);
  }
  return manifest.version;
}

/**
 * Both declared ranges and the root `overrides` must be EXACT. A caret here means the
 * test runtime is the one dependency no test can protect, because it decides how the
 * tests themselves are executed.
 */
function assertExact(label, version) {
  if (!EXACT_VERSION.test(version)) {
    throw new GateError(
      `[test-gate] ${label} is "${version}" - the test runtime must be pinned to an exact `
      + 'version (no ^ or ~), or yesterday\'s green tree is not reproducible today',
    );
  }
}

function versionGate() {
  const declared = MANIFESTS.map((path) => ({ path, version: readDeclaredVitest(path) }));
  const installedVitest = readInstalledVersion('vitest');
  const installedVite = readInstalledVersion('vite');
  for (const entry of declared) assertExact(entry.path, entry.version);
  assertExact('node_modules/vitest', installedVitest);
  assertExact('node_modules/vite', installedVite);

  const overrides = readJson('package.json').overrides ?? {};
  assertExact('package.json overrides.vitest', String(overrides.vitest ?? ''));
  assertExact('package.json overrides.vite', String(overrides.vite ?? ''));

  const nested = NESTED_RUNTIMES.filter((path) => existsSync(resolve(REPO_ROOT, path)));
  const triple = `declared ${declared.map((entry) => `${entry.path}=${entry.version}`).join(', ')}`
    + ` / installed vitest ${installedVitest} / vite ${installedVite}`;
  if (nested.length > 0) {
    throw new GateError(
      `[test-gate] a second test runtime is installed at ${nested.join(', ')} - the two `
      + `workspaces would run different vitest builds (${triple})`,
    );
  }
  const mismatched = declared.filter((entry) => entry.version !== installedVitest);
  if (mismatched.length > 0
    || overrides.vitest !== installedVitest
    || overrides.vite !== installedVite) {
    throw new GateError(`[test-gate] test runtime versions disagree: ${triple}`);
  }
  console.log(`[test-gate] pinned: vitest ${installedVitest}, vite ${installedVite}`);
}

/**
 * The mirror directory's own host: writable, with room. `statfsSync` only exists from
 * Node 18.15, and this repository supports `>=18`, so the space half is capability
 * guarded and says so - a silent skip is indistinguishable from a passing check.
 */
function environmentGate() {
  const temporaryDirectory = process.env.TMPDIR || process.env.TEMP || process.env.TMP || '/tmp';
  try {
    accessSync(temporaryDirectory, constants.W_OK);
  } catch {
    throw new GateError(
      `[test-gate] the temporary directory ${temporaryDirectory} is not writable - the test `
      + 'runner mirrors modules into it, and an unwritable directory fails every import at once',
    );
  }
  if (typeof statfsSync !== 'function') {
    console.log('[test-gate] statfs unavailable - skipping the free-space check');
    return;
  }
  const stats = statfsSync(temporaryDirectory);
  const freeBytes = Number(stats.bavail) * Number(stats.bsize);
  if (Number.isFinite(freeBytes) && freeBytes < MIN_FREE_BYTES) {
    throw new GateError(
      `[test-gate] ${temporaryDirectory} has ${Math.round(freeBytes / 1048576)} MB free; the `
      + 'test run needs 500 MB for its module mirror',
    );
  }
  console.log(`[test-gate] environment: ${temporaryDirectory} writable, `
    + `${Math.round(freeBytes / 1048576)} MB free`);
}

/** Vitest prints one `FAIL <file>` banner per failing file; the first error follows it. */
function failingBlocks(lines) {
  const starts = [];
  lines.forEach((line, index) => {
    if (/^\s*FAIL\s+\S/.test(line)) starts.push(index);
  });
  return starts.map((start, position) => {
    const end = position + 1 < starts.length ? starts[position + 1] : lines.length;
    return { file: lines[start].trim().replace(/^\s*FAIL\s+/, ''), body: lines.slice(start + 1, end) };
  });
}

function isMirrorImportFailure(block) {
  const text = block.body.join('\n');
  if (REAL_FAILURE.test(text)) return false;
  return /ENOENT/.test(text) && MIRROR_DIRECTORY.test(text);
}

/**
 * `--classify <logfile>`: the only place that ever decides "this failure was the
 * environment". Strictness IS the feature (I-13) - one unrelated error and the answer
 * is `real`, because a classifier that can swallow a real failure is worse than no
 * classifier at all.
 */
function classify(logPath) {
  if (!existsSync(logPath)) {
    throw new GateError(`[test-gate] cannot classify: ${logPath} does not exist`);
  }
  // The palette and a leading BOM are artifacts of the capture, not text the failure is
  // made of; both are removed before any line is judged.
  const lines = stripAnsi(readFileSync(logPath, 'utf8'))
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/);
  const blocks = failingBlocks(lines);
  if (blocks.length === 0) {
    throw new GateError(
      `[test-gate] cannot classify: no "FAIL <file>" line in ${logPath} - the log was not a `
      + 'captured vitest failure',
    );
  }
  const genuine = blocks.filter((block) => !isMirrorImportFailure(block));
  if (genuine.length > 0) {
    throw new GateError(
      `[test-gate] real failure: ${genuine.length} of ${blocks.length} failing files are not the `
      + `module-mirror race (${genuine.slice(0, 5).map((block) => block.file).join(', ')})`,
    );
  }
  console.log(environmentGuidance(blocks.length));
  return blocks.length;
}

function main(argv) {
  const classifyIndex = argv.indexOf('--classify');
  if (classifyIndex >= 0) {
    const logPath = argv[classifyIndex + 1];
    if (!logPath) throw new GateError('[test-gate] --classify needs a log file path');
    classify(resolve(process.cwd(), logPath));
    return;
  }
  // AN UNEXPECTED ARGUMENT IS A BROKEN CALL, NOT A REASON TO RUN THE GATES. `npm run
  // <script> --classify <log>` silently drops the flag (npm takes it as a config key), so
  // this script would otherwise do the version/environment checks, exit 0, and the release
  // would read that 0 as "the failure was the environment" and retry a real failure.
  // Failing here converts that inversion into one sentence.
  if (argv.length > 0) {
    throw new GateError(
      `[test-gate] unexpected argument(s): ${argv.join(' ')} - attribution mode is `
      + '`--classify <logfile>`, and it needs a `--` separator in front of it when invoked '
      + 'through `npm run`, or npm swallows the flag and this script runs the gates instead '
      + 'of attributing the failure',
    );
  }
  versionGate();
  environmentGate();
}

try {
  main(process.argv.slice(2));
} catch (error) {
  const message = error instanceof GateError ? error.message : String(error && error.stack);
  console.error(message);
  process.exitCode = 1;
}
