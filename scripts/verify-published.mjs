#!/usr/bin/env node
/**
 * Post-publish verification (C4).
 *
 * The machine verdict behind the requirement "after it is published it must be
 * aragon too". Every APPLICABLE check has to pass for exit 0; anything skipped
 * prints SKIPPED and is neither counted as a failure nor dressed up as a PASS.
 *
 * Registry discipline is the same as the preflight's: every npm call pins
 * `--registry ${NPMJS}`. A just-published package is either missing from the
 * local mirror or lags on the `deprecated` field, so reading the mirror makes
 * V1/V3/V5 report red after a completely successful release.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import { NPMJS, createNpmRunner, findLegacyBrandHits, parseNpmJson } from './assert-brand-clean.mjs';
import { GIT_LS_REMOTE_TIMEOUT_MS } from './release-preflight.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

export const NEW_CORE = '@aragon-agent/core';
export const NEW_CLI = '@aragon-agent/cli';

// The last versions ever published under the misspelled scope (S4).
export const LEGACY_CORE = { name: '@argon-agent/core', version: '0.1.2' };
export const LEGACY_CLI = { name: '@argon-agent/cli', version: '0.4.2' };

export const REMOTE_PROBE_FILE = 'packages/core/package.json';
export const REMOTE_PROBE_METHOD = 'raw.githubusercontent.com';

/** `git+https://github.com/o/r.git` -> `https://raw.githubusercontent.com/o/r/HEAD/<file>` */
export function toRawContentUrl(repositoryUrl, filePath) {
  const cleaned = String(repositoryUrl ?? '').replace(/^git\+/, '');
  const match = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(cleaned);
  if (!match) {
    return null;
  }
  return `https://raw.githubusercontent.com/${match[1]}/${match[2]}/HEAD/${filePath}`;
}

export function satisfiesCaret(actual, base) {
  const parse = (value) => {
    const parsed = /^(\d+)\.(\d+)\.(\d+)/.exec(String(value ?? ''));
    return parsed ? parsed.slice(1, 4).map(Number) : null;
  };
  const left = parse(actual);
  const right = parse(base);
  if (!left || !right) {
    return false;
  }
  if (left[0] !== right[0]) {
    return false;
  }
  // Caret on a 0.x base pins the minor as well.
  if (right[0] === 0 && left[1] !== right[1]) {
    return false;
  }
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] > right[index];
    }
  }
  return true;
}

function collapse(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(' | ');
}

// npm dumps a dozen lines plus a log path on every 404; a verdict table that
// scrolls off the screen cannot be read in five seconds.
const ERROR_EXCERPT_LIMIT = 220;

function briefly(text) {
  const collapsed = collapse(text);
  return collapsed.length > ERROR_EXCERPT_LIMIT
    ? `${collapsed.slice(0, ERROR_EXCERPT_LIMIT)} [...]`
    : collapsed;
}

/**
 * @param {object} deps
 * @param {(args: string[]) => { status: number|null, stdout?: string, stderr?: string }} deps.npm
 * @param {(args: string[], options: object) => { status: number|null, stdout?: string, stderr?: string }} deps.git
 * @param {(url: string) => Promise<{ ok: boolean, status?: number, text?: string, error?: string }>} deps.fetchText
 * @param {(input: { coreVersion: string, cliVersion: string }) => { ok: boolean, detail: string }} deps.installSmoke
 * @param {string} deps.coreVersion
 * @param {string} deps.cliVersion
 * @param {boolean} [deps.skipInstall]
 * @param {boolean} [deps.skipV5]
 * @returns {Promise<{ ok: boolean, results: object[] }>}
 */
export async function runVerification(deps) {
  const { npm, coreVersion, cliVersion, skipInstall = false, skipV5 = false } = deps;
  const results = [];
  const push = (id, status, detail) => results.push({ id, status, detail });

  // V1 — both packages carry the expected version and it is the latest tag.
  push('V1', ...checkVersionsAndTags(npm, coreVersion, cliVersion));

  // V2 — repository metadata points at AragonAgent, resolves, AND the content there is renamed.
  const v2 = await checkRepository(deps);
  push('V2', v2.status, v2.detail);

  // V3 — the README the registry serves is the aragon one.
  push('V3', ...checkReadmes(npm));

  // V4 — a real install from the registry.
  if (skipInstall) {
    push('V4', 'SKIPPED', '--skip-install was passed; no install smoke was performed.');
  } else {
    const smoke = deps.installSmoke({ coreVersion, cliVersion });
    push('V4', smoke.ok ? 'PASS' : 'FAIL', smoke.detail);
  }

  // V5 — the legacy packages are deprecated.
  if (skipV5) {
    // runbook step 7 runs this BEFORE deprecating, where V5 cannot hold yet.
    // Without the switch that run exits non-zero and teaches the operator either
    // "the release failed" or, worse, "red is fine" — and the second habit would
    // swallow a genuine failure in step 9.
    push('V5', 'SKIPPED', '--skip-v5 was passed; legacy deprecation was not checked.');
  } else {
    push('V5', ...checkLegacyDeprecated(npm));
  }

  return { ok: results.every((result) => result.status !== 'FAIL'), results };
}

