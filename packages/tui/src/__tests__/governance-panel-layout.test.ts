import { describe, expect, it } from 'vitest';
import {
  buildGovernancePanelLayout,
  maxRosterRows,
  segmentsCells,
  selectTier,
  type GovernancePanelInput,
  type GovernancePanelLayout,
} from '../ui/layout/governance-panel.js';
import { columnPlan, columnsWidth, markerCells } from '../ui/layout/governance-roster.js';
import { pickGlyphs } from '../ui/glyphs.js';
import { cellWidth } from '../ui/layout/cells.js';
import {
  DELTA_EMPHASIS_MS,
  deltaCell,
  gaugeFilledCells,
  govChildStatus,
  scoreText,
  sortRoster,
  statusTone,
  toneColor,
  trackEliminated,
} from '../ui/governance-status.js';
import { statusColor, type ChildStatus } from '../ui/team-status.js';
import { getTheme } from '../ui/theme.js';
import {
  NOW,
  manyAgents,
  pipeline,
  rosterRow,
  sketchRoster,
  snapshot,
} from '../testing/governance-fixtures.js';

const UNICODE = pickGlyphs({ colorLevel: 3, unicode: true });
const ASCII = pickGlyphs({ colorLevel: 0, unicode: false });

const COLS = [40, 60, 80, 100, 140] as const;
const ROWS = [16, 20, 26, 40] as const;

function plan(
  cols: number,
  rows: number,
  over: Partial<GovernancePanelInput> = {},
): GovernancePanelLayout {
  return buildGovernancePanelLayout({
    cols, rows, snapshot: snapshot(), glyphs: UNICODE, reducedMotion: false, now: NOW, ...over,
  });
}

const flat = (segments: readonly { text: string }[]): string => segments.map((s) => s.text).join('');

describe('selectTier (spec 10.3 thresholds)', () => {
  it('maps the documented ranges', () => {
    expect(selectTier(100, 26)).toBe('full');
    expect(selectTier(140, 40)).toBe('full');
    expect(selectTier(99, 26)).toBe('standard');
    expect(selectTier(80, 40)).toBe('standard');
    expect(selectTier(79, 40)).toBe('compact');
    expect(selectTier(60, 40)).toBe('compact');
    expect(selectTier(140, 25)).toBe('compact');
    expect(selectTier(140, 20)).toBe('compact');
    expect(selectTier(59, 40)).toBe('minimal');
    expect(selectTier(140, 19)).toBe('minimal');
  });
});

describe('maxRosterRows', () => {
  it('is clamp(rows - 16, 2, 10)', () => {
    expect([16, 18, 20, 26, 40, 100].map(maxRosterRows)).toEqual([2, 2, 4, 10, 10, 10]);
  });
});

describe('the panel matrix: 40-140 cols x 16-40 rows', () => {
  for (const cols of COLS) {
    for (const rows of ROWS) {
      it(`${cols}x${rows}: height inside the budget and every width inside the terminal`, () => {
        const layout = plan(cols, rows);
        expect(layout.height).toBeGreaterThan(0);
        expect(layout.height).toBeLessThanOrEqual(Math.max(1, rows - 8));
        expect(layout.cols).toBe(cols);
        if (layout.columns.length > 0) {
          expect(columnsWidth(layout.columns)).toBeLessThanOrEqual(layout.innerCols);
        }
        for (const line of [layout.header, layout.pipeline, ...layout.ticker]) {
          if (line === null) continue;
          expect(segmentsCells(line.left)).toBeLessThanOrEqual(layout.innerCols);
        }
        for (const row of layout.rosterRows) {
          for (const cell of row.cells) {
            expect(segmentsCells(cell.segments)).toBeLessThanOrEqual(cell.width);
          }
        }
      });
    }
  }

  it('reports a height equal to the rows it actually describes', () => {
    for (const cols of COLS) {
      for (const rows of ROWS) {
        const l = plan(cols, rows);
        const counted = (l.header ? 1 : 0) + (l.pipeline ? 1 : 0) + (l.ruleCells > 0 ? 2 : 0)
          + l.rosterRows.length + (l.overflow ? 1 : 0) + l.ticker.length;
        expect(l.height, `${cols}x${rows}`).toBe(counted);
      }
    }
  });
});

