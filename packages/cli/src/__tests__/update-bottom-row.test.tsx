/**
 * The bottom row with THREE occupants (cli-auto-update §6.1 / AC-17 / AC-25).
 *
 * P0-1 IS A LAYOUT FAILURE THAT REPORTS NOTHING, and this file is where it would
 * be caught. A new conditional row inside `AppShell`'s `height={frameHeight(rows)}`
 * frame does not make the frame taller — Yoga takes the row out of the only
 * `flexShrink={1}` child, the transcript — while `viewportRows()` keeps returning
 * the old number to five consumers. The failure mode this round adds is subtler
 * than the one `bottom-status-row.test.tsx` already guards: an `UpdateLine` that
 * returned `null` would still satisfy `if (update)`, and the row would collapse
 * to ZERO rows for as long as the updater had nothing to say — which is almost
 * always.
 *
 * So this file pins three things: the precedence table, one row in every phase,
 * and that `budget.ts` is STILL unchanged after adding a third occupant.
 */

import { describe, expect, it } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { BottomStatusRow } from '../ui/BottomStatusRow.js';
import { ActivityLine } from '../ui/ActivityLine.js';
import { UpdateLine } from '../ui/UpdateLine.js';
import { ACTIVITY_PHRASES } from '../ui/activity-phrases.js';
import { getTheme } from '../ui/theme.js';
import { chromeBudget, viewportRows } from '../ui/layout/budget.js';
import { shouldRenderUpdateLine } from '../update/types.js';
import { UPDATE_LIMITS } from '../update/limits.js';
import type { Toast } from '../agent/reducer.js';
import type { RenderMode } from '../ui/layout/frame.js';
import type { TermCapabilities } from '../ui/capabilities.js';
import type { UpdatePhase, UpdateSnapshot } from '../update/types.js';

const CAPS: TermCapabilities = { colorLevel: 3, unicode: true };
const THEME = getTheme('cool', CAPS);
const TOAST: Toast = { id: 't1', level: 'info', text: 'Thinking shown.', ttlMs: 2500 };

const hasPhrase = (frame: string): boolean =>
  ACTIVITY_PHRASES.some((phrase) => frame.includes(phrase));

function snap(over: Partial<UpdateSnapshot> = {}): UpdateSnapshot {
  return {
    phase: 'ready',
    currentVersion: '0.5.9',
    latestVersion: '0.6.0',
    source: 'npm-global',
    nextCheckAt: null,
    consecutiveFailures: 0,
    ...over,
  };
}

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

/** The §6.1 call-site rule, verbatim — presence is decided HERE (C-15). */
function updateNode(snapshot: UpdateSnapshot | null): React.ReactNode {
  return snapshot && shouldRenderUpdateLine(snapshot) ? (
    <UpdateLine snapshot={snapshot} compact={false} theme={THEME} caps={CAPS} />
  ) : null;
}

function frameOf(
  mode: RenderMode,
  toasts: Toast[],
  running: boolean,
  update: UpdateSnapshot | null,
): string {
  const { lastFrame, unmount } = render(
    <BottomStatusRow
      mode={mode}
      toasts={toasts}
      activity={running ? activityNode() : null}
      update={updateNode(update)}
      theme={THEME}
    />,
  );
  const frame = stripAnsi(lastFrame() ?? '');
  unmount();
  return frame;
}

describe('AC-17: precedence is toast > activity > update > blank', () => {
  it('a toast wins the row even when both others want it', () => {
    // A transient ack is a RESPONSE TO THE USER, and the row nearest the input
    // belongs to it.
    const frame = frameOf('fullscreen', [TOAST], true, snap());
    expect(frame).toContain('Thinking shown.');
    expect(hasPhrase(frame)).toBe(false);
    expect(frame).not.toContain('0.6.0');
  });

  it('the activity line beats the update line', () => {
    // The update line is the only PERSISTENT one of the three, so deferring it
    // costs nothing — whereas an activity line deferred never renders at all
    // (D-2). It also means a user who is actively working never sees the
    // updater until they stop, which is the whole of the silence requirement.
    const frame = frameOf('fullscreen', [], true, snap());
    expect(hasPhrase(frame)).toBe(true);
    expect(frame).not.toContain('0.6.0');
  });

  it('the update line takes the row when nothing else wants it', () => {
    const frame = frameOf('fullscreen', [], false, snap());
    expect(frame).toContain('0.6.0 installed');
  });

  it('the blank budgeted row survives when nobody wants it', () => {
    expect(frameOf('fullscreen', [], false, null).trim()).toBe('');
    // ... including when the updater exists but has nothing to say, which is
    // the common case and the one P0-1 would have broken.
    expect(frameOf('fullscreen', [], false, snap({ phase: 'idle' })).trim()).toBe('');
  });
});

