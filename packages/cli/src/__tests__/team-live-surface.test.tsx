/**
 * ONE dispatch, ONE live block (tui-subagent-double-roster A-2 / A-3).
 *
 * The reporter's screenshot showed the SAME children twice in one frame: the
 * roster above the header and the transcript card above the input box, with the
 * running children painted as failures in the lower copy. These assertions pin the
 * two halves of the fix against the REAL components, not a projection:
 *
 *  - while a dispatch is active the roster is the only live surface (the card is
 *    suppressed everywhere: the transcript, the estimate, both tail windows and the
 *    plain-text fallback), and the roster sits directly above the composer;
 *  - the card comes back exactly once, as history, when the dispatch settles -
 *    `settledCount`/`printBoundary` semantics are unchanged, `state.entries` is
 *    never filtered.
 */

import { describe, expect, it } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { EntryView } from '../ui/Transcript.js';
import { ScrollbackShell } from '../ui/ScrollbackShell.js';
import { TeamPanel } from '../ui/TeamPanel.js';
import { LiveTail } from '../ui/scrollback/LiveTail.js';
import { buildScrollbackBudget } from '../ui/scrollback/budget.js';
import { SCROLLBACK_LIMITS } from '../ui/scrollback/limits.js';
import { buildLivePreview } from '../ui/scrollback/live-preview.js';
import { settledCount } from '../ui/scrollback/settled-boundary.js';
import { printBoundary, selectTailWindow, tailWindowStart } from '../ui/scrollback/tail-window.js';
import { buildTeamPanelLayout } from '../ui/layout/team-panel.js';
import { estimateEntryRows } from '../ui/layout/virtual-window.js';
import { getTheme } from '../ui/theme.js';
import { pickGlyphs } from '../ui/glyphs.js';
import type { TermCapabilities } from '../ui/capabilities.js';
import type { Entry } from '../agent/reducer.js';
import type { SubagentRun, TeamSnapshot } from '../team/types.js';

const CAPS = { colorLevel: 3, unicode: true } as unknown as TermCapabilities;
const THEME = getTheme('cool', CAPS);
const GLYPHS = pickGlyphs(CAPS);
const COLUMNS = 100;
const ROWS = 30;
const NOW = 66_000;