describe('tier content', () => {
  it('full shows the step strip, the roster with a gauge and the ledger ticker', () => {
    const l = plan(140, 40);
    expect(l.tier).toBe('full');
    expect(flat(l.header!.left)).toContain('GOVERN');
    expect(flat(l.header!.left)).toContain('phase 2/3');
    expect(flat(l.header!.left)).toContain('REVIEW');
    expect(flat(l.header!.right)).toContain('health 88');
    expect(flat(l.header!.right)).toContain('412.0k tok');
    expect(flat(l.header!.right)).toContain('$0.4200');
    expect(flat(l.pipeline!.left)).toContain('INTAKE');
    expect(l.columns.some((c) => c.key === 'activity')).toBe(true);
    expect(l.ticker).toHaveLength(1);
    expect(flat(l.ticker[0]!.left)).toContain('dev1 +15P D1 review pass');
    expect(l.ruleCells).toBe(l.innerCols);
  });

  it('puts the newest ledger entry first whatever order the producer used', () => {
    const l = plan(140, 40);
    const text = flat(l.ticker[0]!.left);
    expect(text.indexOf('dev1 +15P')).toBeLessThan(text.indexOf('dev2 -20'));
    expect(text.indexOf('dev2 -20')).toBeLessThan(text.indexOf('rev2 +10'));
  });

  it('standard drops the activity column and the cost figure', () => {
    const l = plan(90, 40);
    expect(l.tier).toBe('standard');
    expect(l.columns.some((c) => c.key === 'activity')).toBe(false);
    expect(flat(l.header!.right)).not.toContain('$');
    expect(l.ticker).toHaveLength(1);
  });

  it('compact has no step strip, no ticker and no gauge, only the stage name', () => {
    const l = plan(70, 40);
    expect(l.tier).toBe('compact');
    expect(l.pipeline).toBeNull();
    expect(l.ticker).toEqual([]);
    expect(l.columns.map((c) => c.key)).toEqual(['marker', 'id', 'state', 'score', 'wp', 'delta']);
    expect(flat(l.header!.left)).toContain('REVIEW');
  });

  it('minimal is exactly one row naming phase, stage, workers, health and the board', () => {
    const l = plan(100, 18);
    expect(l.tier).toBe('minimal');
    expect(l.height).toBe(1);
    expect(flat(l.header!.left)).toBe('GOVERN p2/3 REVIEW · 2 working · health 88 · /gov board');
  });

  it('minimal sheds clauses from the right as the terminal narrows', () => {
    const at = (cols: number): string => flat(plan(cols, 18, { glyphs: ASCII }).header!.left);
    expect(at(56)).toBe('GOVERN p2/3 REVIEW - 2 working - health 88 - /gov board');
    expect(at(46)).toBe('GOVERN p2/3 REVIEW - 2 working - health 88');
    expect(at(33)).toBe('GOVERN p2/3 REVIEW - 2 working');
    expect(at(24)).toBe('GOVERN p2/3 REVIEW');
    expect(at(14)).toBe('GOVERN p2/3');
    expect(at(8)).toBe('GOVERN');
  });

  it('draws nothing for a missing snapshot or a closed run', () => {
    expect(plan(120, 40, { snapshot: null }).height).toBe(0);
    expect(plan(120, 40, { snapshot: snapshot({ status: 'closed' }) }).height).toBe(0);
    expect(plan(120, 40, { snapshot: snapshot({ status: 'abandoned' }) }).height).toBe(0);
  });

  it('shows the run strip (header + steps) between stages', () => {
    const l = plan(120, 40, { mode: 'run-strip' });
    expect(l.height).toBe(2);
    expect(l.rosterRows).toEqual([]);
    expect(l.pipeline).not.toBeNull();
  });

  it('names a paused or escalated run in the header', () => {
    expect(flat(plan(120, 40, { snapshot: snapshot({ status: 'paused' }) }).header!.left))
      .toContain('paused');
    expect(flat(plan(120, 40, { snapshot: snapshot({ status: 'escalated' }) }).header!.left))
      .toContain('escalated');
  });

  it('puts an alert on the ticker row in place of the ledger', () => {
    const l = plan(120, 40, { snapshot: snapshot({ alerts: ['BUDGET WARNING: 82% used'] }) });
    expect(flat(l.ticker[0]!.left)).toContain('BUDGET WARNING');
    expect(l.ticker[0]!.left[0]!.tone).toBe('warn');
  });

  it('omits the cost when the model has no known price (never invents $0.00)', () => {
    const l = plan(140, 40, {
      snapshot: snapshot({ usage: { inputTokens: 1, outputTokens: 1, costUsd: null } }),
    });
    expect(flat(l.header!.right)).not.toContain('$');
  });
});

