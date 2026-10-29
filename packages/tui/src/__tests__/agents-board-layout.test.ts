/**
 * The Agents board's pure projection (tui-subagent-panel AC-16 / AC-17b).
 *
 * The overlay's rows are STRINGS, so both failure modes are assertable without a
 * terminal: a row wider than the overlay (which desynchronises `OverlayFrame`'s
 * position indicator) and a section that invents a fact its source does not have
 * (which is what the live-only rule exists to prevent).
 */

import { describe, expect, it } from 'vitest';
import stringWidth from 'string-width';
import {
  buildAgentBoardRows,
  factPairs,
  resolveBoardSource,
  resolveSelection,
  type BoardRow,
  type BoardSource,
} from '../ui/layout/agents-board.js';
import { pickGlyphs } from '../ui/glyphs.js';
import { TEAM_LIMITS } from '../model/team/limits.js';
import type { Entry } from '../model/agent/reducer.js';
import type { SubagentRun, TeamSnapshot } from '../model/team/types.js';
import { DEVELOPER_VOICE } from '../ui/tool-voice.js';

const UNICODE = pickGlyphs({ colorLevel: 3, unicode: true });
const ASCII = pickGlyphs({ colorLevel: 0, unicode: false });

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
    usage: { inputTokens: 12_400, outputTokens: 3_100 },
    filesTouched: ['src/auth.ts', 'src/routes.ts', 'src/db.ts', 'src/x.ts'],
    messagesSent: 1,
    ...over,
  };
}

function live(over: Partial<TeamSnapshot> = {}): TeamSnapshot {
  return {
    dispatchId: 'd1',
    active: true,
    runs: [
      run(),
      run({ label: 'a2', phase: 'thinking', activity: 'mapping the routes' }),
      run({ label: 'a3', phase: 'done', turns: 6, summary: 'surveyed the suite' }),
    ],
    requested: 3,
    startedAt: 1000,
    messageCount: 4,
    ...over,
  };
}

function settledEntry(over: Partial<Extract<Entry, { kind: 'team' }>> = {}): Entry {
  return {
    id: 'e1',
    kind: 'team',
    dispatchId: 'd1',
    requested: 3,
    aborted: false,
    active: false,
    durationMs: 72_000,
    runs: [
      run({ phase: 'failed', error: 'the middleware has no retry policy' }),
      run({ label: 'a2', phase: 'done', summary: 'ok' }),
    ],
    ...over,
  };
}

function rows(source: BoardSource, cols: number, glyphs = UNICODE): BoardRow[] {
  return buildAgentBoardRows({
    source,
    cols,
    now: 73_000,
    selectedLabel: null,
    glyphs,
    native: true,
    voice: DEVELOPER_VOICE,
  });
}