// eslint-disable-next-line no-control-regex
const stripAnsi = (value: string): string => value.replace(/\x1b\[[0-9;]*m/g, '');

function child(over: Partial<SubagentRun> = {}): SubagentRun {
  return {
    label: 'planner',
    description: 'map the auth middleware',
    phase: 'tool',
    startedAt: 1_000,
    turns: 3,
    toolCalls: 4,
    lastTool: 'grep',
    usage: { inputTokens: 10, outputTokens: 5 },
    filesTouched: [],
    messagesSent: 0,
    ...over,
  } as SubagentRun;
}

function snapshot(runs: SubagentRun[]): TeamSnapshot {
  return {
    dispatchId: 'd1', active: true, runs, requested: runs.length,
    startedAt: 1_000, messageCount: 0,
  };
}

function teamEntry(runs: SubagentRun[], over: Partial<Extract<Entry, { kind: 'team' }>> = {}): Entry {
  return {
    id: 'team-1', kind: 'team', dispatchId: 'd1', requested: runs.length,
    runs, aborted: false, active: true, ...over,
  };
}

const TAIL_MARKER = 'TAIL-MARKER';

function assistant(text = TAIL_MARKER): Entry {
  return { id: 'a-1', kind: 'assistant', text, thinkingOpen: false, streaming: false };
}

function layoutOf(team: TeamSnapshot) {
  return buildTeamPanelLayout({ snapshot: team, terminalRows: ROWS, availableRows: 18 });
}

/** The native band: real `ScrollbackShell` + real `TeamPanel` + real `LiveTail`. */
function frameOf(team: TeamSnapshot | null, entries: readonly Entry[]): string {
  const budget = buildScrollbackBudget({
    rows: ROWS, cols: COLUMNS, draftRows: 1, popupRows: 0, statusExpanded: false,
    overlayOpen: false,
    band: {
      itemCount: 0, panelEnabled: true,
      teamRowsNatural: team ? layoutOf(team).rowCount : 0,
      heldRailRows: 0, heldTeamRows: 0,
    },
  });
  const instance = render(
    <ScrollbackShell
      budget={budget}
      header={<></>}
      overlay={null}
      liveTailLines={[]}
      tail={<LiveTail entries={entries} maxEntries={SCROLLBACK_LIMITS.liveTailMaxEntries}
        rows={budget.band.previewRows} cols={budget.band.previewCols} expandedToolIds={{}}
        thinkingVisible reducedMotion density="comfortable" nowSec={61}
        theme={THEME} caps={CAPS} />}
      team={team ? (
        <TeamPanel snapshot={team} layout={layoutOf(team)} rows={ROWS}
          cols={budget.band.previewCols} reducedMotion now={NOW} theme={THEME} caps={CAPS} />
      ) : null}
      composer={<></>}
      status={<></>}
      placeholder={<></>}
      theme={THEME}
    />,
  );
  const frame = stripAnsi(instance.lastFrame() ?? '');
  instance.unmount();
  return frame;
}

function linesOf(frame: string): string[] {
  return frame.split('\n');
}

describe('one dispatch owns exactly one live block (A-2)', () => {
  it('draws each child once, even with both live surfaces mounted', () => {
    const team = snapshot([child()]);
    const frame = frameOf(team, [assistant(), teamEntry(team.runs)]);
    expect(linesOf(frame).filter((line) => line.includes('planner'))).toHaveLength(1);
  });

  it('never paints a running child with the failure glyph or `0ms`', () => {
    const team = snapshot([child(), child({ label: 'tester', phase: 'thinking' })]);
    const frame = frameOf(team, [assistant(), teamEntry(team.runs)]);
    // The transcript card used to paint both children with `glyphs.toolError` and
    // `0ms` while the roster above showed `1m05s` for the same children.
    expect(frame).not.toContain(GLYPHS.toolError);
    expect(frame).not.toMatch(/0ms/);
  });

  it('counts queued children in the roster header', () => {
    const team = snapshot([child({ phase: 'queued' }), child({ label: 'tester', phase: 'queued' })]);
    const frame = frameOf(team, [assistant()]);
    // The header used to read `0 running  0 done` above two rows that each said
    // `queued`; the bucket is named now, and the rows agree with it.
    const header = linesOf(frame).find((line) => line.includes('team')) ?? '';
    expect(header).toContain('2 queued');
    expect(header).toContain('0 running');
  });
});

describe('the roster sits directly above the composer (A-3)', () => {
  it('draws below the transcript tail, not above it', () => {
    const team = snapshot([child()]);
    const lines = linesOf(frameOf(team, [assistant(), teamEntry(team.runs)]));
    const tailRow = lines.findIndex((line) => line.includes(TAIL_MARKER));
    const rosterRow = lines.findIndex((line) => line.includes('planner'));
    expect(tailRow).toBeGreaterThanOrEqual(0);
    expect(rosterRow).toBeGreaterThan(tailRow);
  });

  it('keeps the band allocation unchanged (only the drawing order moved)', () => {
    const team = snapshot([child()]);
    const budget = buildScrollbackBudget({
      rows: ROWS, cols: COLUMNS, draftRows: 1, popupRows: 0, statusExpanded: false,
      overlayOpen: false,
      band: {
        itemCount: 0, panelEnabled: true, teamRowsNatural: layoutOf(team).rowCount,
        heldRailRows: 0, heldTeamRows: 0,
      },
    });
    expect(budget.band.teamRows).toBeGreaterThan(0);
    expect(budget.band.teamRows + budget.band.previewRows).toBe(budget.band.bandRows);
  });
});

describe('a settled dispatch becomes history exactly once', () => {
  it('renders the card when `active` is false', () => {
    const runs = [child({ phase: 'done', endedAt: 2_000 }), child({ label: 'tester', phase: 'done', endedAt: 2_000 })];
    const frame = frameOf(null, [assistant(), teamEntry(runs, { active: false, durationMs: 1_000 })]);
    expect(linesOf(frame).filter((line) => line.includes('planner'))).toHaveLength(1);
    expect(frame).toContain('subagents');
    expect(frame).toContain('2 ok');
  });

  it('separates a cancelled child from a failed one in the settled headline (E8)', () => {
    const runs = [child({ phase: 'done', endedAt: 2_000 }), child({ label: 'tester', phase: 'aborted', endedAt: 2_000 })];
    const frame = frameOf(null, [teamEntry(runs, { active: false, durationMs: 1_000, aborted: true })]);
    expect(frame).toContain('1 ok, 1 aborted');
    expect(frame).not.toContain('failed');
  });
});

describe('app mode draws the same one block (A-2, both modes)', () => {
  function entryFrame(entry: Entry, prev: Entry | undefined): string {
    const instance = render(
      <EntryView entry={entry} prev={prev} expanded={false} thinkingVisible reducedMotion
        density="comfortable" nowSec={61} theme={THEME} caps={CAPS} />,
    );
    const frame = stripAnsi(instance.lastFrame() ?? '');
    instance.unmount();
    return frame;
  }

  it('paints nothing for a live card and the card once for a settled one', () => {
    // `EntryView` IS BOTH MODES: the full-screen `TranscriptList` and the native band's
    // `LiveTail` mount this one component, so this is the app-mode half of "one block".
    const live = teamEntry([child()]);
    expect(entryFrame(live, assistant()).trim()).toBe('');
    const settled = teamEntry([child({ phase: 'done', endedAt: 2_000 })], {
      active: false, durationMs: 1_000,
    });
    const frame = entryFrame(settled, assistant());
    expect(frame).toContain('subagent');
    expect(frame).toContain('1 ok');
  });
});

describe('the print boundary is unchanged (printed is forever)', () => {
  it('holds the live card and prints the settled ones before it', () => {
    const entries: Entry[] = [assistant('one'), assistant('two'), teamEntry([child()])];
    // The active card is a WALL: everything before it may print, it may not.
    expect(settledCount(entries, true)).toBe(2);
    // ...and it is never counted as a window slot either, so the window still holds
    // two VISIBLE entries instead of one suppressed card.
    expect(tailWindowStart(entries, 2)).toBe(0);
    expect(printBoundary(entries, true, 2)).toBe(0);
  });

  it('prints the card once it settles, so the record is not lost', () => {
    const entries: Entry[] = [assistant('one'), teamEntry([child({ phase: 'done' })], { active: false, durationMs: 900 })];
    expect(settledCount(entries, false)).toBe(2);
  });
});

describe('every window function agrees on the suppression (A-2\')', () => {
  const live = teamEntry([child()]);

  it('estimates zero rows for the live card and a real height for the settled one', () => {
    expect(estimateEntryRows(live, COLUMNS, 'comfortable', false, false)).toBe(0);
    const settled = teamEntry([child()], { active: false, durationMs: 1_000 });
    expect(estimateEntryRows(settled, COLUMNS, 'comfortable', false, false)).toBeGreaterThan(0);
  });

  it('gives the live card no slot in the tail window or the plain-text fallback', () => {
    const entries = [assistant('one'), live];
    expect(selectTailWindow(entries, 2).entries.map((entry) => entry.id)).toEqual(['a-1']);
    expect(selectTailWindow(entries, 2).start).toBe(0);
    expect(buildLivePreview({ unsettled: [live], cols: COLUMNS, rows: 4, thinkingVisible: false }))
      .toEqual([]);
  });
});
