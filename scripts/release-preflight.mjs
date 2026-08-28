#!/usr/bin/env node
/**
 * Release preflight (C2).
 *
 * One command that answers "would a real publish succeed right now?". Read-only,
 * changes nothing, safe to run repeatedly.
 *
 * It exists because `npm publish` is a one-way door and the release script's own
 * scope probe (`Assert-ScopePublishable`) is deliberately a WARNING — by the time
 * a missing organization surfaces there, the version files have already been
 * bumped and `$publishMayHaveStarted` is set, so the script's own advice ("run
 * -Resume") is misleading at exactly the moment it matters most. This runs
 * BEFORE any version file is touched.
 *
 * Exit 0 = clear to publish; exit 1 = at least one BLOCK.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import { NPMJS, createNpmRunner, parseNpmJson } from './assert-brand-clean.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

/**
 * Every npm call below MUST carry `--registry ${NPMJS}`.
 *
 * Without the pin, P2 would BLOCK a perfectly healthy scope (the mirror 404s
 * `access`), and P4's "the target version must be 404" would be vacuously true —
 * passing a version that is in fact already published. `publish-latest.ps1` has
 * followed this rule at every npm call since it was written; these tools do not
 * get an exemption. Defined once in `assert-brand-clean.mjs` and re-exported
 * here so the three scripts cannot drift apart.
 */
export { NPMJS };

// Second line of defence behind GIT_TERMINAL_PROMPT=0: a preflight that hangs is
// far worse than a preflight that fails, because only the second one tells you.
export const GIT_LS_REMOTE_TIMEOUT_MS = 20_000;

export const CORE_MANIFEST = 'packages/core/package.json';
export const CLI_MANIFEST = 'packages/cli/package.json';
export const LOCKFILE = 'package-lock.json';
export const CORE_CHANGELOG = 'packages/core/CHANGELOG.md';
export const CLI_CHANGELOG = 'packages/cli/CHANGELOG.md';

export const NEW_SCOPE = '@aragon-agent';
export const LEGACY_PACKAGES = ['@argon-agent/core', '@argon-agent/cli'];

export function computeNextVersion(version, bump) {
  const parsed = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version ?? ''));
  if (!parsed) {
    throw new Error(`Unsupported version '${version}': publish-latest.ps1 only handles plain x.y.z`);
  }
  let [major, minor, patch] = parsed.slice(1).map(Number);
  if (bump === 'patch') {
    patch += 1;
  } else if (bump === 'minor') {
    minor += 1;
    patch = 0;
  } else if (bump === 'major') {
    major += 1;
    minor = 0;
    patch = 0;
  } else {
    throw new Error(`Unsupported bump '${bump}'`);
  }
  return `${major}.${minor}.${patch}`;
}

export function hasChangelogHeading(text, version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^##\\s+${escaped}\\s*$`, 'm').test(text);
}

/**
 * P2's three-way verdict — the single easiest thing to get wrong in this file.
 *
 * A brand-new empty org has NO PACKAGES TO LIST, so this command is EXPECTED to
 * fail on the very first publish under a new scope (`publish-latest.ps1:358-362`
 * and CLAUDE.md both say so); a read-restricted CI token behaves the same. And
 * "org just created, nothing published yet" is precisely the state of runbook
 * step 3. Treating every non-zero exit as BLOCK would wall off the one path this
 * gate exists to serve.
 *
 * Judgement is not abandoned by the WARN branch: the unbypassable gate is
 * `npm publish` itself, which 404s when the scope is absent. This check's job is
 * to surface the single most common setup mistake 30 seconds earlier, not to
 * arbitrate on the registry's behalf.
 */