function checkVersionsAndTags(npm, coreVersion, cliVersion) {
  const problems = [];
  const notes = [];
  for (const [name, version] of [
    [NEW_CORE, coreVersion],
    [NEW_CLI, cliVersion],
  ]) {
    const view = npm(['view', `${name}@${version}`, 'version', '--json', '--registry', NPMJS]);
    if (view.status !== 0) {
      problems.push(`${name}@${version} is not queryable: ${briefly(view.stderr)}`);
      continue;
    }
    const reported = parseNpmJson(view.stdout);
    if (reported !== version) {
      problems.push(`${name} reported version ${JSON.stringify(reported)}, expected ${version}`);
    }

    const tags = npm(['view', name, 'dist-tags', '--json', '--registry', NPMJS]);
    const parsedTags = tags.status === 0 ? parseNpmJson(tags.stdout) : null;
    if (!parsedTags) {
      problems.push(`${name} dist-tags are not queryable: ${briefly(tags.stderr)}`);
      continue;
    }
    if (parsedTags.latest !== version) {
      problems.push(`${name} dist-tags.latest is ${parsedTags.latest}, expected ${version}`);
    } else {
      notes.push(`${name}@${version} (latest)`);
    }
  }
  return problems.length > 0 ? ['FAIL', problems.join(' ; ')] : ['PASS', notes.join(', ')];
}

/**
 * Three stages, because the first two pass on a repository that was merely
 * RENAMED while still holding pre-rename `argon` sources — a state that satisfies
 * every link check and still leaves a user who clicks "Repository" on the npm
 * page staring at `@argon-agent/*`. A green gate over an unmet requirement is
 * worse than no gate, since it gets cited as evidence.
 */
async function checkRepository({ npm, git, fetchText }) {
  const problems = [];
  let probeUrl = null;

  for (const name of [NEW_CORE, NEW_CLI]) {
    const view = npm(['view', name, 'repository', 'homepage', '--json', '--registry', NPMJS]);
    if (view.status !== 0) {
      problems.push(`${name} metadata is not queryable: ${briefly(view.stderr)}`);
      continue;
    }
    const metadata = parseNpmJson(view.stdout);
    if (metadata === null || typeof metadata !== 'object') {
      // npm collapses a multi-field --json query to a bare value when only one of
      // the fields exists, so a non-object here means one of them is missing —
      // which V2a has to fail on anyway. Say that, rather than reporting a
      // confusing "undefined does not point at AragonAgent".
      problems.push(`${name} is missing repository or homepage metadata: ${collapse(view.stdout)}`);
      continue;
    }
    const repositoryUrl = metadata.repository?.url ?? metadata.repository;
    const homepage = metadata.homepage;

    // V2a — metadata points at the right place (case-sensitive on purpose).
    for (const [field, value] of [
      ['repository.url', repositoryUrl],
      ['homepage', homepage],
    ]) {
      if (typeof value !== 'string' || !value.includes('AragonAgent')) {
        problems.push(`${name} ${field} does not point at AragonAgent: ${JSON.stringify(value)}`);
      }
    }

    if (typeof repositoryUrl === 'string' && probeUrl === null) {
      probeUrl = repositoryUrl.replace(/^git\+/, '');
    }
  }

  if (probeUrl === null) {
    return { status: 'FAIL', detail: problems.join(' ; ') || 'No repository URL to probe.' };
  }

  // V2b — the remote actually resolves.
  const lsRemote = git(['ls-remote', probeUrl, 'HEAD'], {
    timeout: GIT_LS_REMOTE_TIMEOUT_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
  });
  if (lsRemote.status !== 0) {
    problems.push(`git ls-remote ${probeUrl} exited ${lsRemote.status}: ${briefly(lsRemote.stderr)}`);
  }

  // V2c — the content on the default branch is the renamed tree.
  const rawUrl = toRawContentUrl(probeUrl, REMOTE_PROBE_FILE);
  if (rawUrl === null) {
    problems.push(`Cannot derive a raw-content URL from ${probeUrl}`);
  } else {
    const fetched = await fetchText(rawUrl);
    if (!fetched.ok) {
      // FAIL, never SKIP: without the evidence we cannot claim the requirement holds.
      problems.push(
        `Could not read ${REMOTE_PROBE_FILE} from the published repository via ${REMOTE_PROBE_METHOD} ` +
          `(${rawUrl}): ${fetched.error ?? `HTTP ${fetched.status}`}`,
      );
    } else {
      let remoteName = null;
      try {
        remoteName = JSON.parse(fetched.text).name;
      } catch (error) {
        problems.push(`${rawUrl} is not valid JSON: ${error.message}`);
      }
      if (remoteName !== null && remoteName !== NEW_CORE) {
        problems.push(
          `The published repository still carries the pre-rename tree: ` +
            `${REMOTE_PROBE_FILE} declares name=${JSON.stringify(remoteName)}, expected ${NEW_CORE}. ` +
            'Renaming the GitHub repository is not enough — push the renamed sources (runbook step 2b).',
        );
      }
    }
  }

  return problems.length > 0
    ? { status: 'FAIL', detail: problems.join(' ; ') }
    : {
        status: 'PASS',
        detail: `${probeUrl} resolves and its ${REMOTE_PROBE_FILE} declares ${NEW_CORE} (via ${REMOTE_PROBE_METHOD}).`,
      };
}

