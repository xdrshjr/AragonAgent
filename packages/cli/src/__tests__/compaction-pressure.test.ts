/**
 * Occupancy, the trigger and the config clamp (context-auto-compaction §8.1,
 * CLI half — pressure).
 *
 * Two of these guard invariants that FAIL QUIETLY. The additive-cache-field
 * source scan (P1-10) fails at the moment somebody maps OpenAI's INCLUSIVE
 * `prompt_tokens_details.cached_tokens` onto the same field, which would
 * double-count and fire compaction early on every OpenAI session with the gauge
 * agreeing with it. The `estimateOffset` assertions (P1-11) guard a number that
 * is biased low in exactly the direction that hurts.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimatePromptTokens, type Message, type TokenUsage } from '@aragon-agent/core';
import {
  computeEstimateOffset,
  computePressure,
  estimateAppendedTokens,
  isApproximate,
  occupiedTokens,
  requiredHeadroom,
  shouldCompactAt,
} from '../compaction/pressure.js';
import {
  DEFAULT_COMPACTION_CONFIG,
  clampCompactionConfig,
  parseThresholdInput,
} from '../config/schema.js';

const here = dirname(fileURLToPath(import.meta.url));
const CORE_PROVIDERS = join(here, '..', '..', '..', 'core', 'src', 'llm', 'providers');

function user(text: string): Message {
  return { role: 'user', content: text, timestamp: 0 };
}

describe('occupiedTokens (§3.4.1 / R-6)', () => {
  it('includes both cache fields', () => {
    const usage: TokenUsage = {
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 5000,
      cacheWriteTokens: 300,
    };
    expect(occupiedTokens(usage)).toBe(6500);
  });

  it('is unchanged for a usage with only input/output', () => {
    // The regression guard: this is the shape a direct Anthropic connection
    // reports, and the number must be byte-identical to the old
    // `inputTokens + outputTokens`.
    expect(occupiedTokens({ inputTokens: 1000, outputTokens: 200 })).toBe(1200);
  });
});

describe('C-14 / P1-10 — the additive-only cache-field invariant', () => {
  it('cacheReadTokens / cacheWriteTokens are written in anthropic.ts and NOWHERE else', () => {
    // `occupiedTokens` SUMS these onto `inputTokens`, which is only correct while
    // they are ADDITIVE. Anthropic's `input_tokens` genuinely excludes cached
    // tokens; OpenAI's `prompt_tokens` ALREADY INCLUDES them. So the day somebody
    // maps `prompt_tokens_details.cached_tokens` onto the existing field — a
    // change that reads as a pure improvement and would sail through review —
    // this sum becomes a double-count and compaction fires early on every OpenAI
    // session, with the gauge agreeing with it and nothing reporting a fault.
    //
    // The remedy for an inclusive-total provider is a DIFFERENTLY NAMED field,
    // never a reinterpretation of these two.
    const anthropic = readFileSync(join(CORE_PROVIDERS, 'anthropic.ts'), 'utf8');
    const openai = readFileSync(join(CORE_PROVIDERS, 'openai.ts'), 'utf8');
    const google = readFileSync(join(CORE_PROVIDERS, 'google.ts'), 'utf8');

    expect(anthropic).toMatch(/cacheReadTokens/);
    expect(anthropic).toMatch(/cacheWriteTokens/);

    const remedy =
      'occupiedTokens() sums cacheReadTokens/cacheWriteTokens onto inputTokens, which is only ' +
      'valid while those fields are ADDITIVE. This adapter now writes one of them - if its ' +
      'inputTokens already INCLUDES cached tokens, compaction will fire early on every session ' +
      'of this provider. Add a differently named field instead. See context-auto-compaction C-14.';
    expect(openai, remedy).not.toMatch(/cacheReadTokens|cacheWriteTokens/);
    expect(google, remedy).not.toMatch(/cacheReadTokens|cacheWriteTokens/);
  });
});

describe('computePressure (§3.4.2)', () => {
  const systemPrompt = 'you are a helpful agent';
  const messages = [user('a'.repeat(4000)), user('b'.repeat(4000))];

  it('uses the reported usage when there is one', () => {
    const p = computePressure({
      lastUsage: { inputTokens: 90_000, outputTokens: 0 },
      messages,
      systemPrompt,
      contextWindow: 100_000,
      windowKnown: true,
    });
    expect(p.source).toBe('usage');
    expect(p.occupied).toBe(90_000);
    expect(p.ratio).toBeCloseTo(0.9);
    expect(p.headroom).toBe(10_000);
  });

  it('falls back to the estimator and marks the source', () => {
    const p = computePressure({
      messages,
      systemPrompt,
      contextWindow: 100_000,
      windowKnown: true,
    });
    expect(p.source).toBe('estimate');
    expect(p.occupied).toBe(estimatePromptTokens(messages, systemPrompt));
  });

  it('clamps the ratio into [0, 1] and floors the headroom at 0', () => {
    const p = computePressure({
      lastUsage: { inputTokens: 500_000, outputTokens: 0 },
      messages,
      systemPrompt,
      contextWindow: 100_000,
      windowKnown: true,
    });
    expect(p.ratio).toBe(1);
    expect(p.headroom).toBe(0);
  });
});

describe('P1-11 / D-23 — the calibration offset', () => {
  const systemPrompt = 'sys';
  const messages = [user('hello world')];

  it('is measured - estimated, clamped at zero', () => {
    const raw = estimatePromptTokens(messages, systemPrompt);
    // A tool-definition-heavy request: the provider counts the schemas, the
    // estimator provably does not, so the measurement is higher.
    const usage: TokenUsage = { inputTokens: raw + 4000, outputTokens: 0 };
    expect(computeEstimateOffset(usage, messages, systemPrompt)).toBe(4000);
  });

  it('never goes negative', () => {
    // A verbose model on a tool-free session can over-count. Applying a NEGATIVE
    // offset would push the one number that is already biased low even further in
    // the wrong direction.
    const usage: TokenUsage = { inputTokens: 1, outputTokens: 0 };
    expect(computeEstimateOffset(usage, messages, systemPrompt)).toBe(0);
  });

  it('is applied to the estimated occupancy, and only to it', () => {
    const raw = estimatePromptTokens(messages, systemPrompt);
    const estimated = computePressure({
      messages,
      systemPrompt,
      contextWindow: 100_000,
      windowKnown: true,
      estimateOffset: 4000,
    });
    expect(estimated.occupied).toBe(raw + 4000);

    // A MEASURED figure is already in the right unit and must not be calibrated
    // a second time.
    const measured = computePressure({
      lastUsage: { inputTokens: 50_000, outputTokens: 0 },
      messages,
      systemPrompt,
      contextWindow: 100_000,
      windowKnown: true,
      estimateOffset: 4000,
    });
    expect(measured.occupied).toBe(50_000);
  });
});

describe('the trigger has TWO terms (§3.4.3 / D-12)', () => {
  const base = { messages: [], systemPrompt: '' };

  function pressureAt(occupied: number, window: number) {
    return computePressure({
      ...base,
      lastUsage: { inputTokens: occupied, outputTokens: 0 },
      contextWindow: window,
      windowKnown: true,
    });
  }

  it('fires on the ratio alone at a large window', () => {
    expect(shouldCompactAt(pressureAt(180_000, 200_000), 0.9, { maxOutputTokens: 8192 })).toBe(true);
    expect(shouldCompactAt(pressureAt(170_000, 200_000), 0.9, { maxOutputTokens: 8192 })).toBe(false);
  });

  it('fires on HEADROOM at a small window, below the ratio threshold', () => {
    // 90 % of a 32 k window leaves 3.2 k, which is less than a single
    // `max_tokens` of 8192 — the request is already impossible. A pure-ratio
    // trigger is correct for 200 k windows and quietly wrong for this one.
    const small = pressureAt(Math.round(32_000 * 0.88), 32_000);
    expect(small.ratio).toBeLessThan(0.9);
    expect(shouldCompactAt(small, 0.9, { maxOutputTokens: 8192 })).toBe(true);

    // The SAME ratio on a 200 k window does not fire, which is what proves the
    // second term is doing the work rather than the first.
    const large = pressureAt(Math.round(200_000 * 0.88), 200_000);
    expect(large.ratio).toBeCloseTo(0.88);
    expect(shouldCompactAt(large, 0.9, { maxOutputTokens: 8192 })).toBe(false);
  });

  it('requiredHeadroom is the output cap plus both core margins', () => {
    // 8192 + THINKING_HEADROOM_TOKENS (4096) + CONTEXT_SAFETY_MARGIN_TOKENS (1024)
    expect(requiredHeadroom({ maxOutputTokens: 8192 })).toBe(13_312);
  });

  it('never fires when the window is unknown-as-zero', () => {
    expect(shouldCompactAt(pressureAt(1000, 0), 0.9, { maxOutputTokens: 8192 })).toBe(false);
  });
});

describe('clampCompactionConfig (§4.2 / P2-5)', () => {
  it('clamps threshold FIRST, then warnThreshold against the clamped value', () => {
    // The failing order produces a warn mark ABOVE the trigger, i.e. a gauge that
    // turns amber after it has already gone red.
    const c = clampCompactionConfig({ threshold: 0.6, warnThreshold: 0.9 });
    expect(c.threshold).toBe(0.6);
    expect(c.warnThreshold).toBe(0.55);
    expect(c.warnThreshold).toBeLessThan(c.threshold);
  });

  it('forces warnThreshold < threshold from both directions', () => {
    expect(clampCompactionConfig({ threshold: 0.95, warnThreshold: 0.99 }).warnThreshold).toBe(0.9);
    expect(clampCompactionConfig({ threshold: 0.5, warnThreshold: 0.1 }).warnThreshold).toBe(0.4);
  });

  it('stays consistent at the extremes', () => {
    const floored = clampCompactionConfig({ threshold: 0.1 });
    expect(floored.threshold).toBe(0.5);
    expect(floored.warnThreshold).toBeLessThanOrEqual(0.45);
    expect(floored.warnThreshold).toBeGreaterThanOrEqual(0.4);
  });

  it('keeps both thresholds at two decimals, not seventeen', () => {
    // `0.95 - 0.05` is `0.8999999999999999` in binary floating point, and both
    // numbers here come out of a subtraction or a division. A seventeen-digit
    // value in `config.json` for a setting the user typed as `90%` looks like
    // corruption and invites a hand-edit.
    const c = clampCompactionConfig({ threshold: 0.95, warnThreshold: 0.99 });
    expect(c.warnThreshold).toBe(0.9);
    expect(String(c.warnThreshold)).toBe('0.9');
    const fromPercent = clampCompactionConfig({ threshold: parseThresholdInput('87%') });
    expect(fromPercent.threshold).toBe(0.87);
  });

  it('clamps keepRecentTurns and defaults an unknown onFailure', () => {
    expect(clampCompactionConfig({ keepRecentTurns: 1 }).keepRecentTurns).toBe(1);
    expect(clampCompactionConfig({ keepRecentTurns: 999 }).keepRecentTurns).toBe(20);
    // `0` FALLS BACK TO THE DEFAULT rather than clamping to the floor, and that
    // is `clampInt`'s documented house behaviour for a positive-floor range (it
    // delegates to `coercePositiveInt`, which treats `<= 0` as absent). Zero is
    // not a meaningful value for this key — keeping zero recent turns verbatim
    // would discard the message the model is about to answer — so falling back is
    // the right reading, and `clampIntAllowingZero` is deliberately NOT used.
    expect(clampCompactionConfig({ keepRecentTurns: 0 }).keepRecentTurns).toBe(
      DEFAULT_COMPACTION_CONFIG.keepRecentTurns,
    );
    expect(clampCompactionConfig({ onFailure: 'garbage' }).onFailure).toBe('truncate');
    expect(clampCompactionConfig({ onFailure: 'stop' }).onFailure).toBe('stop');
  });

  it('defaults enabled to TRUE, unlike every other optional subsystem (D-16)', () => {
    expect(clampCompactionConfig({}).enabled).toBe(true);
    expect(DEFAULT_COMPACTION_CONFIG.enabled).toBe(true);
    // And an explicit false survives the clamp — the whole of R-12's mitigation.
    expect(clampCompactionConfig({ enabled: false }).enabled).toBe(false);
  });
});

describe('parseThresholdInput', () => {
  it('accepts a ratio, a percentage and a bare number over 1', () => {
    expect(parseThresholdInput('0.9')).toBe(0.9);
    expect(parseThresholdInput('90%')).toBe(0.9);
    expect(parseThresholdInput('90')).toBe(0.9);
    expect(parseThresholdInput(' 85 % ')).toBe(0.85);
  });

  it('returns null for anything that is not a ratio, rather than a default', () => {
    // A typo must CHANGE NOTHING. Silently resolving to 0.9 and reporting success
    // is a setting the user believes they changed and did not.
    expect(parseThresholdInput('banana')).toBeNull();
    expect(parseThresholdInput('')).toBeNull();
    expect(parseThresholdInput('0')).toBeNull();
    expect(parseThresholdInput('-1')).toBeNull();
    expect(parseThresholdInput('101')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// W1 — occupancy counts the whole history
// (context-auto-compaction-hardening §8.1, tests 8-12)
// ---------------------------------------------------------------------------

describe('estimateAppendedTokens (hardening §3.2.2 / W1)', () => {
  it('returns 0 for an undefined prefix, and for a prefix at or past the end', () => {
    const history = [user('a'), user('b'), user('c')];
    expect(estimateAppendedTokens(history, undefined)).toBe(0);
    // `+1` skips the assistant turn, so a prefix of 2 in a 3-message history
    // starts at index 3 - past the end.
    expect(estimateAppendedTokens(history, 2)).toBe(0);
    expect(estimateAppendedTokens(history, 99)).toBe(0);
  });

  it('estimates the slice after the assistant message the measurement already paid for', () => {
    const history = [user('a'), user('assistant-slot'), user('x'.repeat(4_000))];
    expect(estimateAppendedTokens(history, 1)).toBe(estimatePromptTokens([history[2]!]));
  });

  it('THE +1 SKIP: a history whose only appended message is the assistant turn is 0', () => {
    // `turn_end` fires BEFORE the push, so the message at index
    // `measuredPrefixLength` IS that turn - and its cost is already inside
    // `usage.outputTokens`. Counting it again double-charges every single turn.
    const history = [user('a'), user('b'), user('the assistant turn')];
    expect(estimateAppendedTokens(history, 2)).toBe(0);
  });

  it('degrades to 0 rather than throwing when the prefix outruns the array', () => {
    // A missed invalidation must cost ACCURACY, never correctness.
    expect(estimateAppendedTokens([user('a')], 40)).toBe(0);
    expect(estimateAppendedTokens([], 0)).toBe(0);
  });
});

describe('computePressure with a delta (hardening §3.2.2 / W1)', () => {
  const base: TokenUsage = { inputTokens: 100_000, outputTokens: 2_000 };

  it('adds the appended slice to the measured base, and NEVER the offset', () => {
    // AC-H5. `estimateOffset` is a PER-REQUEST constant (the tool schemas), and
    // it is already inside the measured base. Applying it per slice inflates
    // occupancy by several thousand tokens on every turn and fires compaction
    // early on short conversations.
    const history = [user('a'), user('assistant'), user('t'.repeat(40_000))];
    const appended = estimatePromptTokens([history[2]!]);

    const p = computePressure({
      lastUsage: base,
      messages: history,
      systemPrompt: '',
      contextWindow: 200_000,
      windowKnown: true,
      estimateOffset: 7_777,
      measuredPrefixLength: 1,
    });

    expect(p.deltaTokens).toBe(appended);
    expect(p.occupied).toBe(occupiedTokens(base) + appended);
    expect(p.source).toBe('usage');
  });

  it('AC-H2: with no recorded prefix the number is round 1s exactly', () => {
    const history = [user('a'), user('b'), user('c'.repeat(40_000))];
    const p = computePressure({
      lastUsage: base,
      messages: history,
      systemPrompt: '',
      contextWindow: 200_000,
      windowKnown: true,
    });

    expect(p.deltaTokens).toBe(0);
    expect(p.occupied).toBe(occupiedTokens(base));
  });

  it('AC-H3: 76 % measured plus a fat tool result crosses the 90 % threshold', () => {
    // THE §3.2.1 SEQUENCE, as arithmetic. The pre-fix trigger reads 76 % and
    // sends a request of ~101 %.
    const measured: TokenUsage = { inputTokens: 152_000, outputTokens: 0 };
    const history: Message[] = [
      user('turn 12'),
      user('the assistant turn'),
      { role: 'tool_result', toolCallId: 'a', content: 'r'.repeat(98_000) },
      { role: 'tool_result', toolCallId: 'b', content: 'r'.repeat(98_000) },
    ];
    const input = {
      messages: history,
      systemPrompt: '',
      contextWindow: 200_000,
      windowKnown: true,
    } as const;

    const before = computePressure({ ...input, lastUsage: measured });
    const after = computePressure({ ...input, lastUsage: measured, measuredPrefixLength: 1 });

    expect(shouldCompactAt(before, 0.9, { maxOutputTokens: 8_192 })).toBe(false);
    expect(shouldCompactAt(after, 0.9, { maxOutputTokens: 8_192 })).toBe(true);
  });
});

describe('isApproximate (hardening §6.3)', () => {
  const p = (over: Partial<Parameters<typeof computePressure>[0]> = {}) =>
    computePressure({
      messages: [user('a')],
      systemPrompt: '',
      contextWindow: 200_000,
      windowKnown: true,
      ...over,
    });

  it('is true on the estimate branch', () => {
    expect(isApproximate(p())).toBe(true);
  });

  it('is true on the measured branch once a delta exists, and false without one', () => {
    const usage: TokenUsage = { inputTokens: 1_000, outputTokens: 0 };
    const history = [user('a'), user('assistant'), user('x'.repeat(4_000))];

    expect(isApproximate(p({ lastUsage: usage }))).toBe(false);
    expect(
      isApproximate(p({ lastUsage: usage, messages: history, measuredPrefixLength: 1 })),
    ).toBe(true);
  });
});