describe('the step strip', () => {
  it('marks done steps, the active step and pending steps', () => {
    const l = plan(140, 40);
    const text = flat(l.pipeline!.left);
    expect(text).toContain('INTAKE ✓');
    expect(text).toContain('DEV ✓');
    expect(text).toContain('▸REVIEW');
    expect(text).toContain('INTEGRATE');
    expect(flat(l.pipeline!.right)).toBe('rework 1/3 (ui-form)');
  });

  it('keeps the current step visible by dropping the oldest steps first', () => {
    const l = plan(80, 40, { snapshot: snapshot({ pipeline: pipeline('integrate') }) });
    expect(segmentsCells(l.pipeline!.left) + l.pipeline!.rightCells).toBeLessThanOrEqual(l.innerCols);
    expect(flat(l.pipeline!.left)).toContain('▸INTEGRATE');
  });

  it('degrades to ASCII glyphs without a Unicode terminal', () => {
    const text = flat(plan(140, 40, { glyphs: ASCII }).pipeline!.left);
    expect(text).toContain('INTAKE *');
    expect(text).toContain('>REVIEW');
    expect(text).not.toMatch(/[^\x20-\x7e]/);
  });
});

describe('roster rows', () => {
  it('sorts DEV -> REV -> TEST -> INSP with active members before replaced ones', () => {
    const roster = [
      rosterRow({ id: 'insp', role: 'INSP', confirmed: null, label: 'NOT_SCORED' }),
      rosterRow({ id: 'tst1', role: 'TEST' }),
      rosterRow({ id: 'dev2', state: 'eliminated', replacedBy: 'dev2-r1' }),
      rosterRow({ id: 'rev1', role: 'REV' }),
      rosterRow({ id: 'dev2-r1', generation: 1 }),
      rosterRow({ id: 'dev1' }),
    ];
    expect(sortRoster(roster).map((r) => r.id)).toEqual([
      'dev1', 'dev2-r1', 'rev1', 'tst1', 'insp', 'dev2',
    ]);
  });

  it('caps the roster and ends with `+N more (/gov board)`', () => {
    const l = plan(140, 26, { snapshot: snapshot({ roster: manyAgents(14) }) });
    expect(l.rosterRows).toHaveLength(9);
    expect(l.overflow).toBe('+5 more (/gov board)');
  });

  it('never exceeds maxRosterRows rows including the overflow line', () => {
    for (const rows of ROWS) {
      const l = plan(140, rows, { snapshot: snapshot({ roster: manyAgents(14) }) });
      expect(l.rosterRows.length + (l.overflow ? 1 : 0)).toBeLessThanOrEqual(maxRosterRows(rows));
    }
  });

  it('shows no overflow line when the roster fits', () => {
    expect(plan(140, 40).overflow).toBeNull();
  });

  it('draws the 10-cell gauge from confirmed/100 and a `+` suffix over 100', () => {
    expect([0, 4, 5, 80, 99, 100, 150, -3].map(gaugeFilledCells)).toEqual([0, 0, 1, 8, 10, 10, 10, 0]);
    expect(scoreText(115)).toBe('115+');
    expect(scoreText(100)).toBe('100');
    expect(scoreText(-5)).toBe('0');
    const l = plan(140, 40, { snapshot: snapshot({ roster: [rosterRow({ confirmed: 115 })] }) });
    const gauge = l.rosterRows[0]!.cells.find((c) => c.key === 'gauge')!;
    expect(gauge.segments.map((s) => s.text).join('')).toBe('█'.repeat(10));
    const score = l.rosterRows[0]!.cells.find((c) => c.key === 'score')!;
    expect(flat(score.segments).trim()).toBe('115+');
  });

  it('shows provisional as `+15P` text, never as part of the bar', () => {
    const l = plan(140, 40, { snapshot: snapshot({ roster: [rosterRow({ provisional: 15 })] }) });
    const row = l.rosterRows[0]!;
    expect(flat(row.cells.find((c) => c.key === 'prov')!.segments).trim()).toBe('+15P');
    const gauge = flat(row.cells.find((c) => c.key === 'gauge')!.segments);
    expect(gauge).toBe('█'.repeat(10));
  });

  it('prints `not scored` for the inspector instead of a bar', () => {
    const l = plan(140, 40, {
      snapshot: snapshot({
        roster: [rosterRow({ id: 'insp', role: 'INSP', confirmed: null, label: 'NOT_SCORED' })],
      }),
    });
    const row = l.rosterRows[0]!;
    expect(flat(row.cells.find((c) => c.key === 'gauge')!.segments)).toBe('not scored');
    expect(row.cells.find((c) => c.key === 'score')!.segments).toEqual([]);
  });

  it('tags WARNING / DANGER / KILLED rows and leaves NORMAL untagged', () => {
    const tags = (label: 'NORMAL' | 'WARNING' | 'DANGER' | 'KILLED'): string => {
      const l = plan(140, 40, { snapshot: snapshot({ roster: [rosterRow({ label })] }) });
      return flat(l.rosterRows[0]!.cells.find((c) => c.key === 'tag')!.segments).trim();
    };
    expect([tags('NORMAL'), tags('WARNING'), tags('DANGER'), tags('KILLED')])
      .toEqual(['', 'WARN', 'DANGER', 'KILLED']);
  });
});

