/**
 * Regression protection for the preflight (C2) and the post-publish verification
 * (C4). Everything is driven through injected fake npm/git/fetch executors, so
 * nothing here touches the network, the registry or the working tree.
 *
 * These six cases exist because each of them guards a decision that a later
 * refactor would otherwise quietly reverse. R2 and R5 are the load-bearing pair:
 * they pin the two OPPOSITE failure directions — a gate that turns red on a
 * healthy repository (and walls off the only path it exists to serve), and a gate
 * that turns green on a state that does not meet the requirement. The second is
 * the more dangerous one, because a green gate gets cited as evidence.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { NPMJS } from '../assert-brand-clean.mjs';
import { classifyScopeAccess, computeNextVersion, runPreflight } from '../release-preflight.mjs';
import { runVerification, satisfiesCaret, toRawContentUrl } from '../verify-published.mjs';
import * as verifyPublished from '../verify-published.mjs';

const REPOSITORY_URL = 'https://github.com/xdrshjr/AragonAgent.git';

const FILES = {
  'packages/core/package.json': JSON.stringify({
    name: '@aragon-agent/core',
    version: '0.1.2',
    repository: { type: 'git', url: `git+${REPOSITORY_URL}` },
    homepage: 'https://github.com/xdrshjr/AragonAgent#readme',
  }),
  'packages/cli/package.json': JSON.stringify({
    name: '@aragon-agent/cli',
    version: '0.4.2',
    repository: { type: 'git', url: `git+${REPOSITORY_URL}` },
    homepage: 'https://github.com/xdrshjr/AragonAgent#readme',
  }),
  'package-lock.json': JSON.stringify({
    packages: {
      'packages/core': { version: '0.1.2' },
      'packages/cli': { version: '0.4.2' },
    },
  }),
  'packages/core/CHANGELOG.md': '# Changelog\n\n## 0.2.0\n\n### Breaking\n',
  'packages/cli/CHANGELOG.md': '# Changelog\n\n## 0.5.0\n\n### Breaking\n',
};

const NOT_FOUND = { status: 1, stdout: '', stderr: 'npm error code E404\nnpm error 404 Not Found' };

/** Records every call so the tests can assert on arguments and options. */
function createRecorder(handler) {
  const calls = [];
  const invoke = (args, options) => {
    calls.push({ args, options });
    return handler(args, options) ?? { status: 0, stdout: '', stderr: '' };
  };
  invoke.calls = calls;
  return invoke;
}

function createPreflightDeps({ accessResult = { status: 0, stdout: '{}', stderr: '' } } = {}) {
  const npm = createRecorder((args) => {
    switch (args[0]) {
      case 'whoami':
        return { status: 0, stdout: 'xdrshjr\n', stderr: '' };
      case 'access':
        return accessResult;
      case 'view':
        // The bump targets must not exist yet; the legacy packages do.
        return args[1].startsWith('@aragon-agent/')
          ? NOT_FOUND
          : { status: 0, stdout: JSON.stringify({ version: '0.1.2' }), stderr: '' };
      default:
        throw new Error(`Unexpected npm call: ${args.join(' ')}`);
    }
  });
  const git = createRecorder(() => ({ status: 0, stdout: '', stderr: '' }));
  return {
    npm,
    git,
    readText: (relativePath) => {
      if (!(relativePath in FILES)) {
        throw new Error(`Unexpected read: ${relativePath}`);
      }
      return FILES[relativePath];
    },
    bump: 'minor',
  };
}

function findCheck(report, id) {
  return report.checks.find((check) => check.id === id);
}

test('R1: a genuinely missing scope BLOCKs', () => {
  const verdict = classifyScopeAccess({
    status: 1,
    stdout: '',
    stderr: 'npm error code E404\nnpm error 404 Scope not found - GET .../-/org/aragon-agent/package',
  });
  assert.equal(verdict.status, 'BLOCK');
  assert.match(verdict.remedy, /npmjs\.com\/org\/create/);

  const deps = createPreflightDeps({
    accessResult: { status: 1, stdout: '', stderr: 'npm error 404 Scope not found' },
  });
  const report = runPreflight(deps);
  assert.equal(findCheck(report, 'P2').status, 'BLOCK');
  assert.equal(report.ok, false);
});

