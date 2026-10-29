/**
 * Panel row geometry and cell arithmetic (tui-subagent-panel AC-3 / AC-4 / AC-29).
 *
 * WHY A PURE TEST FILE FOR GEOMETRY. AC-1 and AC-6 measure a RENDERED frame, and a
 * frame cannot distinguish "the arithmetic clamped it" from "Ink truncated it" - which
 * is exactly the confusion that let the previous fixed-width column look correct at 100
 * columns and break at 80. These assertions are on the function, over its whole input
 * space, and the frame tests next door prove the function is actually used.
 *
 * `string-width` measures the frames, so a CJK description is counted in COLUMNS rather
 * than code units - the same unit the terminal uses, and the one `padEnd` cannot see.
 */

import { describe, expect, it } from 'vitest';
import stringWidth from 'string-width';
import { pickGlyphs } from '../ui/glyphs.js';
import {
  activityBudget,
  teamRowCells,
  teamRowGeometry,
  TEAM_CLOCK_CELLS,
  TEAM_GAP_CELLS,
  TEAM_LABEL_CELLS,
  TEAM_MIN_DESCRIPTION_CELLS,
} from '../ui/layout/team-row.js';
import { alignRightCells, fitCells, padCells, wrapCells } from '../ui/layout/cells.js';
import { TEAM_LIMITS } from '../model/team/limits.js';
import type { SubagentRun } from '../model/team/types.js';

/** The two glyph tiers, taken from the real table rather than a fixture. */
const UNICODE_GLYPHS_FOR_TESTS = pickGlyphs({ colorLevel: 3, unicode: true });
const ASCII_GLYPHS_FOR_TESTS = pickGlyphs({ colorLevel: 0, unicode: false });

const COLUMNS = [40, 56, 72, 80, 100, 120, 200] as const;
const RUNS = 10;

function run(overrides: Partial<SubagentRun> = {}): SubagentRun {
  return {
    label: 'a1',
    description: 'read the auth middleware',
    phase: 'tool',
    startedAt: 1000,
    turns: 3,
    toolCalls: 5,
    lastTool: 'grep',
    activityArgs: { pattern: 'retry policy' },
    usage: { inputTokens: 12_400, outputTokens: 3_100 },
    filesTouched: [],
    messagesSent: 1,
    ...overrides,
  };
}

/** The four row shapes AC-3 names, including the one with no clock at all. */
const SHAPES: SubagentRun[] = [
  run({ description: 'a description that is long enough to need truncation '.repeat(3) }),
  run({ phase: 'thinking', activity: 'streaming prose '.repeat(9) }),
  run({ phase: 'failed', error: 'boom' }),
  run({ phase: 'queued', startedAt: undefined }),
];

describe('teamRowGeometry (I-3 / AC-3 / AC-4)', () => {
  it('every cell is non-negative and the five sum inside `cols`, for cols = 0..400', () => {
    for (const glyphs of [UNICODE_GLYPHS_FOR_TESTS, ASCII_GLYPHS_FOR_TESTS]) {
      for (let cols = 0; cols <= 400; cols += 1) {
        const g = teamRowGeometry(cols, glyphs);
        for (const [name, value] of Object.entries(g)) {
          expect(value, `${name} @${cols}`).toBeGreaterThanOrEqual(0);
          expect(Number.isInteger(value), `${name} @${cols}`).toBe(true);
        }
        const sum = g.marker + g.label + g.gap + g.activity + g.clock;
        expect(sum, `sum @${cols}`).toBeLessThanOrEqual(cols);
      }
    }
  });

  it('AC-4: the ladder — activity drops below 56 columns, description never goes negative', () => {
    const unicode = UNICODE_GLYPHS_FOR_TESTS;
    expect(teamRowGeometry(TEAM_LIMITS.activityDropCols - 1, unicode).activity).toBe(0);
    expect(teamRowGeometry(TEAM_LIMITS.activityDropCols, unicode).activity)
      .toBe(TEAM_LIMITS.activityMinChars);
    // Below `marker + label + clock` the label gives way; below `marker + 3 + clock` the
    // clock does. Neither path may produce a negative width.
    for (const cols of [21, 20, 19, 18, 12, 6, 3, 1, 0]) {
      const g = teamRowGeometry(cols, unicode);
      expect(g.marker + g.label + g.gap + g.activity + g.clock).toBeLessThanOrEqual(cols);
    }
  });

  it('an invalid width is zero, not NaN', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -12]) {
      const g = teamRowGeometry(value, UNICODE_GLYPHS_FOR_TESTS);
      expect(g.marker + g.label + g.gap + g.activity + g.clock).toBe(0);
    }
  });
});

