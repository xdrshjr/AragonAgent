/**
 * Rendering the retry card and the status-bar chip (llm-api-retry-backoff §11,
 * AC-27 / AC-28).
 *
 * ASCII-tier coverage is not decoration: every glyph in this feature comes from
 * `pickGlyphs`, and a literal anywhere else shows mojibake on a legacy `cmd.exe`
 * whatever the capability probe reported. `glyphs.test.ts`'s static scan is the
 * other half of that guarantee; this file checks the OUTPUT.
 */

import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import React from 'react';
import { render as inkRender } from 'ink';
import { render } from 'ink-testing-library';
import { RetryCard, retryCardColor } from '../ui/entries/RetryCard.js';
import { StatusBar } from '../ui/StatusBar.js';
import { getTheme } from '../ui/theme.js';
import { pickGlyphs } from '../ui/glyphs.js';
import {
  RETRY_UI,
  formatRetryChip,
  formatRetryLine,
  retryHeadline,
  secondsLeft,
  type RetryPhase,
} from '../agent/retry-view.js';

const RICH = { colorLevel: 3 as const, unicode: true };
const ASCII = { colorLevel: 0 as const, unicode: false };

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

const NOW = 1_700_000_000_000;

function card(
  phase: RetryPhase,
  caps: typeof RICH | typeof ASCII,
  over: Partial<React.ComponentProps<typeof RetryCard>> = {},
): string {
  const { lastFrame, unmount } = render(
    <RetryCard
      attempt={3}
      maxRetries={10}
      errorType="overloaded"
      phase={phase}
      resumeAt={NOW + 7_400}
      totalRetries={3}
      elapsedMs={12_400}
      now={NOW}
      // Reduced motion in every case so the spinner never interferes with the
      // string assertions; the animated variant has its own case below.
      reducedMotion
      theme={getTheme('cool', caps)}
      caps={caps}
      {...over}
    />,
  );
  const out = stripAnsi(lastFrame() ?? '');
  unmount();
  return out;
}

// ---------------------------------------------------------------------------
// The pure line builder
// ---------------------------------------------------------------------------

describe('secondsLeft', () => {
  it('CEILS, so a countdown never shows 0s while the wait is still running', () => {
    expect(secondsLeft(NOW + 7_400, NOW)).toBe(8);
    expect(secondsLeft(NOW + 1, NOW)).toBe(1);
    expect(secondsLeft(NOW, NOW)).toBe(0);
  });

  it('floors at 0 for a wait that is already over, and for an absent instant', () => {
    expect(secondsLeft(NOW - 5_000, NOW)).toBe(0);
    expect(secondsLeft(undefined, NOW)).toBe(0);
  });
});

describe('retryHeadline', () => {
  it('derives from errorType alone, never from the provider message', () => {
    // A human-facing sentence must never become a machine-readable contract.
    expect(retryHeadline('overloaded')).toBe('Provider overloaded');
    expect(retryHeadline('rate_limit')).toBe('Rate limited by the provider');
    expect(retryHeadline('network_error')).toBe('Network error reaching the provider');
    expect(retryHeadline('timeout')).toBe('The request timed out');
    expect(retryHeadline('server_error')).toBe('Provider error');
    expect(retryHeadline('something-new')).toBe('Provider call failed');
  });
});

describe('formatRetryLine', () => {
  const base = { attempt: 3, maxRetries: 10, errorType: 'overloaded' };

  it('builds one line per phase', () => {
    const g = pickGlyphs(RICH);
    expect(formatRetryLine({ ...base, phase: 'waiting', resumeAt: NOW + 7_000 }, g, NOW))
      .toBe('Provider overloaded · retry 3/10 in 7s');
    expect(formatRetryLine({ ...base, phase: 'retrying' }, g, NOW))
      .toBe('Provider overloaded · retry 3/10 …');
    expect(formatRetryLine({ ...base, phase: 'recovered', totalRetries: 3, elapsedMs: 12_400 }, g, NOW))
      .toBe('recovered after 3 retries · 12.4s');
    expect(formatRetryLine({ ...base, phase: 'exhausted', totalRetries: 10, elapsedMs: 181_000 }, g, NOW))
      .toBe('Provider overloaded · gave up after 10 retries · 3m01s');
    expect(formatRetryLine({ ...base, phase: 'interrupted', totalRetries: 2 }, g, NOW))
      .toBe('interrupted after 2 retries');
  });

  it('says "1 retry", not "1 retries"', () => {
    const g = pickGlyphs(RICH);
    expect(formatRetryLine({ ...base, phase: 'interrupted', totalRetries: 1 }, g, NOW))
      .toBe('interrupted after 1 retry');
  });

  it('falls back to `attempt` when a settled card carries no totalRetries', () => {
    const g = pickGlyphs(RICH);
    expect(formatRetryLine({ ...base, phase: 'interrupted' }, g, NOW))
      .toBe('interrupted after 3 retries');
  });

  it('is pure ASCII in the ASCII tier, in every phase', () => {
    const g = pickGlyphs(ASCII);
    for (const phase of ['waiting', 'retrying', 'recovered', 'exhausted', 'interrupted'] as const) {
      const line = formatRetryLine(
        { ...base, phase, resumeAt: NOW + 1000, totalRetries: 3, elapsedMs: 1200 },
        g,
        NOW,
      );
      expect(line, phase).not.toMatch(/[^\x00-\x7f]/);
    }
  });
});

