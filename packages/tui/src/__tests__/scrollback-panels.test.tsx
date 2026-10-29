/**
 * The native panel band, rendered
 * (release-gate-and-native-panels AC-15..AC-23, AC-33; tui-full-height-live-region
 * AC-F6 / AC-F7 / AC-F15).
 *
 * WHAT THIS FILE PINS, AND WHY IT IS A RENDER TEST AND NOT A PROP TEST. The feature's
 * two symptoms were "the TODO rail is gone" and "subagent execution looks plain", and
 * both are only observable in a frame: the rail has to appear as a COLUMN at the right
 * width, the roster as real rows with real columns, and the tail as the same cards the
 * transcript draws. `scrollback-app.test.tsx` proves the wiring reaches `App`; this file
 * proves the shell's geometry, which is where a wrong `cols` (the classic "preview
 * rendered at contentCols") is invisible to every other kind of test.
 *
 * THE NUMBERS ARE NOW THE POOL, NOT "JUST ENOUGH". `bandRows === remaining`, so on a
 * 30-row terminal the rail is 24 rows tall (it used to be 6) and the tail column owns
 * all 24 of its rows. It no longer FILLS them from the bottom, though: a tail that fits
 * is drawn from the top row down (`tail-anchor.ts`, plan A-prime), so the assertions
 * below check contiguity downward instead of a card glued to the composer. Every
 * expected number below is derived from the budget, never hardcoded twice.
 *
 * `ink-testing-library` renders at 100 columns, so `contentCols` is 99 and
 * `todoRailWidth(99)` is 15.
 */

import { describe, expect, it } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import { ScrollbackShell } from '../ui/ScrollbackShell.js';
import { TodoPanel } from '../ui/TodoPanel.js';
import { TeamPanel } from '../ui/TeamPanel.js';
import { LiveTail } from '../ui/scrollback/LiveTail.js';
import { buildScrollbackBudget, type ScrollbackBudget } from '../ui/scrollback/budget.js';
import { SCROLLBACK_LIMITS } from '../ui/scrollback/limits.js';
import { buildTeamPanelLayout } from '../ui/layout/team-panel.js';
import { getTheme } from '../ui/theme.js';
import { TODO_LIMITS } from '../model/todo/limits.js';
import type { TodoSnapshot } from '../model/todo/types.js';
import type { SubagentRun, TeamSnapshot } from '../model/team/types.js';
import type { Entry } from '../model/agent/reducer.js';
import { DEVELOPER_VOICE } from '../ui/tool-voice.js';

const CAPS = { colorLevel: 3 as const, unicode: true };
const THEME = getTheme('cool', CAPS);
const COLUMNS = 100;
const CONTENT_COLS = COLUMNS - 1;
const HEADER_ROW = 'hdr';