test('R2: an empty-but-existing org WARNs and still lets the release proceed', () => {
  // The whole point of the gate is to serve the "org just created, nothing
  // published yet" state. A brand-new empty org has no packages to list, so
  // `npm access list` is EXPECTED to fail here; treating that as BLOCK would
  // wall off the only path this check exists for.
  const deps = createPreflightDeps({
    accessResult: { status: 1, stdout: '', stderr: 'npm error code E403\nnpm error Forbidden' },
  });
  const report = runPreflight(deps);
  assert.equal(findCheck(report, 'P2').status, 'WARN');
  assert.equal(report.ok, true, 'a WARN on P2 must not block the release');
  assert.deepEqual(report.versionPlan.core, { from: '0.1.2', to: '0.2.0', changelogHeadingPresent: true });
  assert.deepEqual(report.versionPlan.cli, { from: '0.4.2', to: '0.5.0', changelogHeadingPresent: true });
});

test('R3: every npm call in both tools pins --registry to npmjs.org', async () => {
  const assertPinned = (calls, label) => {
    assert.ok(calls.length > 0, `${label} made no npm calls`);
    for (const { args } of calls) {
      const index = args.indexOf('--registry');
      assert.notEqual(index, -1, `${label}: npm ${args.join(' ')} is missing --registry`);
      assert.equal(args[index + 1], NPMJS, `${label}: npm ${args.join(' ')} pins the wrong registry`);
    }
  };

  const preflightDeps = createPreflightDeps();
  runPreflight(preflightDeps);
  assertPinned(preflightDeps.npm.calls, 'release-preflight');

  const verifyDeps = createVerifyDeps();
  await runVerification(verifyDeps);
  assertPinned(verifyDeps.npm.calls, 'verify-published');
});

test('R4: git ls-remote runs non-interactively and under a timeout', () => {
  const deps = createPreflightDeps();
  runPreflight(deps);
  const lsRemote = deps.git.calls.filter(({ args }) => args[0] === 'ls-remote');
  assert.ok(lsRemote.length > 0, 'P3 never probed the repository');
  for (const { options } of lsRemote) {
    // Windows + Git Credential Manager pops an interactive dialog for a missing
    // or private repository and blocks forever; a hung preflight is worse than a
    // failed one, because only the failed one tells anybody.
    assert.equal(options.env.GIT_TERMINAL_PROMPT, '0');
    assert.equal(typeof options.timeout, 'number');
    assert.ok(options.timeout > 0);
  }
});

function createVerifyDeps({ remoteCoreName = '@aragon-agent/core', skipV5 = false } = {}) {
  const npm = createRecorder((args) => {
    const [command, specifier] = args;
    if (command !== 'view') {
      throw new Error(`Unexpected npm call: ${args.join(' ')}`);
    }
    if (args.includes('dist-tags')) {
      const latest = specifier === '@aragon-agent/core' ? '0.2.0' : '0.5.0';
      return { status: 0, stdout: JSON.stringify({ latest }), stderr: '' };
    }
    if (args.includes('repository')) {
      return {
        status: 0,
        stdout: JSON.stringify({
          repository: { type: 'git', url: `git+${REPOSITORY_URL}` },
          homepage: 'https://github.com/xdrshjr/AragonAgent#readme',
        }),
        stderr: '',
      };
    }
    if (args.includes('readme')) {
      return { status: 0, stdout: '# AragonAgent\n\nnpm i -g @aragon-agent/cli\n', stderr: '' };
    }
    if (args.includes('deprecated')) {
      return { status: 0, stdout: 'Renamed to @aragon-agent/core ...\n', stderr: '' };
    }
    return { status: 0, stdout: JSON.stringify(specifier.split('@').pop()), stderr: '' };
  });
  const git = createRecorder(() => ({ status: 0, stdout: 'deadbeef\tHEAD', stderr: '' }));
  return {
    npm,
    git,
    fetchText: async () => ({ ok: true, status: 200, text: JSON.stringify({ name: remoteCoreName }) }),
    installSmoke: () => ({ ok: true, detail: 'stub' }),
    coreVersion: '0.2.0',
    cliVersion: '0.5.0',
    skipInstall: true,
    skipV5,
  };
}

