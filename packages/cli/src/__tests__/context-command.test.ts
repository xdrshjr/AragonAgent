/**
 * `/context` (context-usage-gauge-accuracy §7.1, T18 / T18b).
 *
 * THE COMMAND EXISTS TO BE TRUSTED, so the rows below are mostly about it not
 * lying. Two in particular:
 *
 *   - the `Window` line has to NAME the denominator's source, because the
 *     invented 128k placeholder is indistinguishable from a real window at every
 *     other surface;
 *   - the `Compaction` line has FIVE forms, and the single-form version of it
 *     tells a `--no-compaction` session that a rescue is coming at 90 %.
 */

import { describe, expect, it } from 'vitest';
import { formatContextReport } from '../compaction/context-command.js';
import type { CommandContext } from '../commands/registry.js';
import { offCompactionSnapshot } from '../compaction/wiring.js';
import { DEFAULT_COMPACTION_CONFIG } from '../config/schema.js';
import { initialViewState, type UsageTotal, type ViewState } from '../agent/reducer.js';
import type { CompactionSnapshot, ContextUsageSnapshot } from '../compaction/types.js';

interface Opts {
  usage?: Partial<ContextUsageSnapshot>;
  registered?: boolean;
  enabled?: boolean;
  snapshot?: Partial<CompactionSnapshot>;
  usageTotal?: Partial<UsageTotal>;
}

function ctx(opts: Opts = {}): CommandContext {
  const usage: ContextUsageSnapshot = {
    occupied: 86_200,
    window: 200_000,
    pct: 43,
    source: 'usage',
    deltaTokens: 0,
    windowKnown: true,
    windowOverridden: false,
    ...opts.usage,
  };
  const snapshot: CompactionSnapshot = {
    ...offCompactionSnapshot(),
    live: true,
    model: 'claude-haiku-4-5',
    compactions: 2,
    tokensReclaimed: 118_000,
    ...opts.snapshot,
  };
  const state: ViewState = {
    ...initialViewState(),
    usageTotal: {
      inputTokens: 290_000,
      outputTokens: 48_200,
      cacheReadTokens: 940_000,
      cacheWriteTokens: 12_000,
      costUsd: 3.21,
      ...opts.usageTotal,
    },
  };
  const controller = {
    getContextUsage: () => usage,
    getCompactionSnapshot: () => snapshot,
    getCompactionConfig: () => DEFAULT_COMPACTION_CONFIG,
    isCompactionRegistered: () => opts.registered !== false,
    isCompactionEnabled: () => opts.enabled !== false,
  };
  return { controller, state } as unknown as CommandContext;
}

describe('T18 - the Window line names its source', () => {
  it('the model table', () => {
    expect(formatContextReport(ctx())).toContain('200000   from the model table');
  });

  it('a user override, named as such (I-6)', () => {
    // A HAND-TYPED WINDOW THAT IS WRONG is the case that most needs to be
    // visible, which is why `windowOverridden` is a second boolean rather than
    // being folded into `windowKnown`.
    const text = formatContextReport(
      ctx({ usage: { window: 1_000_000, windowOverridden: true } }),
    );
    expect(text).toContain('1000000   from contextWindow in config.json (overrides the model table)');
  });

  it('the invented placeholder, admitted as invented', () => {
    const text = formatContextReport(ctx({ usage: { window: 128_000, windowKnown: false } }));
    expect(text).toContain('PLACEHOLDER - this model is not in the table');
    expect(text).toContain('set contextWindow to correct it');
  });
});

describe('T18 - the session-spend line says what it contains (D-7)', () => {
  it('names the three other spenders folded into it', () => {
    const text = formatContextReport(ctx());
    expect(text).toContain('includes subagent, fast-tier and compaction spend');
    expect(text).toContain('not just this conversation');
  });

  it('breaks out the cache terms, and omits them when there are none', () => {
    // THE `^` UNDER-REPORTED THEM AND THE `$` DID NOT (P1-3). This clause is how
    // a user behind a caching gateway can see that it no longer does.
    expect(formatContextReport(ctx())).toContain('incl. 940.0k cache read, 12.0k cache write');
    const direct = formatContextReport(
      ctx({ usageTotal: { cacheReadTokens: 0, cacheWriteTokens: 0 } }),
    );
    expect(direct).not.toContain('incl.');
  });
});

