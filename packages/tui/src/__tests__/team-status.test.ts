/**
 * The ONE axis of the subagent UI: phase -> status -> glyph / colour / count /
 * elapsed (tui-subagent-double-roster A-1).
 *
 * These assertions are the reason the module exists. Before it, the transcript
 * card asked `isOk(run) ? toolDone : toolError`, so every child that was still
 * working was drawn with the FAILURE glyph, a cancelled child was counted as a
 * failed one forever, and a running child's elapsed time read `0ms` while the
 * roster beside it read `1m05s`. Each `it` below pins one of those readings.
 */

import { describe, expect, it } from 'vitest';
import { getTheme } from '../ui/theme.js';
import { pickGlyphs, type Glyphs } from '../ui/glyphs.js';
import type { TermCapabilities } from '../ui/capabilities.js';
import type { SubagentPhase, SubagentRun } from '../model/team/types.js';
import type { Entry } from '../model/agent/reducer.js';
import {
  childElapsedMs,
  childStatus,
  isLiveTeamCard,
  outcomePhrase,
  rosterCounts,
  rosterHeadline,
  statusColor,
  statusGlyph,
  statusMarkerCell,
  type ChildStatus,
} from '../ui/team-status.js';

const UNICODE = { colorLevel: 3, unicode: true } as unknown as TermCapabilities;
const ASCII = { colorLevel: 0, unicode: false } as unknown as TermCapabilities;
const G_UNICODE = pickGlyphs(UNICODE);
const G_ASCII = pickGlyphs(ASCII);
const THEME = getTheme('cool', UNICODE);

function run(over: Partial<SubagentRun> = {}): SubagentRun {
  return {
    label: 'planner',
    description: 'map the auth middleware',
    phase: 'tool',
    startedAt: 1_000,
    turns: 2,
    toolCalls: 3,
    usage: { inputTokens: 1, outputTokens: 1 },
    filesTouched: [],
    messagesSent: 0,
    ...over,
  } as SubagentRun;
}

const ALL_STATUSES: readonly ChildStatus[] = ['queued', 'running', 'done', 'failed', 'aborted'];

describe('childStatus: the five readings a phase can have', () => {
  it('maps every phase of the union, and collapses the four working ones', () => {
    const expected: [SubagentPhase, ChildStatus][] = [
      ['queued', 'queued'],
      ['starting', 'running'],
      ['thinking', 'running'],
      ['tool', 'running'],
      ['waiting', 'running'],
      ['done', 'done'],
      ['failed', 'failed'],
      ['aborted', 'aborted'],
    ];
    for (const [phase, status] of expected) {
      expect(childStatus(run({ phase })), phase).toBe(status);
    }
  });

  it('keeps `aborted` its own state - a cancelled child is not a failed one', () => {
    expect(childStatus(run({ phase: 'aborted' }))).not.toBe(childStatus(run({ phase: 'failed' })));
  });
});

describe('statusGlyph: running / done / failed / queued / aborted are distinguishable', () => {
  it('gives five pairwise different glyphs in the Unicode tier', () => {
    const glyphs = ALL_STATUSES.map((status) => statusGlyph(status, G_UNICODE));
    expect(new Set(glyphs).size).toBe(glyphs.length);
    expect(statusGlyph('done', G_UNICODE)).toBe(G_UNICODE.toolDone);
    expect(statusGlyph('failed', G_UNICODE)).toBe(G_UNICODE.toolError);
    expect(statusGlyph('queued', G_UNICODE)).toBe(G_UNICODE.toolPending);
    expect(statusGlyph('aborted', G_UNICODE)).toBe(G_UNICODE.warn);
    // The running marker is the spinner's STATIC fallback; a running row must never
    // wear the failure cross (the reporter's screenshot).
    expect(statusGlyph('running', G_UNICODE)).toBe(G_UNICODE.spinnerStill);
    expect(statusGlyph('running', G_UNICODE)).not.toBe(G_UNICODE.toolError);
  });

  it('gives five pairwise different glyphs in the ASCII tier too', () => {
    const glyphs = ALL_STATUSES.map((status) => statusGlyph(status, G_ASCII));
    expect(new Set(glyphs).size).toBe(glyphs.length);
    expect(glyphString(glyphs)).toMatch(/^[\x20-\x7e]+$/);
  });

  it('pads the marker cell to the tier width, so labels line up in ASCII', () => {
    const widths = new Set(ALL_STATUSES.map((status) => statusMarkerCell(status, G_ASCII).length));
    expect(widths.size).toBe(1);
    // The Unicode tier is one cell everywhere, so the padding is a no-op there.
    for (const status of ALL_STATUSES) {
      expect(statusMarkerCell(status, G_UNICODE)).toBe(statusGlyph(status, G_UNICODE));
    }
  });
});

function glyphString(glyphs: readonly string[]): string {
  return glyphs.join('');
}