describe('column geometry (one elastic column between fixed ones)', () => {
  for (const tier of ['full', 'standard', 'compact'] as const) {
    it(`${tier}: widths never exceed the budget for any width 0..400, in both glyph tiers`, () => {
      for (const glyphs of [UNICODE, ASCII]) {
        for (let inner = 0; inner <= 400; inner += 1) {
          const columns = columnPlan(tier, inner, markerCells(glyphs));
          expect(columnsWidth(columns), `${tier} inner=${inner}`).toBeLessThanOrEqual(inner);
          expect(columns.filter((c) => c.elastic).length).toBeLessThanOrEqual(1);
          for (const column of columns) expect(column.width).toBeGreaterThanOrEqual(0);
        }
      }
    });
  }

  it('keeps the elastic column between a fixed cluster and the fixed delta cell', () => {
    for (const tier of ['full', 'standard', 'compact'] as const) {
      const columns = columnPlan(tier, 120, 3);
      const index = columns.findIndex((c) => c.elastic);
      expect(index, tier).toBeGreaterThan(0);
      expect(index, tier).toBeLessThan(columns.length - 1);
      expect(columns[columns.length - 1]!.key).toBe('delta');
      expect(columns[columns.length - 1]!.elastic).toBe(false);
    }
  });

  it('spends the whole row: the elastic column takes exactly what the fixed ones leave', () => {
    const columns = columnPlan('full', 120, 3);
    expect(columnsWidth(columns)).toBe(120);
  });

  it('gives way in a fixed order before the row would overflow', () => {
    const keys = (inner: number): string[] => columnPlan('full', inner, 3).map((c) => c.key);
    expect(keys(120)).toContain('tag');
    expect(keys(70)).not.toContain('activity');
    expect(keys(60)).not.toContain('tag');
    expect(keys(60)).toContain('delta');
  });
});