/**
 * Reuses C1's `findLegacyBrandHits` on purpose: the README brand rule before
 * publishing (tarball) and after publishing (registry) has to be one rule, or
 * the two copies drift.
 */
function checkReadmes(npm) {
  const problems = [];
  for (const name of [NEW_CORE, NEW_CLI]) {
    const view = npm(['view', name, 'readme', '--registry', NPMJS]);
    if (view.status !== 0) {
      problems.push(`${name} readme is not queryable: ${briefly(view.stderr)}`);
      continue;
    }
    const readme = String(view.stdout ?? '');
    if (readme.trim().length === 0) {
      problems.push(`${name} serves an empty README`);
      continue;
    }
    const hits = findLegacyBrandHits(readme);
    if (hits.length > 0) {
      const sample = hits
        .slice(0, 5)
        .map((hit) => `${hit.line}:${hit.column} ${hit.token}`)
        .join(', ');
      problems.push(`${name} README has ${hits.length} legacy-brand hit(s): ${sample}`);
    }
  }
  return problems.length > 0
    ? ['FAIL', problems.join(' ; ')]
    : ['PASS', 'Both registry READMEs are non-empty and legacy-brand free.'];
}

function checkLegacyDeprecated(npm) {
  const problems = [];
  const notes = [];
  for (const legacy of [LEGACY_CORE, LEGACY_CLI]) {
    const specifier = `${legacy.name}@${legacy.version}`;
    const view = npm(['view', specifier, 'deprecated', '--registry', NPMJS]);
    // A non-deprecated package exits 0 with EMPTY stdout, so the two failure modes
    // are distinguishable and must be reported apart: "go run the deprecate script"
    // is the wrong instruction when the truth is that the query never landed.
    if (view.status !== 0) {
      problems.push(`${specifier} deprecation status is not queryable: ${briefly(view.stderr)}`);
      continue;
    }
    const message = String(view.stdout ?? '').trim();
    if (message.length === 0) {
      problems.push(`${specifier} is not deprecated (run .\\deprecate-legacy.ps1)`);
    } else {
      notes.push(`${specifier}: "${collapse(message)}"`);
    }
  }
  return problems.length > 0 ? ['FAIL', problems.join(' ; ')] : ['PASS', notes.join(' ; ')];
}

/**
 * The temp directory has to be a standalone install site. Running
 * `npm install <pkg> --prefix <tmp>` with the cwd left inside the subproject
 * makes npm read the root manifest's `workspaces` field, and the behaviour from
 * there is not predictable.
 */
export function buildLatestInstallArguments() {
  return [
    'install',
    `${NEW_CLI}@latest`,
    '--no-audit',
    '--no-fund',
    '--registry',
    NPMJS,
  ];
}

