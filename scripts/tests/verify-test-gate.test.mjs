/**
 * `verify-test-gate --classify` (release-gate-and-native-panels AC-6).
 *
 * The gate exists to answer ONE question after a failing test run: was every
 * failing file the vitest module-mirror ENOENT (environment) or is there a real
 * failure in there? Both directions are load-bearing, so both are pinned here:
 *
 *  - a gate that answers "real" on the known environment signature blocks every
 *    release that hits it, which is the state this feature was born in;
 *  - a gate that answers "environment" once while a real assertion failure is mixed
 *    in is worse, because the release script would then retry and, on a green
 *    second run for any unrelated reason, ship past a genuine regression (I-13).
 *
 * The fixtures are captured vitest logs under `scripts/tests/fixtures/`, and the
 * child process is the REAL script - a helper exported only for tests could diverge
 * from the command the release actually runs.
 */

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, '..', 'verify-test-gate.mjs');
const FIXTURES = resolve(HERE, 'fixtures');

function classify(logName) {
  const result = spawnSync(
    process.execPath,
    [SCRIPT, '--classify', resolve(FIXTURES, logName)],
    { encoding: 'utf8' },
  );
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

test('classify: every failing file is the mirror ENOENT -> environment, exit 0', () => {
  const result = classify('test-gate-environment.log');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /不是代码问题/);
  assert.match(result.stdout, /3/);
});

test('classify: one real assertion failure among the ENOENTs -> real, exit 1', () => {
  const result = classify('test-gate-real.log');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /real failure/);
  assert.match(result.stderr, /panel-rows\.test\.ts/);
});

test('classify: a log with no FAIL banner is never classified away', () => {
  const result = spawnSync(
    process.execPath,
    [SCRIPT, '--classify', resolve(FIXTURES, 'does-not-exist.log')],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr ?? '', /does not exist/);
});

test('classify: a missing log path argument fails instead of guessing', () => {
  const result = spawnSync(process.execPath, [SCRIPT, '--classify'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr ?? '', /needs a log file path/);
});

/**
 * THE INVERSION THIS PINS (found in review, not in the implementation). `npm run
 * verify:test-gate --classify <log>` does not forward `--classify`: npm consumes it as a
 * config key, so the script sees only the path. Before the argument guard it then ran the
 * version+environment gates, exited 0, and `publish-latest.ps1` read that 0 as "the
 * failure was the environment" - so EVERY real failure would have been retried once and
 * never reported as `real` (I-13). The release now passes `--` before the flag; this test
 * makes the broken call shape fail loudly, which is what closes the loop.
 */
test('classify: a swallowed flag never turns into an "environment" verdict', () => {
  const result = spawnSync(
    process.execPath,
    [SCRIPT, resolve(FIXTURES, 'test-gate-environment.log')],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 1, 'the gates ran instead of failing the broken call');
  assert.match(result.stderr, /unexpected argument/);
  assert.match(result.stderr, /--/);
});

/**
 * COLOR IS NOT THE MESSAGE (found in a real 2026-10-20 release, not in review).
 *
 * The release captured `npm test -w packages/cli` through PowerShell, which keeps the
 * ANSI palette vitest emits, and the captured log was therefore stored colorized. Every
 * `FAIL` banner then begins with an escape sequence rather than with whitespace, so the
 * `^\s*FAIL` anchor matched nothing, `--classify` answered "no FAIL line ... the log was
 * not a captured vitest failure", and the one failing file was never named - which is the
 * useless half of the gate the feature exists to avoid. Both directions are pinned here
 * because a colorized log must not change the verdict, only lose to it.
 */
test('classify: a colorized real failure is still attributed and named', () => {
  const result = classify('test-gate-colorized.log');
  assert.equal(result.status, 1, 'a colorized banner hid a genuine failure');
  assert.match(result.stderr, /real failure/);
  assert.match(result.stderr, /model-profile-runtime\.test\.ts/);
});

test('classify: a colorized mirror ENOENT is still the environment', () => {
  const result = classify('test-gate-environment-colorized.log');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /不是代码问题/);
  assert.match(result.stdout, /2/);
});
