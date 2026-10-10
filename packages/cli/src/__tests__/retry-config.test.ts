/**
 * Retry config resolution (llm-api-retry-backoff §11, AC-17...AC-20 + AC-33).
 *
 * The clamp cases carry most of the weight here: `maxRetries: 0` is the value four
 * documented controls send, and through the wrong coercion helper it silently
 * becomes 10 — the MAXIMUM instead of the kill switch, with no error anywhere. Every
 * one of them is asserted in BOTH directions, because a test that only checks that
 * `0` survives lets the next reader "fix" it by dropping the guard and accepting
 * `-1` as `-1`.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

// Point the user-state root at a throwaway temp directory BEFORE importing the
// config modules — `app-paths.ts` resolves it once, at module load.
const TMP = mkdtempSync(join(tmpdir(), 'aragon-cli-retry-'));
process.env.ARAGON_HOME = TMP;

const { loadConfig } = await import('../config/load.js');
const { updatePersistedConfig, loadPersistedConfig, getConfigPath } = await import(
  '../config/store.js'
);
const {
  clampRetryConfig,
  toRetryPolicy,
  DEFAULT_RETRY_CONFIG,
  DEFAULT_TEAM_CONFIG,
  HARD_MAX_RETRIES,
} = await import('../config/schema.js');
const { applyRetryConfigSet, RETRY_CONFIG_SET_KEYS } = await import('../config/cli-commands.js');
const { DEFAULT_RETRY_POLICY } = await import('@aragon-agent/core');

function clearEnv(): void {
  for (const key of Object.keys(process.env)) {
    // ARAGON_HOME IS EXEMPT AND MUST STAY EXEMPT — it is this file's only
    // isolation mechanism, and deleting it would point every resolution at the
    // developer's real home directory.
    if (key === 'ARAGON_HOME') continue;
    if (key.startsWith('ARAGON_') || key.endsWith('_API_KEY')) delete process.env[key];
  }
}

beforeEach(() => {
  clearEnv();
  rmSync(getConfigPath(), { force: true });
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AC-17 / AC-17b — the clamp
// ---------------------------------------------------------------------------

describe('clampRetryConfig (AC-17)', () => {
  it('returns the defaults for an empty object', () => {
    expect(clampRetryConfig({})).toEqual(DEFAULT_RETRY_CONFIG);
    expect(clampRetryConfig(undefined)).toEqual(DEFAULT_RETRY_CONFIG);
    expect(clampRetryConfig('nonsense')).toEqual(DEFAULT_RETRY_CONFIG);
  });

  it('clamps maxRetries to the hard ceiling', () => {
    expect(clampRetryConfig({ maxRetries: 999 }).maxRetries).toBe(HARD_MAX_RETRIES);
    expect(HARD_MAX_RETRIES).toBe(20);
  });

  it('raises maxDelayMs to initialDelayMs rather than leaving the ceiling under the floor', () => {
    // A ceiling below the floor makes the ladder a flat line and the countdown a
    // lie about a number it never waits.
    const cfg = clampRetryConfig({ maxDelayMs: 500, initialDelayMs: 5000 });
    expect(cfg.initialDelayMs).toBe(5000);
    expect(cfg.maxDelayMs).toBe(5000);
  });

  it('treats multiplier as a FLOAT, clamped rather than floored', () => {
    // `coercePositiveInt` would floor 2.5 to 2; `clampNumber` is why it does not.
    expect(clampRetryConfig({ multiplier: 2.5 }).multiplier).toBe(2.5);
    expect(clampRetryConfig({ multiplier: 0.1 }).multiplier).toBe(1);
    expect(clampRetryConfig({ multiplier: 99 }).multiplier).toBe(5);
  });

  it('clamps maxElapsedMs into its own range', () => {
    expect(clampRetryConfig({ maxElapsedMs: 1 }).maxElapsedMs).toBe(10_000);
    expect(clampRetryConfig({ maxElapsedMs: 99_999_999 }).maxElapsedMs).toBe(1_800_000);
  });

  it('keeps every boolean the user set', () => {
    const cfg = clampRetryConfig({
      enabled: false,
      jitter: false,
      respectRetryAfter: false,
      onPartialStream: false,
    });
    expect(cfg).toMatchObject({
      enabled: false,
      jitter: false,
      respectRetryAfter: false,
      onPartialStream: false,
    });
  });
});

describe('maxRetries: 0 survives, -1 does not (AC-17b)', () => {
  it('keeps an explicit 0 as 0, from a number AND from a string', () => {
    // Through `clampInt` -> `coercePositiveInt` both of these become 10, silently.
    expect(clampRetryConfig({ maxRetries: 0 }).maxRetries).toBe(0);
    expect(clampRetryConfig({ maxRetries: '0' }).maxRetries).toBe(0);
  });

  it('still falls back for a NEGATIVE value (the other direction)', () => {
    // Asserting only that `0` survives would let someone "fix" the coercion by
    // dropping the guard entirely and accepting -1 as -1.
    expect(clampRetryConfig({ maxRetries: -1 }).maxRetries).toBe(DEFAULT_RETRY_CONFIG.maxRetries);
    expect(clampRetryConfig({ maxRetries: 'abc' }).maxRetries).toBe(
      DEFAULT_RETRY_CONFIG.maxRetries,
    );
  });

  it('resolves ARAGON_RETRY_MAX=0 to 0 end to end', () => {
    // Its copy-paste source `ARAGON_TEAM_MAX` guards `parsed > 0`, which is right
    // for a fan-out width and would drop this on the floor.
    process.env.ARAGON_RETRY_MAX = '0';
    expect(loadConfig({ cwd: TMP }).retry.maxRetries).toBe(0);
  });

  it('resolves --retry-max 0 to 0 end to end', () => {
    expect(loadConfig({ cwd: TMP, retryMax: '0' }).retry.maxRetries).toBe(0);
    expect(loadConfig({ cwd: TMP, retryMax: 0 }).retry.maxRetries).toBe(0);
  });

  it('leaves ARAGON_RETRY_MAX ABSENT when unparseable so the config file can win', () => {
    writeFileSync(getConfigPath(), JSON.stringify({ retry: { maxRetries: 4 } }), 'utf-8');
    process.env.ARAGON_RETRY_MAX = 'lots';
    expect(loadConfig({ cwd: TMP }).retry.maxRetries).toBe(4);
  });

  it('toRetryPolicy returns null for a 0 count, and for enabled: false', () => {
    expect(toRetryPolicy({ ...DEFAULT_RETRY_CONFIG, maxRetries: 0 })).toBeNull();
    expect(toRetryPolicy({ ...DEFAULT_RETRY_CONFIG, enabled: false })).toBeNull();
    // ...and a real policy otherwise, carrying every field through unchanged.
    expect(toRetryPolicy(DEFAULT_RETRY_CONFIG)).toEqual(DEFAULT_RETRY_POLICY);
  });

  it('config set retry.maxRetries 0 writes 0, not 10', () => {
    const patch = applyRetryConfigSet('retry.maxRetries', '0');
    expect(patch).toEqual({ retry: { maxRetries: 0 } });
    expect(updatePersistedConfig(patch!).retry.maxRetries).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC-18 — layer precedence
// ---------------------------------------------------------------------------

describe('layer precedence (AC-18)', () => {
  it('flag beats env beats file', () => {
    writeFileSync(getConfigPath(), JSON.stringify({ retry: { maxRetries: 3 } }), 'utf-8');
    expect(loadConfig({ cwd: TMP }).retry.maxRetries).toBe(3);

    process.env.ARAGON_RETRY_MAX = '7';
    expect(loadConfig({ cwd: TMP }).retry.maxRetries).toBe(7);

    expect(loadConfig({ cwd: TMP, retryMax: '2' }).retry.maxRetries).toBe(2);
  });

  it('--no-retry beats ARAGON_RETRY=1', () => {
    process.env.ARAGON_RETRY = '1';
    expect(loadConfig({ cwd: TMP }).retry.enabled).toBe(true);
    // `!== undefined` on the flag is what makes this work: a truthiness check
    // cannot tell `--no-retry` (false) from "not passed".
    expect(loadConfig({ cwd: TMP, retry: false }).retry.enabled).toBe(false);
  });

  it('ARAGON_RETRY=0 turns it off, and uses the POSITIVE list', () => {
    process.env.ARAGON_RETRY = '0';
    expect(loadConfig({ cwd: TMP }).retry.enabled).toBe(false);
    // The positive list means anything that is not 1/true/on/yes is off — the
    // reader `ARAGON_TEAM` / `ARAGON_TODO` use, not `envBool`'s negative list.
    process.env.ARAGON_RETRY = 'disable';
    expect(loadConfig({ cwd: TMP }).retry.enabled).toBe(false);
    process.env.ARAGON_RETRY = 'yes';
    expect(loadConfig({ cwd: TMP }).retry.enabled).toBe(true);
  });

  it('a lone env `enabled` does not wipe the file section', () => {
    writeFileSync(
      getConfigPath(),
      JSON.stringify({ retry: { maxRetries: 6, respectRetryAfter: false } }),
      'utf-8',
    );
    process.env.ARAGON_RETRY = '1';
    const cfg = loadConfig({ cwd: TMP }).retry;
    expect(cfg).toMatchObject({ enabled: true, maxRetries: 6, respectRetryAfter: false });
  });
});

// ---------------------------------------------------------------------------
// AC-19 / AC-20 — the two store.ts merges
// ---------------------------------------------------------------------------

describe('the write-side merge (AC-19)', () => {
  it('a partial patch preserves every other key in the section', () => {
    updatePersistedConfig({
      retry: { ...DEFAULT_RETRY_CONFIG, respectRetryAfter: false, jitter: false },
    });
    // What `/retry max 5` sends.
    const merged = updatePersistedConfig({
      retry: { maxRetries: 5 } as ReturnType<typeof clampRetryConfig>,
    });
    expect(merged.retry.maxRetries).toBe(5);
    expect(merged.retry.respectRetryAfter).toBe(false);
    expect(merged.retry.jitter).toBe(false);
  });
});

describe('the read-side merge (AC-20)', () => {
  it('a config file with NO retry key loads a complete section', () => {
    writeFileSync(getConfigPath(), JSON.stringify({ model: 'x' }), 'utf-8');
    expect(loadPersistedConfig().retry).toEqual(DEFAULT_RETRY_CONFIG);
    // And `toRetryPolicy` therefore never sees `undefined`.
    expect(toRetryPolicy(loadPersistedConfig().retry)).toEqual(DEFAULT_RETRY_POLICY);
  });

  it('a config file with a PARTIAL retry key fills in the rest', () => {
    writeFileSync(getConfigPath(), JSON.stringify({ retry: { jitter: false } }), 'utf-8');
    expect(loadPersistedConfig().retry).toEqual({ ...DEFAULT_RETRY_CONFIG, jitter: false });
  });
});

describe('config set retry.* coverage', () => {
  it('every declared key produces a patch (a listed-but-unhandled key writes nothing)', () => {
    for (const key of RETRY_CONFIG_SET_KEYS) {
      expect(applyRetryConfigSet(key, '1'), key).not.toBeNull();
    }
    expect(applyRetryConfigSet('retry.nope', '1')).toBeNull();
    expect(applyRetryConfigSet('team.enabled', 'true')).toBeNull();
  });

  it('echoes a CLAMPED value rather than the input', () => {
    expect(updatePersistedConfig(applyRetryConfigSet('retry.maxRetries', '999')!).retry.maxRetries)
      .toBe(HARD_MAX_RETRIES);
    expect(updatePersistedConfig(applyRetryConfigSet('retry.multiplier', '2.5')!).retry.multiplier)
      .toBe(2.5);
  });
});

// ---------------------------------------------------------------------------
// AC-33 — the static inequality against team mode
// ---------------------------------------------------------------------------

describe('the retry budget clears the per-child timeout (AC-33)', () => {
  it('the parity default leaves the retry ladder alone', () => {
    /**
     * A STATIC ASSERTION, and it lives here because this is the only suite where
     * both constants are visible (llm-api-retry-backoff §5.6 / R-15).
     *
     * ITS ENTIRE JOB IS TO MAKE THE NEXT PERSON WHO EDITS EITHER NUMBER READ THE
     * REASON. If a child wall clock EQUALS the retry budget, the child is killed
     * by its own timeout at or before the instant its retry budget expires — so
     * the user is told "subagent timed out" for what was a provider outage, and
     * the whole retry story was invisible on the way there. They were both
     * 300 000 in the v1 design.
     *
     * MAIN-AGENT PARITY removed the race BY REMOVING THE TIMER: the default
     * `subagentTimeoutMs: 0` arms no clock at all, so a retrying child can
     * always run its ladder to the end, exactly like the lead.
     */
    expect(DEFAULT_TEAM_CONFIG.subagentTimeoutMs).toBe(0);
  });

  it('no ceiling the clamp can produce reintroduces the race', () => {
    // The largest wall clock the config can hand a child is 30 minutes; the
    // retry budget plus one model round trip still fits inside it, so no
    // reachable POSITIVE setting collides with the ladder either.
    const maxSubagentTimeoutMs = 1_800_000;
    expect(DEFAULT_RETRY_POLICY.maxElapsedMs).toBeLessThan(maxSubagentTimeoutMs);
    expect(maxSubagentTimeoutMs - DEFAULT_RETRY_POLICY.maxElapsedMs)
      .toBeGreaterThanOrEqual(30_000);
  });

  it('the full ten-step ladder fits inside the budget', () => {
    // 181 s worst case. If the budget were what stopped the tenth retry, the
    // headline "at least 10 retries" would be a lie.
    let total = 0;
    let delay = DEFAULT_RETRY_POLICY.initialDelayMs;
    for (let i = 0; i < DEFAULT_RETRY_POLICY.maxRetries; i += 1) {
      total += Math.min(delay, DEFAULT_RETRY_POLICY.maxDelayMs);
      delay *= DEFAULT_RETRY_POLICY.multiplier;
    }
    expect(total).toBe(181_000);
    expect(total).toBeLessThan(DEFAULT_RETRY_POLICY.maxElapsedMs);
  });
});

describe('the resolved config is recorded', () => {
  it('carries retry into CliConfig for every session', () => {
    const cfg = loadConfig({ cwd: TMP });
    expect(cfg.retry).toEqual(DEFAULT_RETRY_CONFIG);
  });
});