function findResult(report, id) {
  return report.results.find((result) => result.id === id);
}

test('R5: V2 FAILs when the repository was renamed but its content was not', async () => {
  // Control: a fully synchronised repository passes, so the failure below is not vacuous.
  const healthy = await runVerification(createVerifyDeps());
  assert.equal(findResult(healthy, 'V2').status, 'PASS');
  assert.equal(healthy.ok, true);

  // The dangerous state: the URL resolves and the metadata reads AragonAgent, but
  // the default branch still holds the pre-rename sources. V2a and V2b both pass
  // on it, which is exactly why V2c exists.
  const stale = await runVerification(createVerifyDeps({ remoteCoreName: '@argon-agent/core' }));
  const v2 = findResult(stale, 'V2');
  assert.equal(v2.status, 'FAIL');
  assert.match(v2.detail, /pre-rename tree/);
  assert.equal(stale.ok, false);
});

test('R5b: V2 FAILs (never SKIPs) when the remote content cannot be read', async () => {
  const deps = createVerifyDeps();
  deps.fetchText = async () => ({ ok: false, status: 404 });
  const report = await runVerification(deps);
  assert.equal(findResult(report, 'V2').status, 'FAIL');
  assert.equal(report.ok, false);
});

test('R6: --skip-v5 records SKIPPED and keeps the overall verdict green', async () => {
  // runbook step 7 verifies the publish BEFORE deprecating, where V5 cannot hold
  // yet. Without this the operator either misreads a successful release as failed
  // or learns that red output is normal — and that habit would swallow a real
  // failure at step 9.
  const report = await runVerification(createVerifyDeps({ skipV5: true }));
  const v5 = findResult(report, 'V5');
  assert.equal(v5.status, 'SKIPPED');
  assert.equal(report.ok, true);
  // A skip must not be dressed up as a pass.
  assert.notEqual(v5.status, 'PASS');
});

test('version arithmetic and caret satisfaction', () => {
  assert.equal(computeNextVersion('0.1.2', 'patch'), '0.1.3');
  assert.equal(computeNextVersion('0.1.2', 'minor'), '0.2.0');
  assert.equal(computeNextVersion('0.1.2', 'major'), '1.0.0');
  assert.throws(() => computeNextVersion('0.1.2-beta.1', 'patch'), /Unsupported version/);

  assert.equal(satisfiesCaret('0.2.0', '0.2.0'), true);
  assert.equal(satisfiesCaret('0.2.5', '0.2.0'), true);
  // A caret on a 0.x base pins the minor too.
  assert.equal(satisfiesCaret('0.3.0', '0.2.0'), false);
  assert.equal(satisfiesCaret('0.1.9', '0.2.0'), false);
});

test('raw-content URL derivation', () => {
  assert.equal(
    toRawContentUrl(`git+${REPOSITORY_URL}`, 'packages/core/package.json'),
    'https://raw.githubusercontent.com/xdrshjr/AragonAgent/HEAD/packages/core/package.json',
  );
  assert.equal(toRawContentUrl('https://example.com/not-github', 'x'), null);
});

test('R7: the install smoke resolves the CLI through the latest tag', () => {
  const buildLatestInstallArguments = verifyPublished.buildLatestInstallArguments;
  assert.equal(typeof buildLatestInstallArguments, 'function');

  assert.deepEqual(buildLatestInstallArguments(), [
    'install',
    '@aragon-agent/cli@latest',
    '--no-audit',
    '--no-fund',
    '--registry',
    NPMJS,
  ]);
});