describe('replaced members', () => {
  const eliminated = rosterRow({
    id: 'dev2', state: 'eliminated', confirmed: 0, label: 'KILLED', replacedBy: 'dev2-r1',
  });

  it('show `replaced by dev2-r1` in the phase they were eliminated, then drop out', () => {
    const snap = (phase: number) => snapshot({ phase, roster: [rosterRow({ id: 'dev1' }), eliminated] });
    let since = trackEliminated({}, snap(2));
    expect(since).toEqual({ dev2: 2 });

    const same = plan(140, 40, { snapshot: snap(2), eliminatedSince: since });
    expect(same.rosterRows.map((r) => r.key)).toEqual(['dev1', 'dev2']);
    const note = same.rosterRows[1]!.cells.find((c) => c.key === 'note')!;
    expect(flat(note.segments)).toContain('replaced by dev2-r1');

    since = trackEliminated(since, snap(3));
    expect(since).toEqual({ dev2: 2 });
    const later = plan(140, 40, { snapshot: snap(3), eliminatedSince: since });
    expect(later.rosterRows.map((r) => r.key)).toEqual(['dev1']);
  });

  it('keeps the same object when nothing new is eliminated', () => {
    const since = { dev2: 2 };
    expect(trackEliminated(since, snapshot({ roster: [eliminated], phase: 2 }))).toBe(since);
  });

  it('merges the state..tag cells into one note cell of the same total width', () => {
    const normal = plan(140, 40, { snapshot: snapshot({ roster: [rosterRow()] }) }).rosterRows[0]!;
    const gone = plan(140, 40, { snapshot: snapshot({ roster: [eliminated] }) }).rosterRows[0]!;
    const sum = (cells: { width: number }[]): number => cells.reduce((s, c) => s + c.width, 0);
    expect(sum(gone.cells)).toBe(sum(normal.cells));
  });
});

describe('delta emphasis (AC-27)', () => {
  const row = rosterRow({ lastDelta: { delta: 15, code: 'D1', at: NOW - 1000, provisional: true } });

  it('is bold and coloured for four seconds, then gone', () => {
    expect(deltaCell(row, NOW, false)).toEqual({ text: '+15P', tone: 'ok', bold: true });
    expect(deltaCell(row, NOW + DELTA_EMPHASIS_MS - 1000, false).text).toBe('+15P');
    expect(deltaCell(row, NOW + DELTA_EMPHASIS_MS, false).text).toBe('');
  });

  it('does not flash under reduced motion: the text stays, plain, until replaced', () => {
    expect(deltaCell(row, NOW + 60_000, true)).toEqual({ text: '+15P', tone: 'ok', bold: false });
  });

  it('colours a loss in the error tone and ignores a zero delta', () => {
    const loss = rosterRow({ lastDelta: { delta: -20, code: 'D5', at: NOW, provisional: false } });
    expect(deltaCell(loss, NOW, false)).toEqual({ text: '-20', tone: 'error', bold: true });
    const zero = rosterRow({ lastDelta: { delta: 0, code: 'D5', at: NOW, provisional: false } });
    expect(deltaCell(zero, NOW, true).text).toBe('');
    expect(deltaCell(rosterRow(), NOW, false).text).toBe('');
  });

  it("lands in the roster row's LAST cell, right-aligned", () => {
    const l = plan(140, 40, { snapshot: snapshot({ roster: [row] }) });
    const last = l.rosterRows[0]!.cells[l.rosterRows[0]!.cells.length - 1]!;
    expect(last.key).toBe('delta');
    expect(last.align).toBe('right');
    expect(flat(last.segments).trim()).toBe('+15P');
    expect(cellWidth(flat(last.segments))).toBe(last.width);
  });
});

describe('ASCII glyph tier', () => {
  it('produces only ASCII text in every segment of the panel', () => {
    const l = plan(140, 40, { glyphs: ASCII });
    const all = [
      l.header, l.pipeline, ...l.ticker,
      ...l.rosterRows.map((r) => ({ left: r.cells.flatMap((c) => c.segments), right: [] })),
    ];
    for (const line of all) {
      if (line === null) continue;
      expect(flat([...line.left, ...line.right])).not.toMatch(/[^\x20-\x7e]/);
    }
  });

  it('still fits the row with the wider ASCII markers', () => {
    const l = plan(100, 26, { glyphs: ASCII });
    expect(columnsWidth(l.columns)).toBeLessThanOrEqual(l.innerCols);
  });
});

