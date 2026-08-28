/**
 * The shared bottom row (agent-activity-presentation §3.2.3 / D-17 / AC-8a).
 *
 * P0-1 IS A LAYOUT FAILURE THAT REPORTS NOTHING. A new conditional row inside
 * `AppShell`'s `height={frameHeight(rows)}` frame does not make the frame taller
 * — Yoga takes the row out of the only `flexShrink={1}` child, the transcript —
 * while `viewportRows()` keeps returning the old number to five consumers. The
 * transcript would draw one row shorter than everything believes, ONLY while a
 * run is in flight, so the layout would shift on submit and shift back on
 * `agent_end`.
 *
 * So the row is SHARED, and this file pins both halves: the row is exactly one
 * row in every state, and `budget.ts` is unchanged by this round.
 */

import { describe, expect, it } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { BottomStatusRow } from '../ui/BottomStatusRow.js';
import { ActivityLine } from '../ui/ActivityLine.js';
import { ACTIVITY_PHRASES } from '../ui/activity-phrases.js';
import { getTheme } from '../ui/theme.js';
import { chromeBudget, viewportRows } from '../ui/layout/budget.js';
import type { Toast } from '../agent/reducer.js';
import type { RenderMode } from '../ui/layout/frame.js';
import type { TermCapabilities } from '../ui/capabilities.js';

const CAPS: TermCapabilities = { colorLevel: 3, unicode: true };
const THEME = getTheme('cool', CAPS);
const TOAST: Toast = { id: 't1', level: 'info', text: 'Thinking shown.', ttlMs: 2500 };

/** Whether the frame carries a working phrase — the activity line's signature. */
const hasPhrase = (frame: string): boolean =>
  ACTIVITY_PHRASES.some((phrase) => frame.includes(phrase));

function activityNode(): React.ReactElement {
  return (
    <ActivityLine
      startedAt={1_700_000_000_000}
      elapsedMs={900}
      reducedMotion
      theme={THEME}
      caps={CAPS}
    />
  );
}

function frameOf(mode: RenderMode, toasts: Toast[], running: boolean): string {
  const { lastFrame, unmount } = render(
    <BottomStatusRow
      mode={mode}
      toasts={toasts}
      activity={running ? activityNode() : null}
      theme={THEME}
    />,
  );
  const frame = stripAnsi(lastFrame() ?? '');
  unmount();
  return frame;
}

describe('BottomStatusRow — full-screen is ALWAYS exactly one row', () => {
  it('holds one row in all four states', () => {
    const states: [string, Toast[], boolean][] = [
      ['idle', [], false],
      ['running', [], true],
      ['toast', [TOAST], false],
      ['toast while running', [TOAST], true],
    ];
    for (const [label, toasts, running] of states) {
      const frame = frameOf('fullscreen', toasts, running);
      expect(frame.split('\n'), label).toHaveLength(1);
    }
  });

  it('gives the row to the toast when both want it', () => {
    // A transient ack is a RESPONSE TO THE USER, and the row nearest the input
    // belongs to it.
    const frame = frameOf('fullscreen', [TOAST], true);
    expect(frame).toContain('Thinking shown.');
    expect(hasPhrase(frame)).toBe(false);
  });

  it('shows the activity line when the row is free', () => {
    expect(hasPhrase(frameOf('fullscreen', [], true))).toBe(true);
  });
});

describe('BottomStatusRow — inline keeps the conditional stack', () => {
  it('draws nothing when there is neither a toast nor a run', () => {
    expect(frameOf('inline', [], false).trim()).toBe('');
  });

  it('draws the activity line alone when a run is in flight', () => {
    expect(hasPhrase(frameOf('inline', [], true))).toBe(true);
  });
});

describe('the frame budget is unchanged by this round (AC-8a / DoD #8)', () => {
  it('viewportRows returns the same value whether or not a run is in flight', () => {
    // It TAKES NO SUCH ARGUMENT, which is the structural form of the guarantee:
    // there is no session-state input the layout could react to.
    expect(viewportRows.length).toBe(1);
    for (const rows of [12, 19, 20, 24, 27, 28, 40, 200]) {
      expect(viewportRows(rows), `rows=${rows}`).toBe(viewportRows(rows));
    }
  });

  it('chromeBudget still enumerates exactly header + toast + composer + status', () => {
    // If a future round adds the bottom-chrome row this one declined to add,
    // this is where it shows up — rather than as a transcript that silently
    // loses a row while running (R-11).
    const budget = chromeBudget(24);
    expect(Object.keys(budget).sort()).toEqual(['composer', 'header', 'status', 'toast']);
    expect(budget.toast).toBe(1);
    expect(viewportRows(24)).toBe(16);
  });
});
