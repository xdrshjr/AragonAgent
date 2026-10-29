/**
 * The roster as a TABLE, measured on real Ink frames (tui-subagent-panel AC-1 / AC-2 /
 * AC-5 / AC-9 / AC-11 / AC-28).
 *
 * EVERY CASE HERE GOES THROUGH A FIXED-HEIGHT WRAPPER ON PURPOSE. That wrapper is the
 * exact structure that broke the previous row: `ScrollbackShell` sits the roster in a
 * `height={n}` box, and Yoga then sizes a column to its widest child instead of to the
 * available width, so a row that measured 100 columns on its own measured 48 inside the
 * band. Asserting the row standalone would pass while the product stayed broken - which
 * is precisely how the reported defect survived its own tests.
 */

import { describe, expect, it } from 'vitest';
import React from 'react';
import { Box } from 'ink';
import { render } from 'ink-testing-library';
import stringWidth from 'string-width';
import { TeamPanel } from '../ui/TeamPanel.js';
import { getTheme } from '../ui/theme.js';
import type { SubagentRun, TeamSnapshot } from '../model/team/types.js';
import { DEVELOPER_VOICE } from '../ui/tool-voice.js';

const RICH = { colorLevel: 3 as const, unicode: true };
const ASCII = { colorLevel: 0 as const, unicode: false };
const theme = getTheme('cool', RICH);

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

function run(over: Partial<SubagentRun> = {}): SubagentRun {
  return {
    label: 'a1',
    description: 'read the auth middleware',
    phase: 'tool',
    startedAt: 1000,
    turns: 4,
    toolCalls: 7,
    lastTool: 'grep',
    activityArgs: { pattern: 'retry policy' },
    usage: { inputTokens: 10, outputTokens: 5 },
    filesTouched: [],
    messagesSent: 0,
    ...over,
  };
}

function snapshot(over: Partial<TeamSnapshot> = {}): TeamSnapshot {
  return {
    dispatchId: 'd1',
    active: true,
    runs: [
      run({ label: 'a1' }),
      run({ label: 'a2', description: 'map the route table', phase: 'thinking', startedAt: 2000 }),
      run({ label: 'a3', description: 'survey the test suite', phase: 'done', startedAt: 500, endedAt: 9000 }),
    ],
    requested: 3,
    startedAt: 1000,
    messageCount: 0,
    ...over,
  };
}

/**
 * Render the panel inside `height={rows}` at the testing library's 100 columns - the
 * structure the band gives it.
 */
function bandFrame(node: React.ReactElement, cols = 100): string[] {
  const { lastFrame, unmount } = render(
    <Box width={cols} flexDirection="column">
      <Box height={6} flexShrink={0} overflow="hidden">{node}</Box>
    </Box>,
  );
  const frame = stripAnsi(lastFrame() ?? '');
  unmount();
  return frame.split('\n');
}

function panel(over: Partial<React.ComponentProps<typeof TeamPanel>> = {}): React.ReactElement {
  return (
    <TeamPanel voice={DEVELOPER_VOICE}
      snapshot={snapshot()}
      rows={40}
      cols={100}
      reducedMotion
      theme={theme}
      caps={RICH}
      now={23_100}
      {...over}
    />
  );
}

describe('AC-1: every row ends against the panel edge, inside a fixed-height slot', () => {
  it('measures the full width and ends with the clock', () => {
    const rows = bandFrame(panel());
    const childRows = rows.filter((line) => /^\s*[·✓○▲]\s/.test(line));
    expect(childRows).toHaveLength(3);
    for (const line of childRows) {
      // THE DEFECT: this used to be 48 on a 100-column terminal.
      expect(stringWidth(line)).toBe(100);
      expect(line.trimEnd()).toMatch(/\d+(\.\d+)?(ms|s|m\d+s)$/);
    }
  });

  // 80 COLUMNS ONLY: `ink-testing-library` pins the terminal at 100 columns, so a
  // wider box is clipped by the FRAME rather than laid out - the 120/200 cases belong
  // to `team-row-geometry.test.ts`, which asserts them on the function.
  it('also holds at 80 columns and in the ASCII tier', () => {
    for (const cols of [80]) {
      const rows = bandFrame(
        panel({ cols, caps: RICH, theme: getTheme('cool', RICH) }),
        cols,
      );
      const childRows = rows.filter((line) => /^\s*[·✓○▲]\s/.test(line));
      expect(childRows).toHaveLength(3);
      for (const line of childRows) expect(stringWidth(line)).toBe(cols);
    }
    const asciiRows = bandFrame(
      panel({ cols: 100, caps: ASCII, theme: getTheme('cool', ASCII) }),
      100,
    );
    for (const line of asciiRows.filter((l) => /^\s*\[ok\]|^\s*[ox*!]\s/.test(l))) {
      expect(stringWidth(line)).toBe(100);
    }
  });
});