function defaultInstallSmoke({ coreVersion, cliVersion }) {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'aragon-verify-'));
  try {
    writeFileSync(
      join(tempDirectory, 'package.json'),
      `${JSON.stringify({ name: 'verify-smoke', private: true, version: '0.0.0' }, null, 2)}\n`,
      'utf8',
    );
    const runNpm = createNpmRunner(tempDirectory);
    const install = runNpm(buildLatestInstallArguments());
    if (install.status !== 0) {
      return { ok: false, detail: `npm install ${NEW_CLI}@latest failed: ${briefly(install.stderr)}` };
    }

    const cliEntry = join(tempDirectory, 'node_modules', '@aragon-agent', 'cli', 'dist', 'cli.js');
    const reported = spawnSync(process.execPath, [cliEntry, '--version'], {
      cwd: tempDirectory,
      encoding: 'utf8',
    });
    if (reported.status !== 0) {
      return { ok: false, detail: `node dist/cli.js --version failed: ${briefly(reported.stderr)}` };
    }
    const printedVersion = collapse(reported.stdout).split(' | ').pop() ?? '';
    if (printedVersion !== cliVersion) {
      return { ok: false, detail: `Installed CLI reports '${printedVersion}', expected '${cliVersion}'` };
    }

    const installedCorePath = join(tempDirectory, 'node_modules', '@aragon-agent', 'core', 'package.json');
    const installedCore = JSON.parse(readFileSync(installedCorePath, 'utf8'));
    if (!satisfiesCaret(installedCore.version, coreVersion)) {
      return {
        ok: false,
        detail: `Installed ${NEW_CORE}@${installedCore.version} does not satisfy ^${coreVersion}`,
      };
    }

    return {
      ok: true,
      detail: `Installed ${NEW_CLI}@${printedVersion} with ${NEW_CORE}@${installedCore.version} into a clean directory.`,
    };
  } catch (error) {
    return { ok: false, detail: `Install smoke threw: ${error.message}` };
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
  }
}

async function defaultFetchText(url) {
  try {
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) {
      return { ok: false, status: response.status };
    }
    return { ok: true, status: response.status, text: await response.text() };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function parseArguments(argv) {
  const options = { core: null, cli: null, skipInstall: false, skipV5: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') {
      options.json = true;
    } else if (argument === '--skip-install') {
      options.skipInstall = true;
    } else if (argument === '--skip-v5') {
      options.skipV5 = true;
    } else if (argument === '--core' || argument === '--cli') {
      options[argument.slice(2)] = argv[index + 1];
      index += 1;
    } else if (argument.startsWith('--core=') || argument.startsWith('--cli=')) {
      const [flag, value] = argument.split(/=(.*)/s);
      options[flag.slice(2)] = value;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  for (const flag of ['core', 'cli']) {
    if (!/^\d+\.\d+\.\d+$/.test(String(options[flag] ?? ''))) {
      throw new Error(`--${flag} <x.y.z> is required; got '${options[flag]}'`);
    }
  }
  return options;
}

function printReport(report) {
  console.log('[verify-published] registry:', NPMJS);
  console.log('');
  for (const result of report.results) {
    console.log(`  ${result.status.padEnd(7)} ${result.id}  ${result.detail}`);
  }
  console.log('');
  console.log(
    report.ok
      ? '[verify-published] OK — every applicable check passed.'
      : '[verify-published] FAILED — see the FAIL rows above.',
  );
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(`[verify-published] ${error.message}`);
    console.error('Usage: node scripts/verify-published.mjs --core <x.y.z> --cli <x.y.z> [--skip-install] [--skip-v5] [--json]');
    process.exit(1);
  }

  const runNpm = createNpmRunner(repoRoot);
  const report = await runVerification({
    npm: (args) => runNpm(args),
    git: (args, spawnOptions) => spawnSync('git', args, { encoding: 'utf8', ...spawnOptions }),
    fetchText: defaultFetchText,
    installSmoke: defaultInstallSmoke,
    coreVersion: options.core,
    cliVersion: options.cli,
    skipInstall: options.skipInstall,
    skipV5: options.skipV5,
  });

  if (options.json) {
    console.log(JSON.stringify({ ...report, remoteProbeMethod: REMOTE_PROBE_METHOD }, null, 2));
  } else {
    printReport(report);
  }
  process.exit(report.ok ? 0 : 1);
}

const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  await main();
}