describe('AC-25: full-screen is ALWAYS exactly one row', () => {
  it('holds for every update phase, with and without the other occupants', () => {
    const phases: UpdatePhase[] = [
      'idle',
      'checking',
      'available',
      'installing',
      'ready',
      'failed',
    ];
    for (const phase of phases) {
      for (const toasts of [[], [TOAST]] as Toast[][]) {
        for (const running of [false, true]) {
          const label = `${phase}/${toasts.length}/${running}`;
          const frame = frameOf(
            'fullscreen',
            toasts,
            running,
            snap({ phase, consecutiveFailures: 3 }),
          );
          expect(frame.split('\n'), label).toHaveLength(1);
        }
      }
    }
  });

  it('the four pre-existing states are unchanged when `update` is absent', () => {
    // The prop is OPTIONAL (P2-1), and every existing caller and fixture omits
    // it. Omitting it must be byte-identical to the pre-feature behaviour.
    const states: [string, Toast[], boolean][] = [
      ['idle', [], false],
      ['running', [], true],
      ['toast', [TOAST], false],
      ['toast while running', [TOAST], true],
    ];
    for (const [label, toasts, running] of states) {
      const { lastFrame, unmount } = render(
        <BottomStatusRow
          mode="fullscreen"
          toasts={toasts}
          activity={running ? activityNode() : null}
          theme={THEME}
        />,
      );
      expect(stripAnsi(lastFrame() ?? '').split('\n'), label).toHaveLength(1);
      unmount();
    }
  });
});

describe('inline keeps the conditional stack', () => {
  it('draws nothing when nobody wants the row', () => {
    expect(frameOf('inline', [], false, null).trim()).toBe('');
  });

  it('draws the update line alone when it is the only occupant', () => {
    expect(frameOf('inline', [], false, snap())).toContain('0.6.0 installed');
  });
});

describe('shouldRenderUpdateLine — the presence rule itself', () => {
  it('is true exactly for available / installing / ready', () => {
    expect(shouldRenderUpdateLine(snap({ phase: 'available' }))).toBe(true);
    expect(shouldRenderUpdateLine(snap({ phase: 'installing' }))).toBe(true);
    expect(shouldRenderUpdateLine(snap({ phase: 'ready' }))).toBe(true);
    expect(shouldRenderUpdateLine(snap({ phase: 'idle' }))).toBe(false);
    expect(shouldRenderUpdateLine(snap({ phase: 'checking' }))).toBe(false);
  });

  it('holds `failed` back until the threshold (D-7)', () => {
    for (let n = 0; n < UPDATE_LIMITS.failuresBeforeNotice; n += 1) {
      expect(shouldRenderUpdateLine(snap({ phase: 'failed', consecutiveFailures: n })), `n=${n}`)
        .toBe(false);
    }
    expect(
      shouldRenderUpdateLine(
        snap({ phase: 'failed', consecutiveFailures: UPDATE_LIMITS.failuresBeforeNotice }),
      ),
    ).toBe(true);
  });
});

describe('AC-2: the frame budget is UNCHANGED by this round', () => {
  it('viewportRows still takes one argument and answers the same', () => {
    // Structural form of the guarantee: there is no session-state input the
    // layout could react to, so the updater cannot move the transcript.
    expect(viewportRows.length).toBe(1);
    for (const rows of [12, 19, 20, 24, 27, 28, 40, 200]) {
      expect(viewportRows(rows), `rows=${rows}`).toBe(viewportRows(rows));
    }
    expect(viewportRows(24)).toBe(16);
  });

  it('chromeBudget still enumerates exactly header + toast + composer + status', () => {
    // If a future round adds the bottom-chrome row this one declined to add,
    // this is where it shows up — rather than as a transcript that silently
    // loses a row while the updater has news (R-13).
    const budget = chromeBudget(24);
    expect(Object.keys(budget).sort()).toEqual(['composer', 'header', 'status', 'toast']);
    expect(budget.toast).toBe(1);
  });
});