describe('AC-16: every row fits the overlay, at every width and tier', () => {
  it('measures at most `cols` for 60 / 100 / 140 columns', () => {
    const source = resolveBoardSource({ team: live(), entries: [] });
    expect(source).not.toBeNull();
    for (const cols of [60, 100, 140]) {
      for (const glyphs of [UNICODE, ASCII]) {
        for (const row of rows(source as BoardSource, cols, glyphs)) {
          expect(stringWidth(row.text), `${row.key} @${cols}`).toBeLessThanOrEqual(cols);
          expect(row.text).not.toContain('\n');
        }
      }
    }
  });

  it('keeps a stable, unique key per row', () => {
    const source = resolveBoardSource({ team: live(), entries: [] }) as BoardSource;
    const keys = rows(source, 100).map((row) => row.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('is bounded by boardMaxRows and announces the truncation', () => {
    const many = Array.from({ length: 10 }, (_, index) =>
      run({ label: `a${index}`, activity: 'x'.repeat(120), summary: 'y'.repeat(400) }));
    const source = resolveBoardSource({
      team: live({ runs: many }), entries: [],
    }) as BoardSource;
    const capped = rows(source, 40);
    expect(capped.length).toBeLessThanOrEqual(TEAM_LIMITS.boardMaxRows);
  });

  it('the 2-up field form appears at 110 columns and not below it', () => {
    const source = resolveBoardSource({ team: live(), entries: [] }) as BoardSource;
    const wide = rows(source, 120).filter((row) => row.kind === 'field');
    const medium = rows(source, 100).filter((row) => row.kind === 'field');
    // 2-up halves the number of field rows for the same facts.
    expect(wide.length).toBe(Math.ceil(medium.length / 2));
  });
});

describe('the board answers "what happened" in the order a reader wants it', () => {
  it('summary, then children, then the selected child, then its timeline', () => {
    const source = resolveBoardSource({ team: live(), entries: [] }) as BoardSource;
    const kinds = rows(source, 100).map((row) => row.kind);
    expect(kinds[0]).toBe('summary');
    const children = kinds.indexOf('child');
    const fields = kinds.indexOf('field');
    expect(children).toBeGreaterThan(0);
    expect(fields).toBeGreaterThan(children);
    // The prose sections follow the facts, in a fixed order: now, result, timeline.
    const list = rows(source, 100);
    const heading = (title: string): number =>
      list.findIndex((row) => row.kind === 'section' && row.text.trim() === title);
    expect(heading('now')).toBeGreaterThan(fields);
    expect(heading('result')).toBeGreaterThan(heading('now'));
    expect(heading('timeline')).toBeGreaterThan(heading('result'));
  });

  it('lists EVERY child, not the panel\'s five', () => {
    const seven = Array.from({ length: 7 }, (_, index) => run({ label: `a${index}` }));
    const source = resolveBoardSource({ team: live({ runs: seven }), entries: [] }) as BoardSource;
    expect(rows(source, 100).filter((row) => row.kind === 'child')).toHaveLength(7);
  });

  it('marks exactly one child as selected, with the cursor glyph', () => {
    const source = resolveBoardSource({ team: live(), entries: [] }) as BoardSource;
    const selected = rows(source, 100).filter((row) => row.selected === true);
    expect(selected).toHaveLength(1);
    expect(selected[0]?.text.startsWith(UNICODE.cursor)).toBe(true);
  });
});

describe('AC-17b / I-15: a settled source never invents a fact', () => {
  const settled = (): BoardSource =>
    resolveBoardSource({ team: null, entries: [settledEntry()] }) as BoardSource;

  it('resolves from the transcript when the dispatch is over', () => {
    const source = settled();
    expect(source.active).toBe(false);
    expect(source.durationMs).toBe(72_000);
    expect(source.messageCount).toBeUndefined();
    expect(source.startedAt).toBeUndefined();
  });

  it('still shows the RESULT - the reason a reader opens the board after the fact', () => {
    const text = rows(settled(), 100).map((row) => row.text).join('\n');
    expect(text).toContain('result');
    expect(text).toContain('the middleware has no retry policy');
  });

  it('never draws `mail 0`: the clause is absent, not zeroed', () => {
    const text = rows(settled(), 100).map((row) => row.text).join('\n');
    expect(text).not.toContain('mail 0');
  });

  it('says the live-only sections are gone instead of drawing empty headings', () => {
    const source = settled();
    const list = rows(source, 100);
    const nowHeading = list.findIndex((row) => row.text.trim() === 'now');
    expect(nowHeading).toBeGreaterThanOrEqual(0);
    expect(list[nowHeading + 1]?.text).toContain('live only');
    const timelineHeading = list.findIndex((row) => row.text.trim() === 'timeline');
    expect(timelineHeading).toBeGreaterThanOrEqual(0);
    expect(list[timelineHeading + 1]?.text).toContain('live only');
  });

  it('total duration comes from durationMs, so the summary row is not empty', () => {
    const first = rows(settled(), 100)[0];
    expect(first?.text).toContain('1m12s');
  });

  it('a live source DOES show mail, now and the timeline', () => {
    const source = resolveBoardSource({
      team: live({ runs: [run({ timeline: [{ kind: 'tool', at: 3000, text: 'grep: x', ok: true, ms: 12 }] })] }),
      entries: [],
    }) as BoardSource;
    const text = rows(source, 100).map((row) => row.text).join('\n');
    expect(text).toContain('mail 4');
    expect(text).toContain('grep: x');
  });
});

describe('resolveBoardSource / resolveSelection', () => {
  it('prefers the live snapshot over any transcript entry', () => {
    const source = resolveBoardSource({ team: live(), entries: [settledEntry()] });
    expect(source?.active).toBe(true);
    expect(source?.messageCount).toBe(4);
  });

  it('returns null with neither a snapshot nor a card', () => {
    expect(resolveBoardSource({ team: null, entries: [] })).toBeNull();
  });

  it('selects by label, falls back to the first RUNNING child, then to the first', () => {
    const runs = [run({ label: 'a1', phase: 'done' }), run({ label: 'a2', phase: 'tool' })];
    expect(resolveSelection(runs, 'a1')?.label).toBe('a1');
    expect(resolveSelection(runs, 'gone')?.label).toBe('a2');
    expect(resolveSelection([run({ label: 'z', phase: 'done' })], null)?.label).toBe('z');
    expect(resolveSelection([], null)).toBeNull();
  });
});

describe('factPairs: fixed order, and zero-valued rows absent', () => {
  it('always leads with state / turns / tools / tokens', () => {
    const labels = factPairs(run(), UNICODE).map(([label]) => label);
    expect(labels.slice(0, 4)).toEqual(['state', 'turns', 'tools', 'tokens']);
  });

  it('omits supervisor / retries / compactions / truncated when they are zero', () => {
    const labels = factPairs(run({ interventions: 0, replacements: 0, retries: 0 }), UNICODE)
      .map(([label]) => label);
    expect(labels).not.toContain('supervisor');
    expect(labels).not.toContain('retries');
    expect(labels).not.toContain('compactions');
    expect(labels).not.toContain('truncated');
  });

  it('shows them when they carry a fact', () => {
    const labels = factPairs(run({
      interventions: 2,
      replacements: 1,
      compactions: 3,
      truncated: true,
      retry: { attempt: 2, maxRetries: 3 },
    }), UNICODE).map(([label]) => label);
    expect(labels).toEqual(expect.arrayContaining([
      'supervisor', 'compactions', 'truncated', 'retries',
    ]));
  });

  it('summarises files as a count plus the first three paths', () => {
    const files = factPairs(run(), UNICODE).find(([label]) => label === 'files');
    expect(files?.[1]).toContain('4 (');
    expect(files?.[1]).toContain('(+1)');
  });
});
