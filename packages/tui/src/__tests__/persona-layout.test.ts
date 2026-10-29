/**
 * Layout properties of the persona name cell: the subagent row, the governance roster,
 * the status-bar chip and the reducer switch
 * (tui-subagent-persona-and-developer-mode AC-2, AC-3, AC-11).
 */

import { describe, expect, it } from 'vitest';
import {
  TEAM_NAME_CELLS,
  activityBudget,
  teamRowCells,
  teamRowGeometry,
} from '../ui/layout/team-row.js';
import { buildGovernancePanelLayout } from '../ui/layout/governance-panel.js';
import { buildRosterLine, columnPlan, columnsWidth, markerCells } from '../ui/layout/governance-roster.js';
import { planDevChip } from '../ui/layout/dev-chip.js';
import { pickGlyphs } from '../ui/glyphs.js';
import { TEAM_LIMITS } from '../model/team/limits.js';
import type { SubagentRun } from '../model/team/types.js';
import { DEVELOPER_VOICE, type VoiceContext } from '../ui/tool-voice.js';
import { initialViewState, viewReducer } from '../model/agent/reducer.js';
import { NOW, rosterRow, snapshot } from '../testing/governance-fixtures.js';

const UNICODE = pickGlyphs({ colorLevel: 3, unicode: true });
const ASCII = pickGlyphs({ colorLevel: 0, unicode: false });
const FRIENDLY: VoiceContext = {
  mode: 'friendly',
  reducedMotion: false,
  nameOf: (label) => ({ dev1: 'Wren', 'dev1-r1': 'Kit' } as Record<string, string>)[label] ?? '',
};

const flat = (segments: readonly { text: string }[]): string => segments.map((s) => s.text).join('');

function run(over: Partial<SubagentRun> = {}): SubagentRun {
  return {
    label: 'dev1', description: 'wire the retry policy', phase: 'tool', turns: 1, toolCalls: 2,
    usage: { inputTokens: 0, outputTokens: 0 }, filesTouched: [], messagesSent: 0, ...over,
  };
}