describe('T18b - RV-8: the Compaction line has five forms, not one', () => {
  it('not registered (--no-compaction) promises NOTHING', () => {
    // THE ROW THIS FEATURE MOST NEEDED. The naive single-form implementation
    // prints "on - triggers at 90%" here, which is a rescue that cannot come -
    // in the one command whose entire purpose is to be believable.
    const line = compactionLineOf(formatContextReport(ctx({ registered: false })));
    expect(line).toContain('not registered for this session');
    expect(line).not.toMatch(/\bon\b/);
    expect(line).not.toContain('triggers at');
  });

  it('self-disabled names the reason and the way out', () => {
    const line = compactionLineOf(
      formatContextReport(
        ctx({ snapshot: { selfDisabled: true, selfDisabledReason: 'insufficient_reclaim' } }),
      ),
    );
    expect(line).toContain('self-disabled (insufficient_reclaim)');
    expect(line).toContain('/compact on');
  });

  it('/compact off names the way back', () => {
    const line = compactionLineOf(formatContextReport(ctx({ enabled: false })));
    expect(line).toContain('off for this session');
    expect(line).toContain('/compact on re-enables it');
  });

  it('enabled but no summarizer still reports the thresholds', () => {
    // The thresholds come from CONFIG, so they are true whether or not a
    // summarizer resolves right now - the same distinction the gauge's colour
    // ladder makes (P2-6 / RV-4).
    const line = compactionLineOf(formatContextReport(ctx({ snapshot: { live: false } })));
    expect(line).toContain('on, but no summarizer model resolves');
    expect(line).toContain('triggers at 90%');
  });

  it('fully live reports the session totals', () => {
    const line = compactionLineOf(formatContextReport(ctx()));
    expect(line).toContain('on - triggers at 90% (amber at 75%)');
    expect(line).toContain('2 this session');
    expect(line).toContain('118.0k reclaimed');
  });
});

describe('T18b - the occupancy never comes from the zero pressure (RV-8)', () => {
  it('an unregistered session still reports a real occupancy', () => {
    // `getCompactionSnapshot().pressure` is `offCompactionSnapshot()`'s
    // HARDCODED ZERO here, so a report built on it would read 0% for exactly the
    // sessions this feature exists to fix.
    const text = formatContextReport(ctx({ registered: false }));
    expect(text).toContain('86.2k of 200.0k');
    expect(text).not.toMatch(/Occupancy\s+~?0%/);
  });
});

describe('the occupancy breakdown', () => {
  it('splits measured from estimated when there is a delta', () => {
    const text = formatContextReport(ctx({ usage: { deltaTokens: 1_100 } }));
    expect(text).toContain('[measured 85.1k + 1.1k estimated]');
    // Any delta makes the whole figure approximate, so the percentage is hedged.
    expect(text).toContain('~43%');
  });

  it('says so plainly when the whole figure is an estimate', () => {
    const text = formatContextReport(ctx({ usage: { source: 'estimate' } }));
    expect(text).toContain('[estimated 86.2k]');
    expect(text).toContain('no provider-reported usage yet');
  });

  it('is unhedged when nothing was appended since the measurement', () => {
    const text = formatContextReport(ctx());
    expect(text).toContain('nothing appended since the last provider-reported usage');
    expect(text).not.toContain('~43%');
  });
});

/** The `Compaction` row alone, so `not.toContain` cannot match another line. */
function compactionLineOf(report: string): string {
  const line = report.split('\n').find((l) => l.trimStart().startsWith('Compaction '));
  expect(line, 'the report has a Compaction line').toBeDefined();
  return line!;
}