describe('status mapping reuses team-status.ts', () => {
  const statuses: ChildStatus[] = ['queued', 'running', 'done', 'failed', 'aborted'];

  it('resolves to the same colour team-status.ts gives that status, in every theme', () => {
    for (const name of ['warm', 'cool', 'light'] as const) {
      const theme = getTheme(name, { colorLevel: 3, unicode: true });
      for (const status of statuses) {
        expect(toneColor(statusTone(status), theme), `${name}/${status}`)
          .toBe(statusColor(status, theme));
      }
    }
  });

  it('maps every agent state to a status', () => {
    expect(govChildStatus('working')).toBe('running');
    expect(govChildStatus('submitted')).toBe('done');
    expect(govChildStatus('eliminated')).toBe('failed');
    expect(govChildStatus('idle')).toBe('queued');
  });
});

describe('theme', () => {
  it('pins governAccent to magenta at 16 colours and drops it at level 0', () => {
    expect(getTheme('warm', { colorLevel: 1, unicode: true }).governAccent).toBe('magenta');
    expect(getTheme('cool', { colorLevel: 1, unicode: true }).governAccent).toBe('magenta');
    expect(getTheme('warm', { colorLevel: 0, unicode: true }).governAccent).toBeUndefined();
    expect(getTheme('warm', { colorLevel: 3, unicode: true }).governAccent).toBe('#B79CED');
  });
});

describe('availableRows ceiling', () => {
  it('steps the tier down until the panel fits', () => {
    const roomy = plan(140, 40);
    expect(roomy.tier).toBe('full');
    const tight = plan(140, 40, { availableRows: 6 });
    expect(tight.height).toBeLessThanOrEqual(6);
    expect(tight.tier).not.toBe('full');
    expect(plan(140, 40, { availableRows: 1 }).tier).toBe('minimal');
    expect(plan(140, 40, { availableRows: 0 }).height).toBe(0);
  });
});

describe('sketch fidelity', () => {
  it('reproduces the spec 10.3 rows at full width', () => {
    const l = plan(140, 40, { snapshot: snapshot({ roster: sketchRoster() }), glyphs: ASCII });
    const text = (r: number): string =>
      l.rosterRows[r]!.cells.map((c) => flat(c.segments).padEnd(c.width)).join('');
    expect(text(0)).toMatch(/dev1\s+DEV\s+submitted\s+##########\s+100\s+\+15P\s+auth-api/);
    expect(text(1)).toMatch(/dev2\s+DEV\s+submitted\s+########--\s+80\s+WARN\s+ui-form\s+rework 1\/3/);
    expect(text(5)).toMatch(/insp\s+INSP\s+idle\s+not scored/);
  });
});

describe('a pending /gov pause (governance-mode-v1-1 6.4)', () => {
  it('names the stage once, in the status word, and not again beside the elapsed time', () => {
    const header = flat(plan(120, 40, { snapshot: snapshot({ pauseRequested: true }) }).header!.left);
    expect(header).toContain('pausing after REVIEW');
    expect(header.match(/REVIEW/g)).toHaveLength(1);
    const compact = flat(plan(70, 40, { snapshot: snapshot({ pauseRequested: true }) }).header!.left);
    expect(compact).toContain('pausing after REVIEW');
  });

  it('is invisible once the run is paused or escalated (the request is redeemed or dropped)', () => {
    for (const status of ['paused', 'escalated'] as const) {
      const header = flat(plan(120, 40, { snapshot: snapshot({ status, pauseRequested: true }) })
        .header!.left);
      expect(header).not.toContain('pausing');
    }
  });

  it('adds nothing when no request is pending', () => {
    expect(flat(plan(120, 40).header!.left)).not.toContain('pausing');
    expect(flat(plan(120, 40, { snapshot: snapshot({ pauseRequested: false }) }).header!.left))
      .not.toContain('pausing');
  });

  it('shortens to `pausing` in the one-row tier', () => {
    const minimal = plan(50, 40, { snapshot: snapshot({ pauseRequested: true }) });
    expect(flat(minimal.header!.left)).toContain('pausing');
  });

  it('every size still fits the terminal while a pause is pending', () => {
    for (const cols of COLS) {
      for (const rows of ROWS) {
        const layout = plan(cols, rows, { snapshot: snapshot({ pauseRequested: true }) });
        const header = layout.header;
        if (header === null) continue;
        expect(segmentsCells(header.left) + header.rightCells).toBeLessThanOrEqual(cols);
      }
    }
  });
});