describe('statusColor: the same five readings in colour', () => {
  it('separates running, done, failed and aborted', () => {
    expect(statusColor('running', THEME)).toBe(THEME.toolRunning);
    expect(statusColor('done', THEME)).toBe(THEME.toolDone);
    expect(statusColor('failed', THEME)).toBe(THEME.toolError);
    // THE USER'S OWN Esc MUST NOT READ AS A FAILURE (E8). Distinct from `toolError`
    // here; the warning tone is the palette's "notice", not its "error".
    expect(statusColor('aborted', THEME)).toBe(THEME.noticeWarn);
    expect(statusColor('aborted', THEME)).not.toBe(statusColor('failed', THEME));
    expect(statusColor('queued', THEME)).toBe(THEME.toolPending);
  });
});

describe('rosterCounts: queued is a bucket, not a hole', () => {
  it('counts every phase exactly once, including queued', () => {
    const counts = rosterCounts([
      run({ phase: 'queued' }),
      run({ phase: 'queued' }),
      run({ phase: 'thinking' }),
      run({ phase: 'done' }),
      run({ phase: 'failed' }),
      run({ phase: 'aborted' }),
    ]);
    expect(counts).toEqual({
      queued: 2, running: 1, done: 1, failed: 1, aborted: 1, total: 6,
    });
  });

  it('reports an empty roster as all zeros', () => {
    expect(rosterCounts([])).toEqual({
      queued: 0, running: 0, done: 0, failed: 0, aborted: 0, total: 0,
    });
  });
});

describe('rosterHeadline: the header never contradicts its own rows', () => {
  it('names queued children (the old filter reported `0 running  0 done`)', () => {
    const counts = rosterCounts([run({ phase: 'queued' }), run({ phase: 'queued' })]);
    expect(rosterHeadline(counts, G_UNICODE, 100)).toContain('2 queued');
  });

  it('omits a zero queued/failed/aborted bucket but always shows running and done', () => {
    const text = rosterHeadline(rosterCounts([run({ phase: 'tool' })]), G_UNICODE, 100);
    expect(text).toContain('1 running');
    expect(text).toContain('0 done');
    expect(text).not.toContain('queued');
  });

  it('drops the settled clauses first when the terminal is narrow', () => {
    const counts = rosterCounts([
      run({ phase: 'tool' }), run({ phase: 'queued' }), run({ phase: 'done' }),
    ]);
    const wide = rosterHeadline(counts, G_UNICODE, 120);
    expect(wide).toContain('done');
    expect(wide).toContain('queued');
    // 30 columns: the counting clauses are planned against `cols - reserve`, so the
    // least urgent clause (`done`) goes first and `running` is never dropped.
    const narrow = rosterHeadline(counts, G_UNICODE, 30);
    expect(narrow).toContain('running');
    expect(narrow).not.toContain('done');
  });
});

describe('outcomePhrase: a settled dispatch names its own buckets', () => {
  it('omits empty buckets and keeps `ok` as the denominator', () => {
    const counts = rosterCounts([
      run({ phase: 'done' }), run({ phase: 'done' }), run({ phase: 'failed' }),
    ]);
    expect(outcomePhrase(counts)).toBe('2 ok, 1 failed');
  });

  it('gives a cancellation its own bucket instead of inflating `failed` (E8)', () => {
    const counts = rosterCounts([
      run({ phase: 'done' }), run({ phase: 'aborted' }), run({ phase: 'aborted' }),
    ]);
    expect(outcomePhrase(counts)).toBe('1 ok, 2 aborted');
  });
});

describe('childElapsedMs: a running child has run for a while', () => {
  it('measures against `now` while the child is unfinished', () => {
    // `(endedAt ?? 0) - startedAt` clamped this to `0ms`; the roster beside the same
    // child said `1m05s`.
    expect(childElapsedMs(run({ startedAt: 1_000 }), 66_000)).toBe(65_000);
  });

  it('uses the recorded `endedAt` once it has one, and never goes negative', () => {
    expect(childElapsedMs(run({ startedAt: 1_000, endedAt: 4_500 }), 66_000)).toBe(3_500);
    expect(childElapsedMs(run({ startedAt: 9_000 }), 1_000)).toBe(0);
    expect(childElapsedMs(run({ startedAt: undefined }), 66_000)).toBe(0);
  });
});

describe('isLiveTeamCard: the one suppression predicate', () => {
  const team = (active: boolean): Entry => ({
    id: 'team-1', kind: 'team', dispatchId: 'd1', requested: 1, runs: [run()],
    aborted: false, active,
  });

  it('is true only for a dispatch entry that is still running', () => {
    expect(isLiveTeamCard(team(true))).toBe(true);
    expect(isLiveTeamCard(team(false))).toBe(false);
    expect(isLiveTeamCard({ id: 't1', kind: 'tool', toolCallId: 'c', name: 'bash', label: 'b',
      argsRaw: '{}', status: 'running' })).toBe(false);
  });
});