describe('teamRowGeometry with a name cell (AC-2)', () => {
  it('is total: every cell is a non-negative integer and the sum never exceeds cols', () => {
    for (const glyphs of [UNICODE, ASCII]) {
      for (let cols = 0; cols <= 400; cols += 1) {
        const g = teamRowGeometry(cols, glyphs, { showName: true });
        const cells = [g.marker, g.name, g.label, g.gap, g.activity, g.clock];
        for (const cell of cells) {
          expect(Number.isInteger(cell)).toBe(true);
          expect(cell).toBeGreaterThanOrEqual(0);
        }
        expect(cells.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(cols);
      }
    }
  });

  it('keeps the description at or above 12 cells from 40 columns up, in both glyph tiers', () => {
    for (const glyphs of [UNICODE, ASCII]) {
      for (let cols = 40; cols <= 400; cols += 1) {
        const g = teamRowGeometry(cols, glyphs, { showName: true });
        const description = cols - (g.marker + g.name + g.label + g.gap + g.activity + g.clock);
        expect(description, `cols=${cols}`).toBeGreaterThanOrEqual(12);
      }
    }
  });

  it('the name is the last thing to give way', () => {
    expect(teamRowGeometry(40, UNICODE, { showName: true }).name).toBe(TEAM_NAME_CELLS);
    expect(teamRowGeometry(40, ASCII, { showName: true }).name).toBe(TEAM_NAME_CELLS);
  });

  it('without showName the geometry is the pre-persona one (name = 0)', () => {
    for (const cols of [0, 40, 80, 120, 400]) {
      expect(teamRowGeometry(cols, UNICODE).name).toBe(0);
      expect(teamRowGeometry(cols, UNICODE, { showName: false })).toEqual(teamRowGeometry(cols, UNICODE));
    }
  });

  it('the activity cell drops at the name-aware threshold (63) and keeps the old one without a name', () => {
    expect(TEAM_LIMITS.activityDropColsWithName).toBe(TEAM_LIMITS.activityDropCols + TEAM_NAME_CELLS);
    expect(activityBudget(TEAM_LIMITS.activityDropColsWithName - 1, 3, TEAM_NAME_CELLS)).toBe(0);
    expect(activityBudget(TEAM_LIMITS.activityDropColsWithName, 3, TEAM_NAME_CELLS)).toBeGreaterThan(0);
    expect(activityBudget(TEAM_LIMITS.activityDropCols, 3)).toBe(TEAM_LIMITS.activityMinChars);
  });
});

describe('teamRowCells (AC-3)', () => {
  it('draws name, then role, then description in the geometry the panel uses', () => {
    const cells = teamRowCells(run(), 100, 5_000, UNICODE, FRIENDLY);
    expect(cells.name).toBe('Wren');
    expect(cells.label.trim()).toBe('dev1');
    expect(cells.activity.length).toBeGreaterThan(0);
    // Friendly wording: no raw identifier in the live activity.
    expect(teamRowCells(run({ lastTool: 'read_file' }), 100, 5_000, UNICODE, FRIENDLY).activity).not.toMatch(/read_file/);
    // Developer voice keeps the legacy wording but still carries the name.
    const dev = teamRowCells(run({ lastTool: 'read_file', activityArgs: { path: 'a.ts' } }), 140, 5_000, UNICODE, {
      ...DEVELOPER_VOICE, nameOf: FRIENDLY.nameOf,
    });
    expect(dev.activity).toContain('read:');
    expect(dev.name).toBe('Wren');
  });

  it('clamps an over-long name to its cell', () => {
    const voice: VoiceContext = { ...FRIENDLY, nameOf: () => 'Averyveryverylongname' };
    const cells = teamRowCells(run(), 100, 5_000, UNICODE, voice);
    expect(cells.name.length).toBeLessThanOrEqual(TEAM_NAME_CELLS);
  });
});

describe('governance roster name column (AC-11)', () => {
  it('columnPlan stays total with the name column, at every width and tier', () => {
    for (const tier of ['full', 'standard', 'compact', 'minimal'] as const) {
      for (let inner = 0; inner <= 400; inner += 1) {
        for (const showName of [false, true]) {
          const columns = columnPlan(tier, inner, markerCells(UNICODE), showName);
          expect(columnsWidth(columns)).toBeLessThanOrEqual(inner);
          for (const column of columns) expect(column.width).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it('without a name the plan is the pre-persona plan (no name column)', () => {
    for (const tier of ['full', 'standard', 'compact'] as const) {
      expect(columnPlan(tier, 120, 3).some((c) => c.key === 'name')).toBe(false);
      expect(columnPlan(tier, 120, 3, true).some((c) => c.key === 'name')).toBe(true);
    }
  });

  it('id gives way before every other cell, and the name never does', () => {
    for (let inner = 20; inner <= 140; inner += 1) {
      const keys = columnPlan('full', inner, 3, true).map((c) => c.key);
      expect(keys).toContain('name');
      if (!keys.includes('id')) {
        // once id is gone the narrower rungs may follow, but never the other way round
        continue;
      }
      expect(keys).toContain('state');
    }
    const wide = columnPlan('full', 140, 3, true).map((c) => c.key);
    expect(wide.indexOf('name')).toBeLessThan(wide.indexOf('role'));
    expect(wide.indexOf('role')).toBeLessThan(wide.indexOf('id'));
  });

  const build = (over: Parameters<typeof rosterRow>[0], voice?: VoiceContext, cols = 120) => {
    const columns = columnPlan('full', cols, markerCells(UNICODE), voice !== undefined);
    return buildRosterLine({
      columns, row: rosterRow(over), glyphs: UNICODE, now: NOW, reducedMotion: false,
      ...(voice !== undefined ? { voice } : {}),
    });
  };
  const text = (line: ReturnType<typeof build>): string => line.cells.map((c) => flat(c.segments)).join('|');

  it('shows the name and keeps the role label and the engine id', () => {
    const line = text(build({ id: 'dev1' }, FRIENDLY));
    expect(line).toContain('Wren');
    expect(line).toContain('DEV');
    expect(line).toContain('dev1');
  });

  it('friendly voice never prints the previous tool id while thinking (RV-P1-2)', () => {
    const thinking = build({
      id: 'dev1', state: 'working', activity: 'read_file',
      activityPhase: 'thinking', activityCalls: 3,
    }, FRIENDLY);
    expect(text(thinking)).not.toMatch(/read_file/);
    expect(text(thinking)).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
    // Developer voice still prints the legacy string verbatim.
    const dev = build({
      id: 'dev1', state: 'working', activity: 'read_file', activityPhase: 'thinking', activityCalls: 3,
    }, { ...DEVELOPER_VOICE, nameOf: FRIENDLY.nameOf });
    expect(text(dev)).toContain('read_file');
  });

  it('a tool call is worded and two consecutive same-tool calls can change wording', () => {
    const phrases = new Set<string>();
    for (let calls = 0; calls < 6; calls += 1) {
      const line = build({
        id: 'dev1', state: 'working', activity: 'grep', activityPhase: 'tool', activityTool: 'grep',
        activityArgs: { pattern: 'retry' }, activityCalls: calls,
      }, FRIENDLY, 140);
      expect(text(line)).not.toMatch(/\bgrep\b/);
      phrases.add(text(line));
    }
    expect(phrases.size).toBeGreaterThan(1);
  });

  it('an old snapshot without structured fields falls back to the legacy string', () => {
    const line = build({ id: 'dev1', state: 'working', activity: 'legacy words' }, FRIENDLY);
    expect(text(line)).toContain('legacy words');
  });

  it('a replaced member is named, and so is its successor', () => {
    const line = build({ id: 'dev1', state: 'eliminated', replacedBy: 'dev1-r1' }, FRIENDLY);
    expect(text(line)).toContain('Wren');
    expect(text(line)).toContain('replaced by Kit');
  });

  it('the panel layout adds the column only when handed a voice', () => {
    const base = { cols: 140, rows: 40, snapshot: snapshot(), glyphs: UNICODE, reducedMotion: false, now: NOW };
    const plain = buildGovernancePanelLayout(base);
    const named = buildGovernancePanelLayout({ ...base, voice: FRIENDLY });
    expect(plain.columns?.some((c) => c.key === 'name') ?? false).toBe(false);
    expect(named.columns?.some((c) => c.key === 'name')).toBe(true);
    expect(named.height).toBe(plain.height);
  });
});

describe('DEV chip', () => {
  it('shows only in developer mode and only when the left half keeps its floor', () => {
    expect(planDevChip({ columns: 120, developerMode: false }).visible).toBe(false);
    expect(planDevChip({ columns: 120, developerMode: undefined }).visible).toBe(false);
    const on = planDevChip({ columns: 120, developerMode: true });
    expect(on).toMatchObject({ visible: true, text: 'DEV', cells: 3, gap: 2 });
    expect(planDevChip({ columns: 30, developerMode: true }).visible).toBe(false);
    expect(planDevChip({ columns: Number.NaN, developerMode: true }).visible).toBe(false);
  });
});

describe('developerMode in the view reducer', () => {
  it('defaults to false and seeds from the caller', () => {
    expect(initialViewState().developerMode).toBe(false);
    expect(initialViewState({ developerMode: true }).developerMode).toBe(true);
  });

  it('toggles and sets, touching nothing else', () => {
    const base = initialViewState();
    const on = viewReducer(base, { type: 'toggleDeveloperMode' });
    expect(on.developerMode).toBe(true);
    expect({ ...on, developerMode: false }).toEqual(base);
    expect(viewReducer(on, { type: 'toggleDeveloperMode' }).developerMode).toBe(false);
    expect(viewReducer(on, { type: 'setDeveloperMode', value: true })).toBe(on);
    expect(viewReducer(on, { type: 'setDeveloperMode', value: false }).developerMode).toBe(false);
  });
});