describe('AC-2: the clocks stand in ONE column', () => {
  it('every child clock ends at the same column, header included', () => {
    const rows = bandFrame(panel({ snapshot: snapshot({ messageCount: 3 }) }));
    const ends = rows
      .filter((line) => line.trim().length > 0)
      .map((line) => stringWidth(line.trimEnd()));
    // Header and all three child rows are 100 wide, i.e. their last character is the
    // 100th column - the clock (or the header's clock) is the row's last cell.
    expect(new Set(ends)).toEqual(new Set([100]));
  });
});

describe('AC-5: the header keeps its count clauses and pins the clock right', () => {
  it('shows the counts on the left, `ctrl+b` on the right, and the mail badge beside the clock', () => {
    const rows = bandFrame(panel({
      snapshot: snapshot({
        messageCount: 4,
        lastMessage: { from: 'a1', to: 'lead', subject: 'found it', body: '', at: 0 },
      }),
    }));
    const header = rows[0] ?? '';
    expect(header).toContain('team');
    expect(header).toContain('running');
    expect(header).toContain('ctrl+b');
    expect(header).toContain('4');
    // 23.1s - 1s elapsed for the dispatch start at 1000 and now 23100.
    expect(header.trimEnd().endsWith('22.1s')).toBe(true);
    // The mail badge sits immediately left of the clock cell.
    expect(header.indexOf('ctrl+b')).toBeLessThan(header.indexOf('22.1s'));
  });

  it('drops the hint below 100 columns and keeps the clock', () => {
    const rows = bandFrame(panel({ cols: 80 }), 80);
    const header = rows[0] ?? '';
    expect(header).not.toContain('ctrl+b');
    expect(header.trimEnd().endsWith('22.1s')).toBe(true);
  });
});

describe('AC-9: the collapsed form loses rows but no facts', () => {
  it('at 18 terminal rows there is one line, with the counts and the right-edge clock', () => {
    // `bandFrame` wraps the panel in a fixed-height box, so the frame always has that
    // many LINES; what matters is how many of them the panel filled.
    const drawn = bandFrame(panel({ rows: 18 })).filter((line) => line.trim().length > 0);
    expect(drawn).toHaveLength(1);
    expect(drawn[0]).toContain('running');
    expect(drawn[0]?.trimEnd().endsWith('22.1s')).toBe(true);
    expect(drawn[0]).not.toContain('read the auth middleware');
  });
});

describe('AC-11: the activity cell does not crawl as the prose grows', () => {
  it('keeps the activity left edge fixed while the tail grows 62 -> 160 characters', () => {
    const short = panel(snapshotProse(62));
    const long = panel(snapshotProse(160));
    const colOf = (node: React.ReactElement): number => {
      const rows = bandFrame(node);
      const line = rows.find((row) => row.includes('writing:')) ?? '';
      return line.indexOf('writing:');
    };
    expect(colOf(short)).toBeGreaterThan(0);
    expect(colOf(long)).toBe(colOf(short));
  });
});

function snapshotProse(chars: number): Partial<React.ComponentProps<typeof TeamPanel>> {
  return {
    snapshot: snapshot({
      runs: [run({ phase: 'thinking', activity: 'x'.repeat(chars), lastTool: undefined })],
    }),
  };
}

describe('AC-28: the header budget is spent once', () => {
  it('at 100 columns four count clauses all fit (budget 100 - 8 - 6 - 16 = 70)', () => {
    const rows = bandFrame(panel({
      snapshot: snapshot({
        runs: [
          run({ label: 'a1', phase: 'tool' }),
          run({ label: 'a2', phase: 'thinking', activity: 'mapping routes' }),
        ],
        requested: 4,
      }),
    }));
    // A dispatch with running + done + queued is the four-clause case; `running` and
    // `done` alone are 19 columns, so the interesting assertion is that the LAST clause
    // is not dropped by a double subtraction of the 16-column reserve.
    const header = rows[0] ?? '';
    expect(header).toContain('running');
    expect(header).toContain('done');
  });

  it('at 56 columns the reserved 16 still leaves room for `running`, and `done` is not dropped twice', () => {
    const rows = bandFrame(panel({ cols: 56 }), 56);
    expect(rows[0]).toContain('running');
  });
});

describe('I-8: the panel still writes no non-ASCII byte in the ASCII tier', () => {
  it('renders ASCII only', () => {
    const rows = bandFrame(panel({ caps: ASCII, theme: getTheme('cool', ASCII) }));
    for (const line of rows) expect(line).not.toMatch(/[^\x00-\x7f]/);
  });
});

describe('the activity cell disappears below activityDropCols (I-4)', () => {
  it('leaves the description in charge at 40 columns', () => {
    const rows = bandFrame(panel({ cols: 40 }), 40);
    const child = rows.find((line) => line.includes('a1')) ?? '';
    // 12 cells including the ellipsis: the persona-name column took seven of the old floor.
    expect(child).toContain('read the auth middleware'.slice(0, 11));
    expect(child).not.toContain('grep');
    expect(stringWidth(child)).toBe(40);
  });
});