// ---------------------------------------------------------------------------
// AC-27 — the card
// ---------------------------------------------------------------------------

describe('RetryCard renders one row in all five phases (AC-27)', () => {
  const phases: RetryPhase[] = ['waiting', 'retrying', 'recovered', 'exhausted', 'interrupted'];

  for (const phase of phases) {
    it(`${phase} renders exactly one row`, () => {
      const out = card(phase, RICH);
      expect(out.split('\n').filter((l) => l.trim().length > 0)).toHaveLength(1);
    });
  }

  it('shows the countdown while waiting and the hint next to it', () => {
    const out = card('waiting', RICH);
    expect(out).toContain('retry 3/10 in 8s');
    expect(out).toContain('Esc to cancel');
  });

  it('offers Esc ONLY while waiting', () => {
    // Once the attempt is out there is nothing left to cancel by ending a wait,
    // and a settled card is history.
    for (const phase of ['retrying', 'recovered', 'exhausted', 'interrupted'] as const) {
      expect(card(phase, RICH), phase).not.toContain('Esc to cancel');
    }
  });

  it('suppresses the hint when the session is not interactive', () => {
    expect(card('waiting', RICH, { interactive: false })).not.toContain('Esc to cancel');
  });

  it('renders only ASCII under caps.unicode === false, in every phase', () => {
    for (const phase of phases) {
      expect(card(phase, ASCII), phase).not.toMatch(/[^\x00-\x7f]/);
    }
  });

  it('keeps the countdown ticking under reducedMotion (a frozen number is broken)', () => {
    // Reduced motion is about ANIMATION. The spinner goes; the information stays.
    const still = card('waiting', RICH, { reducedMotion: true });
    expect(still).toContain('in 8s');
    const moving = card('waiting', RICH, { reducedMotion: false });
    expect(moving).toContain('in 8s');
  });

  it('colours in flight as a warning, exhausted as an error, and settled as muted', () => {
    const theme = getTheme('cool', RICH);
    expect(retryCardColor('waiting', theme)).toBe(theme.noticeWarn);
    expect(retryCardColor('retrying', theme)).toBe(theme.noticeWarn);
    expect(retryCardColor('exhausted', theme)).toBe(theme.noticeError);
    // `interrupted` records a USER decision; colouring it red would blame them.
    expect(retryCardColor('interrupted', theme)).toBe(theme.muted);
    expect(retryCardColor('recovered', theme)).toBe(theme.muted);
  });
});

// ---------------------------------------------------------------------------
// AC-28 — the chip
// ---------------------------------------------------------------------------

describe('formatRetryChip', () => {
  it('is full at width and compact below the breakpoint', () => {
    const active = { attempt: 3, max: 10, secondsLeft: 7 };
    expect(formatRetryChip(active, 120)).toBe('retry 3/10 7s');
    expect(formatRetryChip(active, RETRY_UI.statusCompactCols)).toBe('retry 3/10 7s');
    expect(formatRetryChip(active, RETRY_UI.statusCompactCols - 1)).toBe('[r3]');
    expect(formatRetryChip(active, 80)).toBe('[r3]');
  });
});

describe('StatusBar retry chip (AC-28)', () => {
  /**
   * `ink-testing-library` hardcodes `columns` at 100, so the narrow case is driven
   * through Ink's own `render` with a stdout we control — the pattern
   * `team-panel.test.tsx` and `mouse-routing.test.tsx` already use.
   */
  const bar = (
    cols: number,
    retryActive?: { attempt: number; max: number; secondsLeft: number },
  ): string => {
    const stdout = new EventEmitter() as EventEmitter & {
      columns: number;
      rows: number;
      write: (s: string) => void;
    };
    let last = '';
    stdout.columns = cols;
    stdout.rows = 24;
    stdout.write = (s: string) => {
      last = s;
    };

    const instance = inkRender(
      <StatusBar
        model="claude-sonnet-4-5"
        provider="anthropic"
        usageTotal={{ inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.24 }}
        context={{
          occupied: 1000,
          window: 200_000,
          pct: 1,
          source: 'usage',
          deltaTokens: 0,
          windowKnown: true,
          windowOverridden: false,
        }}
        status="running"
        elapsedMs={1000}
        thinkingLevel="off"
        tokPerSec={0}
        theme={getTheme('cool', ASCII)}
        caps={ASCII}
        {...(retryActive ? { retryActive } : {})}
      />,
      { stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false, exitOnCtrlC: false },
    );
    const out = stripAnsi(last);
    instance.unmount();
    return out;
  };

  it('shows the real retry stage and countdown at 120 columns', () => {
    expect(bar(120, { attempt: 3, max: 10, secondsLeft: 7 })).toContain('等待重试 7s');
  });

  it('keeps retry and the complete context pair at 80 columns', () => {
    const narrow = bar(80, { attempt: 3, max: 10, secondsLeft: 7 });
    expect(narrow).toContain('重试');
    expect(narrow).toMatch(/1(?:\.0)?k\/200(?:\.0)?k tok/);
    expect(narrow).not.toContain('retry 3/10');
  });

  it('renders nothing at all when no retry is in flight', () => {
    // An ordinary session's bar has to be unchanged by this feature.
    const plain = bar(120);
    expect(plain).not.toContain('retry');
    expect(plain).not.toContain('[r');
  });
});