describe('the width matrix (§4.2.4 / appendix A / AC-29)', () => {
  const UNICODE_MATRIX: [number, number, number, number][] = [
    // cols, activity, clock, description
    [200, 64, 8, 115],
    [120, 43, 8, 56],
    [100, 33, 8, 46],
    [80, 23, 8, 36],
    [72, 19, 8, 32],
    [56, 12, 8, 23],
    [40, 0, 8, 19],
    [30, 0, 8, 9],
    [21, 0, 8, 0],
    [20, 0, 8, 1],
  ];

  it.each(UNICODE_MATRIX)('unicode %i columns', (cols, activity, clock, description) => {
    const g = teamRowGeometry(cols, UNICODE_GLYPHS_FOR_TESTS);
    expect(g).toMatchObject({ marker: 3, label: 8, activity, clock });
    expect(cols - (g.marker + g.label + g.gap + g.activity + g.clock)).toBe(description);
  });

  const ASCII_MATRIX: [number, number, number][] = [
    [200, 64, 112],
    [120, 42, 54],
    [100, 32, 44],
    [80, 22, 34],
    [56, 12, 20],
    [40, 0, 16],
  ];

  it.each(ASCII_MATRIX)('ascii %i columns', (cols, activity, description) => {
    const g = teamRowGeometry(cols, ASCII_GLYPHS_FOR_TESTS);
    expect(g).toMatchObject({ marker: 6, label: 8, activity, clock: 8 });
    expect(cols - (g.marker + g.label + g.gap + g.activity + g.clock)).toBe(description);
  });
});

describe('teamRowCells (AC-3)', () => {
  it('renders every shape inside its cells at every width, both tiers', () => {
    for (const glyphs of [UNICODE_GLYPHS_FOR_TESTS, ASCII_GLYPHS_FOR_TESTS]) {
      for (const cols of COLUMNS) {
        for (let count = 1; count <= RUNS; count += 1) {
          for (const shape of SHAPES) {
            const cells = teamRowCells({ ...shape, label: `a${count}` }, cols, 30_000, glyphs);
            const g = teamRowGeometry(cols, glyphs);
            // The marker cell is padded to the tier's widest marker, so it always
            // measures exactly `g.marker - 2` (one leading and one trailing space).
            expect(stringWidth(cells.label)).toBe(TEAM_LABEL_CELLS);
            expect(stringWidth(cells.marker)).toBe(g.marker - 2);
            expect(cells.description).not.toContain('\n');
            // The activity cell is clamped by the SAME budget the geometry uses.
            expect(stringWidth(cells.activity)).toBeLessThanOrEqual(Math.max(g.activity, 0));
            expect(stringWidth(cells.clock)).toBeLessThanOrEqual(TEAM_CLOCK_CELLS);
          }
        }
      }
    }
  });

  it('a queued child has no clock: `0ms` would be a claim it started', () => {
    const cells = teamRowCells(run({ phase: 'queued', startedAt: undefined }), 100, 5000,
      UNICODE_GLYPHS_FOR_TESTS);
    expect(cells.clock).toBe('');
  });

  it('the clock is elapsed, measured from `startedAt`', () => {
    const cells = teamRowCells(run({ startedAt: 1000 }), 100, 23_100, UNICODE_GLYPHS_FOR_TESTS);
    expect(cells.clock).toBe('22.1s');
  });
});

describe('cells.ts arithmetic', () => {
  it('fitCells never exceeds its budget and marks the cut', () => {
    expect(fitCells('abcdefghij', 5)).toBe('ab...');
    expect(stringWidth(fitCells('abcdefghij', 5))).toBe(5);
    // A CJK string is measured in columns, not code units: 4 characters is 8 columns.
    expect(stringWidth(fitCells('描述文字说明', 5))).toBeLessThanOrEqual(5);
    expect(fitCells('abc', 0)).toBe('');
  });

  it('padCells pads to exactly the requested width, in columns', () => {
    expect(padCells('ab', 5)).toBe('ab   ');
    expect(padCells('描述', 5)).toBe('描述 ');
    expect(stringWidth(padCells('描述', 5))).toBe(5);
    expect(padCells('abcdef', 3)).toBe('abcdef');
  });

  it('alignRightCells always measures exactly `cells`', () => {
    for (const cells of [0, 1, 5, 8]) {
      expect(stringWidth(alignRightCells('22.1s', cells))).toBe(cells);
    }
  });

  it('wrapCells folds on display width and announces what it dropped', () => {
    const wrapped = wrapCells('one two three four five six seven eight nine ten eleven', 20, 2);
    expect(wrapped.lines).toHaveLength(2);
    expect(wrapped.dropped).toBeGreaterThan(0);
    for (const line of wrapped.lines) expect(stringWidth(line)).toBeLessThanOrEqual(20);
    // The truncation is ANNOUNCED on the last line that fits.
    expect(wrapped.lines[1]).toContain('(+');
    // A single token wider than the column is hard-cut rather than dropped.
    const long = wrapCells('x'.repeat(40), 10, 3);
    expect(long.lines[0]).toHaveLength(10);
  });
});