// eslint-disable-next-line no-control-regex
const stripAnsi = (value: string): string => value.replace(/\x1b\[[0-9;]*m/g, '');

const PLAN: TodoSnapshot = {
  items: [
    { content: 'collect data', activeForm: 'collecting data', status: 'completed' },
    { content: 'migrate schema', activeForm: 'migrating schema', status: 'in_progress' },
    { content: 'write tests', activeForm: 'writing tests', status: 'pending' },
    { content: 'run suite', activeForm: 'running the suite', status: 'pending' },
    { content: 'report', activeForm: 'reporting', status: 'pending' },
  ],
  total: 5,
  doneCount: 1,
  activeIndex: 1,
  updatedAt: 1,
  acceptance: null,
};

/** A plan longer than any rail: the drop markers are the point of `AC-16`. */
const LONG_PLAN: TodoSnapshot = {
  items: Array.from({ length: 12 }, (_, index) => ({
    content: `step ${index}`,
    activeForm: `running step ${index}`,
    status: index === 0 ? 'completed' as const : index === 1 ? 'in_progress' as const
      : 'pending' as const,
  })),
  total: 12,
  doneCount: 1,
  activeIndex: 1,
  updatedAt: 1,
  acceptance: null,
};

function subagentRun(over: Partial<SubagentRun> = {}): SubagentRun {
  return {
    label: 'planner',
    description: 'read the auth middleware',
    phase: 'tool',
    startedAt: 1000,
    turns: 3,
    toolCalls: 4,
    lastTool: 'grep',
    usage: { inputTokens: 10, outputTokens: 5 },
    filesTouched: [],
    messagesSent: 0,
    ...over,
  } as SubagentRun;
}

function teamSnapshot(over: Partial<TeamSnapshot> = {}): TeamSnapshot {
  return {
    dispatchId: 'd1',
    active: true,
    runs: [
      subagentRun({ label: 'planner' }),
      subagentRun({ label: 'tester', description: 'map the route table', phase: 'thinking' }),
    ],
    requested: 2,
    startedAt: 1000,
    messageCount: 0,
    ...over,
  };
}

function teamEntry(runs: SubagentRun[]): Entry {
  return {
    id: 'team-1', kind: 'team', dispatchId: 'd1', requested: runs.length, runs,
    aborted: false, active: true,
  };
}

function toolEntry(over: Partial<Extract<Entry, { kind: 'tool' }>> = {}): Entry {
  return {
    id: 'tool-1', kind: 'tool', toolCallId: 'c1', name: 'bash', label: 'run the suite',
    argsRaw: '{"command":"npm test"}', status: 'running', live: ['ok 1 - a'], lastOutputAt: 1000,
    ...over,
  };
}

interface ShellOptions {
  snapshot?: TodoSnapshot | null;
  team?: TeamSnapshot | null;
  itemCount: number;
  teamRowsNatural?: number;
  entries?: readonly Entry[];
  overlayOpen?: boolean;
  panelEnabled?: boolean;
  terminalRows?: number;
  /** Only the narrow case changes this: `Ink` renders at 100 columns by default. */
  columns?: number;
  /** An open completion menu; it is what can shrink `remaining` far enough for `short`. */
  popupRows?: number;
  forceInactive?: boolean;
  /** The empty-session card (AC-F15). Mutually exclusive with `entries`. */
  opener?: boolean;
  /** Drop the header slot: the degraded-frame case has none. */
  noHeader?: boolean;
}

function budgetFor(options: ShellOptions): ScrollbackBudget {
  return buildScrollbackBudget({
    rows: options.terminalRows ?? 24,
    cols: options.columns ?? COLUMNS,
    draftRows: 1,
    popupRows: options.popupRows ?? 0,
    statusExpanded: false,
    overlayOpen: options.overlayOpen ?? false,
    forceInactive: options.forceInactive,
    band: {
      itemCount: options.itemCount,
      panelEnabled: options.panelEnabled ?? true,
      teamRowsNatural: options.teamRowsNatural ?? 0,
      heldRailRows: 0,
      heldTeamRows: 0,
    },
  });
}

function frameOf(options: ShellOptions): { frame: string; budget: ScrollbackBudget } {
  const budget = budgetFor(options);
  const teamLayout = buildTeamPanelLayout({
    snapshot: options.team ?? null, terminalRows: 24, availableRows: 18,
  });
  const rail = options.snapshot && budget.band.railRows >= TODO_LIMITS.panelMinRows
    ? (
      <TodoPanel snapshot={options.snapshot} width={budget.band.railCols}
        rows={budget.band.railRows} running={false} reducedMotion theme={THEME} caps={CAPS} />
    )
    : undefined;
  const team = options.team
    ? (
      // THE WHOLE BAND, not the left column (tui-subagent-panel D-2): the roster is a
      // full-width slot now, and `App` passes `budget.contentCols` for the same reason.
      <TeamPanel voice={DEVELOPER_VOICE} snapshot={options.team} layout={teamLayout} rows={24}
        cols={budget.contentCols} reducedMotion theme={THEME} caps={CAPS} />
    )
    : undefined;
  const tail = budget.band.previewRows > 0 && options.entries
    ? (
      <LiveTail voice={DEVELOPER_VOICE} entries={options.entries} maxEntries={SCROLLBACK_LIMITS.liveTailMaxEntries}
        rows={budget.band.previewRows} cols={budget.previewCols} expandedToolIds={{}}
        thinkingVisible reducedMotion={false} density="comfortable" nowSec={1000}
        theme={THEME} caps={CAPS} />
    )
    : undefined;
  // An 8-row stub: its first row must land on the band's first row, screen row 0 (the
  // identity row is a bottom slot since `tui-header-leaks-into-scrollback`).
  const opener = options.opener
    ? (
      <Box flexDirection="column">
        {Array.from({ length: 8 }, (_, index) => (
          <Text key={index}>opener row {index}</Text>
        ))}
      </Box>
    )
    : undefined;
  const node = (
    <ScrollbackShell
      budget={budget}
      header={options.noHeader ? <></> : <Text>{HEADER_ROW}</Text>}
      overlay={options.overlayOpen ? <></> : null}
      liveTailLines={['fallback row']}
      {...(opener ? { opener } : {})}
      {...(tail ? { tail } : {})}
      {...(team ? { team } : {})}
      {...(rail ? { rail } : {})}
      composer={<></>}
      status={<></>}
      placeholder={<></>}
      theme={THEME}
    />
  );
  const instance = render(node);
  const frame = stripAnsi(instance.lastFrame() ?? '');
  instance.unmount();
  return { frame, budget };
}

/** Display column at which `needle` starts, ignoring ANSI and counting wide glyphs. */
function columnOf(line: string, needle: string): number {
  const index = line.indexOf(needle);
  if (index < 0) return -1;
  return stringWidth(line.slice(0, index));
}

/** The character drawn at display column `col` (`''` past the end of the line). */
function charAt(line: string, col: number): string {
  let width = 0;
  for (const character of line) {
    if (width >= col) return character;
    width += stringWidth(character);
  }
  return '';
}

const ROW_INDEX = (frame: string): string[] => frame.split('\n');

/** Screen rows whose character at `col` is the rail's vertical border. */
function railRowsDrawn(frame: string, col: number, border: string): number {
  return ROW_INDEX(frame).filter((line) => charAt(line, col) === border).length;
}

/**
 * AC-6 / AC-7 (tui-subagent-panel): the roster is a FULL-WIDTH slot, and the rail gives
 * it the rows it takes.
 *
 * THIS IS THE ASSERTION THE DEFECT NEEDED. With the roster in the band's left column its
 * rows could never be wider than `previewCols` - 84 of a 100-column terminal with the
 * rail visible - so a right-aligned clock stopped 15 columns short of the screen's edge
 * no matter how carefully the row itself was laid out.
 */
describe('the roster spans the band (AC-6 / AC-7)', () => {
  it('measures contentCols, with the rail visible', () => {
    const { frame, budget } = frameOf({
      snapshot: PLAN, itemCount: PLAN.items.length, team: teamSnapshot(), teamRowsNatural: 3,
    });
    expect(budget.band.railCols).toBeGreaterThan(0);
    expect(budget.band.teamRows).toBeGreaterThan(0);
    const panelRows = ROW_INDEX(frame).filter((line) => line.includes('planner'));
    expect(panelRows).toHaveLength(1);
    expect(stringWidth(panelRows[0]!.trimEnd())).toBe(budget.contentCols);
    // ...which is the frame's own width, i.e. the clock is on the terminal's last column.
    expect(budget.contentCols).toBe(CONTENT_COLS);
  });

  it('gives the rail exactly the rows the roster does not take (I-6)', () => {
    const { budget } = frameOf({
      snapshot: PLAN, itemCount: PLAN.items.length, team: teamSnapshot(), teamRowsNatural: 3,
    });
    expect(budget.band.railRows).toBe(budget.band.bandRows - budget.band.teamRows);
    // I-6a: still mountable, which is what stops D-3's cost from becoming a regression.
    expect(budget.band.railRows).toBeGreaterThanOrEqual(TODO_LIMITS.panelMinRows);
  });

  it('with no roster the band is exactly what it was: railRows === bandRows (AC-10)', () => {
    const { budget } = frameOf({ snapshot: PLAN, itemCount: PLAN.items.length });
    expect(budget.band.teamRows).toBe(0);
    expect(budget.band.railRows).toBe(budget.band.bandRows);
  });
});

describe('native panel band - the TODO rail is a real column', () => {
  it('draws the rail at the band width, with count, index and item text (AC-15)', () => {
    const { frame, budget } = frameOf({ snapshot: PLAN, itemCount: PLAN.items.length });
    expect(budget.band.railRows).toBeGreaterThan(0);
    expect(frame).toContain('TODO');
    expect(frame).toContain('1/5');
    // Text cells are truncated to the rail's column budget (that is the rail's job), so
    // the assertions are on the visible prefix rather than on the whole item text.
    expect(frame).toContain('collect');
    // The running item shows its `activeForm`, which is the whole reason the field
    // exists: "migrate schema" is the plan, "migrating schema" is what is happening.
    expect(frame).toContain('migrating');
  });

  it('rail_spans_the_whole_band (AC-F7): every row above the composer is a rail row', () => {
    const rows = 30;
    const { frame, budget } = frameOf({
      snapshot: PLAN, itemCount: PLAN.items.length, terminalRows: rows,
    });
    // R = 30, draftRows = 1: 29 region rows - 1 header - 3 composer - 1 status = 24.
    expect(budget.liveRows).toBe(29);
    expect(budget.band.bandRows).toBe(24);
    expect(budget.band.railRows).toBe(24);
    // The border is drawn on every one of those rows, starting on the region's top row.
    expect(railRowsDrawn(frame, budget.previewCols, '\u2502')).toBe(24);
    expect(charAt(ROW_INDEX(frame)[0]!, budget.previewCols)).toBe('\u2502');
    // ... and the identity row is a BOTTOM slot, between the composer and the status line
    // (`tui-header-leaks-into-scrollback`): the region's first row belongs to the band.
    expect(ROW_INDEX(frame)[budget.band.bandRows + budget.composerSlotRows])
      .toContain(HEADER_ROW);
  });

  it('marks the items it had to drop when the rail is shorter than the plan (AC-16)', () => {
    // Twelve items in a 7-row rail: `TodoPanel` keeps the running item visible and names
    // the rest, which is the difference between "a list" and "a list you cannot trust".
    const { frame, budget } = frameOf({ snapshot: LONG_PLAN, itemCount: 12, terminalRows: 13 });
    // `remaining = 12 - 1 - 3 - 1 = 7` - the pool, not `panelFullRows` (RV-P2-11).
    expect(budget.band.railRows).toBe(7);
    expect(frame).toMatch(/\+\d+ (more|above)/);
    // The in-progress item is never the one dropped: its `activeForm` is what the rail
    // prints (truncated to the rail's 15 columns, which is the rail's own budget).
    expect(frame).toContain('running s');
  });

  it('renders the rail at `previewCols`, not at `contentCols` (I-5 / AC-15)', () => {
    const { frame, budget } = frameOf({ snapshot: PLAN, itemCount: PLAN.items.length });
    const headerRow = frame.split('\n').find((line) => line.includes('TODO'));
    expect(headerRow).toBeDefined();
    // The rail's own left border sits exactly where the left column ends. Rendering
    // the tail at `contentCols` would push it right by `railCols` and this is the only
    // assertion that can see that.
    expect(columnOf(headerRow!, '\u2502')).toBe(budget.previewCols);
    expect(budget.previewCols + budget.band.railCols).toBe(CONTENT_COLS);
  });

  it('keeps every row inside the content width', () => {
    const { frame } = frameOf({ snapshot: PLAN, itemCount: PLAN.items.length });
    for (const line of frame.split('\n')) {
      expect(stringWidth(line)).toBeLessThanOrEqual(CONTENT_COLS);
    }
  });

  it('does not draw the rail for any of the four hidden reasons (AC-22)', () => {
    // `narrow` is what a terminal below 76 columns gets; `short` needs a band whose row
    // pool is smaller than `panelMinRows + 1`, which only an open popup reaches on an
    // otherwise active frame. `overlay` and the degraded frames are asserted separately
    // below. Each case also asserts the CONTENT is still drawn, because a hidden panel
    // must never mean lost conversation (I-11).
    const cases: ShellOptions[] = [
      { snapshot: PLAN, itemCount: PLAN.items.length, panelEnabled: false },
      { snapshot: null, itemCount: 0 },
      { snapshot: PLAN, itemCount: PLAN.items.length, columns: 70 },
      { snapshot: PLAN, itemCount: PLAN.items.length, terminalRows: 12, popupRows: 5 },
    ];
    for (const options of cases) {
      const { frame, budget } = frameOf(options);
      expect(frame).not.toContain('TODO');
      expect(budget.band.railRows).toBe(0);
      expect(frame).toContain('fallback row');
    }
  });

  it('reports each hidden reason by name, so `/perf` can explain the missing rail', () => {
    const reasons = [
      { options: { snapshot: PLAN, itemCount: PLAN.items.length, panelEnabled: false }, expected: 'disabled' },
      { options: { snapshot: null, itemCount: 0 }, expected: 'empty' },
      { options: { snapshot: PLAN, itemCount: PLAN.items.length, columns: 70 }, expected: 'narrow' },
      { options: { snapshot: PLAN, itemCount: PLAN.items.length, terminalRows: 12, popupRows: 5 }, expected: 'short' },
    ] as { options: ShellOptions; expected: string }[];
    for (const { options, expected } of reasons) {
      expect(budgetFor(options).band.reason).toBe(expected);
    }
  });
});

describe('native panel band - the roster is the real TeamPanel', () => {
  it('shows the header, one row per child and the activity column (AC-17)', () => {
    const team = teamSnapshot();
    const { frame, budget } = frameOf({
      snapshot: PLAN, itemCount: PLAN.items.length, team, teamRowsNatural: 4,
    });
    expect(budget.band.teamRows).toBeGreaterThan(0);
    expect(frame).toContain('team');
    expect(frame).toContain('running');
    expect(frame).toContain('planner');
    expect(frame).toContain('tester');
    // Activity comes from `TeamPanel`'s own budget - proof it is the real component
    // and not a projection that happens to print the labels.
    expect(frame).toContain('read the auth middleware');
    // Both panels in one frame: they are siblings in the band, not alternatives.
    expect(frame).toContain('TODO');
  });

  it('roster_keeps_its_natural_height (AC-F4): the tail takes the rest of the column', () => {
    const { budget } = frameOf({
      itemCount: PLAN.items.length, snapshot: PLAN, team: teamSnapshot(), teamRowsNatural: 4,
      terminalRows: 30,
    });
    expect(budget.band.teamRows).toBe(4);
    expect(budget.band.bandRows).toBe(24);
    // `previewRows === bandRows - teamRows`: the left column is full, not "just enough".
    expect(budget.band.previewRows).toBe(20);
    expect(budget.band.teamRows + budget.band.previewRows).toBe(budget.band.bandRows);
  });

  it('shows the message line and the supervisor badge when they exist (AC-18/AC-19)', () => {
    const team = teamSnapshot({
      lastMessage: { from: 'planner', to: 'lead', subject: 'auth mapped', body: '', at: 1000 },
      runs: [
        subagentRun({ lastIntervention: { action: 'nudge', at: 1000, reasonHead: 'no output' } }),
        subagentRun({ label: 'tester' }),
      ],
    });
    const { frame } = frameOf({ itemCount: 0, team, teamRowsNatural: 5 });
    expect(frame).toContain('auth mapped');
    expect(frame).toContain('supervisor');
  });

  it('an open overlay shows only the overlay (AC-23)', () => {
    const { frame, budget } = frameOf({
      snapshot: PLAN, itemCount: PLAN.items.length, team: teamSnapshot(), overlayOpen: true,
    });
    expect(budget.band.reason).toBe('overlay');
    expect(frame).not.toContain('TODO');
    expect(frame).not.toContain('planner');
  });
});

describe('native panel band - the tail is the real entry view', () => {
  it('suppresses the LIVE team entry: the roster is the only live surface (AC-20)', () => {
    // REWRITTEN ON PURPOSE (tui-subagent-double-roster A-2). This test used to assert
    // that a running `team` entry is drawn as a `TeamCard` in the band's tail - which
    // is exactly the duplicated block the reporter saw, pinned as a feature. While the
    // dispatch is ACTIVE the roster owns the frame, so nothing of the entry is drawn.
    const { frame } = frameOf({
      itemCount: 0, entries: [teamEntry([subagentRun(), subagentRun({ label: 'tester' })])],
    });
    expect(frame).not.toContain('subagents');
    expect(frame).not.toContain('planner');
    expect(budgetFor({
      itemCount: 0, entries: [teamEntry([subagentRun(), subagentRun({ label: 'tester' })])],
    }).band.previewRows).toBeGreaterThan(0);
  });

  it('renders the SETTLED team entry once, with turns and the gutter (AC-20)', () => {
    const runs = [subagentRun({ phase: 'done', endedAt: 4_000 }), subagentRun({ label: 'tester', phase: 'done', endedAt: 4_000 })];
    const settled: Entry = { ...teamEntry(runs), active: false, durationMs: 3_000 } as Entry;
    const { frame } = frameOf({ itemCount: 0, entries: [settled] });
    expect(frame).toContain('subagents');
    expect(frame).toContain('3 turns');
    // `EntryFrame`'s continuation glyph: the plain-text projection had no gutter, so
    // its presence is what separates "real component" from "text that looks similar".
    expect(frame).toContain('\u2502');
  });

  it('renders a running tool entry as a ToolCard, not as one plain row (AC-21)', () => {
    const { frame } = frameOf({ itemCount: 0, entries: [toolEntry()] });
    // The card prints the tool name, the call's arguments and the animated status row;
    // the old projection printed exactly one line, `> bash`.
    expect(frame).toContain('bash');
    expect(frame).toContain('npm test');
    expect(frame).toContain('running');
  });

  it('tail_starts_on_the_top_row (AC-F6): a card that fits is drawn from row 0', () => {
    const rows = 30;
    const { frame, budget } = frameOf({
      itemCount: 0, entries: [toolEntry()], terminalRows: rows,
    });
    const lines = ROW_INDEX(frame);
    // The band now starts on row 0: the identity row left the top of the region
    // (`tui-header-leaks-into-scrollback`), so nothing sits between it and the band.
    const bandBottom = budget.band.bandRows;
    // band rows are [0, 23]; the composer slot starts on line 24.
    expect(bandBottom).toBe(24);
    // PLAN A-PRIME: a card that fits hugs the TOP, not the composer, so the user reads
    // it downwards the way a terminal writes instead of finding it at the bottom of a
    // blank screen (`tail-anchor.ts`).
    expect(lines[0]).toContain('bash');
    // ... and the rows the card does not need stay BELOW it, between the tail and the
    // composer, where they read as "nothing has been written here yet".
    expect(lines[bandBottom - 1]).toBe('');
    expect(lines[bandBottom]).toBe('');
  });

  it('an overflowing tail still ends on the newest row (hard line 1)', () => {
    // Ten eleven-row cards cannot fit a 24-row pool, so the anchor falls back to
    // `flex-end` - and the rows it clips must be the OLDEST ones: a streaming entry can
    // never be printed into the scrollback, so the newest text is the one that has to
    // stay visible (`tail-anchor.ts`, analysis §9.5 R1).
    const entries = Array.from({ length: SCROLLBACK_LIMITS.liveTailMaxEntries }, (_, index) =>
      toolEntry({
        id: `t-${index}`, toolCallId: `c-${index}`, label: `step ${index}`,
        argsRaw: `{"command":"step-${index}"}`,
        live: Array.from({ length: 8 }, (_, row) => `row ${row} of step ${index}`),
      }));
    const { frame, budget } = frameOf({ itemCount: 0, entries, terminalRows: 30 });
    const lines = ROW_INDEX(frame);
    const bandBottom = budget.band.bandRows;
    // The newest card is on screen and the oldest one has been clipped away ...
    expect(frame).toContain('step-9');
    expect(frame).not.toContain('step-0');
    // ... and its last row is the band's last row, the promise `canvas.ts` makes about
    // the live tail rather than a row floating above a blank strip.
    expect(lines[bandBottom - 1]).not.toBe('');
  });

  it('mounts at most liveTailMaxEntries component instances (AC-33)', () => {
    const entries = Array.from({ length: SCROLLBACK_LIMITS.liveTailMaxEntries + 2 },
      (_, index) => toolEntry({
        id: `t-${index}`, toolCallId: `c-${index}`, label: `step ${index}`,
        argsRaw: `{"command":"step-${index}"}`,
      }));
    const { frame } = frameOf({ itemCount: 0, entries, terminalRows: 40 });
    // The newest entry is mounted and the oldest is not: the tail shows the end of the
    // conversation, never the beginning of it. (`ToolCard` prints the call's arguments,
    // which is where the label lands.)
    const newest = SCROLLBACK_LIMITS.liveTailMaxEntries + 1;
    expect(frame).toContain(`step-${newest}`);
    expect(frame).not.toContain('step-0');
    expect(frame).not.toContain('step-1"');
  });
});

describe('native panel band - the empty-session opener (AC-F15)', () => {
  it('opener_starts_at_the_top_row: the card hugs the top of the band, not the composer', () => {
    const { frame, budget } = frameOf({ itemCount: 0, opener: true, terminalRows: 30 });
    const lines = ROW_INDEX(frame);
    // row 0 is the band's first row and the card's first row is the same one - the upper
    // half of the screen is NOT blank, which was the original defect (RV-P0-1).
    for (let row = 0; row <= 7; row += 1) {
      expect(lines[row], `row ${row}`).toContain(`opener row ${row}`);
    }
    expect(budget.band.previewRows).toBe(24);
  });

  it('tail_is_anchored_like_the_opener: a short conversation also starts at the top', () => {
    const { frame } = frameOf({
      itemCount: 0, entries: [toolEntry()], terminalRows: 30,
    });
    const lines = ROW_INDEX(frame);
    expect(frame).not.toContain('opener row');
    // The two occupants of this box now agree: the tail hugs the band's first row exactly
    // like the empty-session card did (`tail-anchor.ts`, plan A-prime). This replaced the
    // old assertion that the band's first row was EMPTY - that blank uppermost row WAS the
    // reported defect, pinned as a promise.
    expect(lines[0]).toContain('bash');
    expect(lines[1]).not.toBe('');
  });
});

describe('native panel band - degraded frames still report a band', () => {
  it('an inactive terminal still returns a band value for /perf (AC-23)', () => {
    const budget = budgetFor({ itemCount: PLAN.items.length, terminalRows: 8 });
    expect(budget.inactive).toBe(true);
    expect(budget.band).toBeDefined();
    expect(budget.headerRows).toBe(0);
    expect(budget.band.railRows).toBe(0);
    expect(budget.band.previewCols).toBe(budget.contentCols);
  });

  it('a forced-inactive frame (the tall-frame guard) reports the same shape', () => {
    const budget = budgetFor({
      itemCount: PLAN.items.length, terminalRows: 24, forceInactive: true,
    });
    expect(budget.inactive).toBe(true);
    expect(budget.headerRows).toBe(0);
    expect(budget.band.reason).toBe('short');
    expect(budget.band.previewCols).toBe(budget.contentCols);
  });

  it('the identity slot is only drawn when the budget grants it', () => {
    const { frame, budget } = frameOf({ itemCount: 0, noHeader: true, terminalRows: 30 });
    // `headerRows` is 1 here (a healthy frame), so an empty node still occupies the slot -
    // between the composer and the status line - and the band still starts on row 0: the
    // row identity the shell must never violate (I-F4).
    const lines = ROW_INDEX(frame);
    expect(frame).not.toContain(HEADER_ROW);
    expect(lines).toHaveLength(29);
    expect(budget.band.bandRows + budget.composerSlotRows).toBe(27);
    expect(lines[27]).toBe('');
  });
});