export function classifyScopeAccess(result) {
  if (result.status === 0) {
    return { status: 'PASS', detail: `${NEW_SCOPE} is visible to this account.` };
  }
  const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (/Scope not found/i.test(text)) {
    return {
      status: 'BLOCK',
      detail: `${NEW_SCOPE} does not exist on ${NPMJS}. npm publish would fail with 404.`,
      remedy:
        `Create the organization at https://www.npmjs.com/org/create — ` +
        `the org name is "aragon-agent" (no leading "@").`,
    };
  }
  return {
    status: 'WARN',
    detail:
      `Could not confirm ownership of ${NEW_SCOPE} (exit ${result.status}). ` +
      'Expected for a brand-new empty org or a read-restricted token; not a blocker. ' +
      `npm reported: ${briefly(text)}`,
  };
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

function isNotFound(result) {
  const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  return /E404|404\s+Not\s+Found|is not in this registry/i.test(text);
}

/**
 * @param {object} deps
 * @param {(args: string[]) => { status: number|null, stdout?: string, stderr?: string }} deps.npm
 * @param {(args: string[], options: object) => { status: number|null, stdout?: string, stderr?: string }} deps.git
 * @param {(relativePath: string) => string} deps.readText
 * @param {'patch'|'minor'|'major'} deps.bump
 * @returns {{ ok: boolean, checks: object[], versionPlan: object }}
 */
export function runPreflight({ npm, git, readText, bump = 'patch' }) {
  const checks = [];
  const push = (id, title, result) => checks.push({ id, title, ...result });

  // P1 — npm identity.
  const whoami = npm(['whoami', '--registry', NPMJS]);
  if (whoami.status === 0) {
    push('P1', 'npm identity', {
      status: 'PASS',
      detail: `Authenticated as ${collapse(whoami.stdout) || '(unknown)'}.`,
    });
  } else {
    push('P1', 'npm identity', {
      status: 'BLOCK',
      detail: `npm whoami failed (exit ${whoami.status}): ${briefly(whoami.stderr)}`,
      remedy: `npm login --scope "${NEW_SCOPE}" --registry "${NPMJS}" --auth-type web`,
    });
  }

  // P2 — scope publishable.
  push(
    'P2',
    'scope publishable',
    classifyScopeAccess(npm(['access', 'list', 'packages', NEW_SCOPE, '--registry', NPMJS])),
  );

  // P3 — repository links resolve.
  const coreManifest = JSON.parse(readText(CORE_MANIFEST));
  const cliManifest = JSON.parse(readText(CLI_MANIFEST));
  push('P3', 'repository links', checkRepositoryLinks(git, [coreManifest, cliManifest]));

  // P4 — version plan vs CHANGELOG.
  const versionPlan = {
    bump,
    core: { from: String(coreManifest.version), to: '', changelogHeadingPresent: false },
    cli: { from: String(cliManifest.version), to: '', changelogHeadingPresent: false },
  };
  push('P4', 'version plan', checkVersionPlan({ npm, readText, versionPlan }));

  // P5 — legacy packages, reported only.
  push('P5', 'legacy packages', describeLegacyPackages(npm));

  // P6 — subproject worktree clean.
  const status = git(['status', '--porcelain', '--untracked-files=all', '--', '.'], { cwd: repoRoot });
  const dirty = collapse(status.stdout);
  if (status.status !== 0) {
    push('P6', 'worktree clean', {
      status: 'BLOCK',
      detail: `git status failed (exit ${status.status}): ${briefly(status.stderr)}`,
      remedy: 'Run publish-latest.ps1 from a git checkout.',
    });
  } else if (dirty.length > 0) {
    push('P6', 'worktree clean', {
      status: 'BLOCK',
      detail: `aragon-agent-core has uncommitted changes: ${dirty}`,
      remedy: 'Commit or stash them; Assert-RepositoryState refuses to release otherwise.',
    });
  } else {
    push('P6', 'worktree clean', { status: 'PASS', detail: 'aragon-agent-core is clean.' });
  }

  return { ok: checks.every((check) => check.status !== 'BLOCK'), checks, versionPlan };
}

function checkRepositoryLinks(git, manifests) {
  const urls = [];
  for (const manifest of manifests) {
    const raw = manifest?.repository?.url;
    if (typeof raw !== 'string' || raw.length === 0) {
      return {
        status: 'BLOCK',
        detail: `${manifest?.name ?? '(unnamed package)'} has no repository.url.`,
        remedy: 'Restore repository.url in the package manifest.',
      };
    }
    const normalized = raw.replace(/^git\+/, '');
    if (!urls.includes(normalized)) {
      urls.push(normalized);
    }
  }

  const failures = [];
  for (const url of urls) {
    const probe = git(['ls-remote', url, 'HEAD'], {
      timeout: GIT_LS_REMOTE_TIMEOUT_MS,
      // Windows + Git Credential Manager will otherwise pop an interactive
      // credential dialog for a missing or private repository and block forever.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    });
    if (probe.status !== 0) {
      failures.push(`${url} -> exit ${probe.status} ${briefly(probe.stderr)}`);
    }
  }

  if (failures.length > 0) {
    return {
      status: 'BLOCK',
      detail: `Repository link is not resolvable: ${failures.join(' ; ')}`,
      remedy:
        'GitHub -> Settings -> Repository name: rename ArgonAgent to AragonAgent, then push the ' +
        'renamed subproject tree (runbook step 2b). A resolvable URL is not enough — the default ' +
        `branch's packages/core/package.json must already read "name": "@aragon-agent/core".`,
    };
  }
  return { status: 'PASS', detail: `Resolvable: ${urls.join(', ')}` };
}

function checkVersionPlan({ npm, readText, versionPlan }) {
  const problems = [];

  versionPlan.core.to = computeNextVersion(versionPlan.core.from, versionPlan.bump);
  versionPlan.cli.to = computeNextVersion(versionPlan.cli.from, versionPlan.bump);

  // The lockfile is the third version file: a manifest/lock disagreement makes
  // Assert-PackageState throw well after the bump has been written.
  const lock = JSON.parse(readText(LOCKFILE));
  const lockCore = lock?.packages?.['packages/core']?.version;
  const lockCli = lock?.packages?.['packages/cli']?.version;
  if (lockCore !== versionPlan.core.from || lockCli !== versionPlan.cli.from) {
    problems.push(
      `package-lock.json records core=${lockCore}, cli=${lockCli}; manifests say ` +
        `core=${versionPlan.core.from}, cli=${versionPlan.cli.from}`,
    );
  }

  const targets = [
    ['@aragon-agent/core', versionPlan.core.to],
    ['@aragon-agent/cli', versionPlan.cli.to],
  ];
  for (const [name, version] of targets) {
    const view = npm(['view', `${name}@${version}`, 'version', '--registry', NPMJS]);
    if (view.status === 0) {
      problems.push(`${name}@${version} is already published; npm refuses to overwrite it`);
    } else if (!isNotFound(view)) {
      problems.push(`${name}@${version} could not be queried: ${briefly(view.stderr)}`);
    }
  }

  versionPlan.core.changelogHeadingPresent = hasChangelogHeading(readText(CORE_CHANGELOG), versionPlan.core.to);
  versionPlan.cli.changelogHeadingPresent = hasChangelogHeading(readText(CLI_CHANGELOG), versionPlan.cli.to);
  if (!versionPlan.core.changelogHeadingPresent) {
    problems.push(`${CORE_CHANGELOG} has no "## ${versionPlan.core.to}" heading`);
  }
  if (!versionPlan.cli.changelogHeadingPresent) {
    problems.push(`${CLI_CHANGELOG} has no "## ${versionPlan.cli.to}" heading`);
  }

  const plan =
    `Core ${versionPlan.core.from} -> ${versionPlan.core.to}; ` +
    `CLI ${versionPlan.cli.from} -> ${versionPlan.cli.to} (bump=${versionPlan.bump})`;
  if (problems.length > 0) {
    return {
      status: 'BLOCK',
      detail: `${plan}. ${problems.join(' ; ')}`,
      remedy: 'Fix the version files / CHANGELOG headings, or pass a different --bump.',
    };
  }
  return { status: 'PASS', detail: plan };
}

function describeLegacyPackages(npm) {
  const lines = [];
  for (const name of LEGACY_PACKAGES) {
    const view = npm(['view', name, 'version', 'deprecated', '--json', '--registry', NPMJS]);
    if (view.status !== 0) {
      lines.push(`${name}: not queryable (${briefly(view.stderr)})`);
      continue;
    }
    // `npm view <pkg> version deprecated --json` collapses to a BARE VALUE when
    // only one of the requested fields exists — measured: a package with no
    // deprecation returns `"0.1.2"`, not `{"version":"0.1.2"}`. Reading `.version`
    // off that string yields undefined and reports "(unknown)" for the healthy
    // case, which is the one this check sees most often.
    const payload = parseNpmJson(view.stdout);
    const version = typeof payload === 'string' ? payload : payload?.version ?? '(unknown)';
    const deprecated = typeof payload === 'string' ? undefined : payload?.deprecated;
    lines.push(`${name}@${version}: ${deprecated ? `deprecated ("${deprecated}")` : 'NOT deprecated'}`);
  }
  return {
    status: 'INFO',
    detail: `${lines.join(' ; ')}. Run .\\deprecate-legacy.ps1 after the new packages are published.`,
  };
}

function parseArguments(argv) {
  const options = { bump: 'patch', json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') {
      options.json = true;
    } else if (argument === '--bump') {
      options.bump = argv[index + 1];
      index += 1;
    } else if (argument.startsWith('--bump=')) {
      options.bump = argument.slice('--bump='.length);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!['patch', 'minor', 'major'].includes(options.bump)) {
    throw new Error(`--bump must be patch, minor or major; got '${options.bump}'`);
  }
  return options;
}

const STATUS_LABEL = { PASS: 'PASS ', BLOCK: 'BLOCK', WARN: 'WARN ', INFO: 'INFO ' };

function printReport(report) {
  console.log('[release-preflight] registry:', NPMJS);
  console.log('');
  for (const check of report.checks) {
    console.log(`  ${STATUS_LABEL[check.status] ?? check.status}  ${check.id}  ${check.title}`);
    console.log(`         ${check.detail}`);
    if (check.remedy) {
      console.log(`         remedy: ${check.remedy}`);
    }
  }
  console.log('');
  console.log(
    report.ok
      ? '[release-preflight] OK — no blockers. Next: .\\publish-latest.ps1 -DryRun -Bump ' +
          `${report.versionPlan.bump}`
      : '[release-preflight] BLOCKED — resolve the BLOCK rows above and re-run.',
  );
}

function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(`[release-preflight] ${error.message}`);
    process.exit(1);
  }

  const runNpm = createNpmRunner(repoRoot);
  const report = runPreflight({
    npm: (args) => runNpm(args),
    git: (args, spawnOptions) => spawnSync('git', args, { encoding: 'utf8', ...spawnOptions }),
    readText: (relativePath) => readFileSync(join(repoRoot, relativePath), 'utf8'),
    bump: options.bump,
  });

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }
  process.exit(report.ok ? 0 : 1);
}

const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  main();
}
