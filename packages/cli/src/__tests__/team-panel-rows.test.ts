import { describe, expect, it } from 'vitest';
import { selectPanelRows } from '../team/panel-rows.js';
import { TEAM_LIMITS } from '../team/limits.js';
import type { SubagentRun, SubagentPhase } from '../team/types.js';

function run(over: Partial<SubagentRun> = {}): SubagentRun {
  return {
    label: 'a1',
    description: 'read the auth middleware',
    phase: 'thinking',
    turns: 1,
    toolCalls: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
    filesTouched: [],
    messagesSent: 0,
    ...over,
  };
}

const labels = (rows: { visible: SubagentRun[] }): string[] => rows.visible.map((r) => r.label);

describe('selectPanelRows (F-2)', () => {
  it('AC-10: shows what is RUNNING, not what the slot pool started first', () => {
    // THE SHIPPED DEFECT, stated as a test. The pool hands out indices from a
    // shared cursor in order, so at `maxSubagents: 8, maxConcurrent: 3` the
    // first five by index are the five that FINISHED first - and `slice(0, 5)`
    // put all five on screen while three children worked behind `+3 more`. The
    // one thing clause R-g asks the panel for is the one thing it stopped doing.
    const runs = [
      ...Array.from({ length: 5 }, (_, i) =>
        run({ label: `done${i}`, phase: 'done', startedAt: 100 + i, endedAt: 1000 + i }),
      ),
      ...Array.from({ length: 3 }, (_, i) =>
        run({ label: `live${i}`, phase: 'thinking', startedAt: 2000 + i }),
      ),
    ];

    const rows = selectPanelRows(runs, TEAM_LIMITS.panelMaxRows);
    expect(labels(rows).slice(0, 3)).toEqual(['live0', 'live1', 'live2']);
    expect(rows.hiddenRunning).toBe(0);
    expect(rows.hiddenTotal).toBe(3);
  });

  it('ranks running before queued before settled', () => {
    const runs = [
      run({ label: 'settled', phase: 'done', startedAt: 1, endedAt: 2 }),
      run({ label: 'queued', phase: 'queued' }),
      run({ label: 'running', phase: 'tool', startedAt: 5 }),
    ];
    expect(labels(selectPanelRows(runs, 3))).toEqual(['running', 'queued', 'settled']);
  });

  it('treats all four running phases and all three settled phases as such', () => {
    const running: SubagentPhase[] = ['starting', 'thinking', 'tool', 'waiting'];
    const settled: SubagentPhase[] = ['done', 'failed', 'aborted'];
    for (const phase of running) {
      const rows = selectPanelRows([run({ label: 'x', phase }), run({ label: 'q', phase: 'queued' })], 1);
      expect(labels(rows), phase).toEqual(['x']);
      expect(rows.hiddenRunning, phase).toBe(0);
    }
    for (const phase of settled) {
      const rows = selectPanelRows([run({ label: 'x', phase }), run({ label: 'q', phase: 'queued' })], 1);
      expect(labels(rows), phase).toEqual(['q']);
    }
  });

  it('orders the running group by startedAt and the settled group most-recent-first', () => {
    const runs = [
      run({ label: 'late', phase: 'thinking', startedAt: 900 }),
      run({ label: 'early', phase: 'thinking', startedAt: 100 }),
      run({ label: 'oldResult', phase: 'done', startedAt: 1, endedAt: 50 }),
      run({ label: 'newResult', phase: 'failed', startedAt: 2, endedAt: 800 }),
    ];
    expect(labels(selectPanelRows(runs, 4))).toEqual(['early', 'late', 'newResult', 'oldResult']);
  });

  it('AC-11: the order is stable across ticks and total on ties', () => {
    // The panel re-renders every 200 ms; a row that moves on each tick is
    // unreadable, which is why the ranking keys are chosen so a run moves at
    // most twice in its life.
    const runs = [
      run({ label: 'a', phase: 'thinking', startedAt: 100 }),
      run({ label: 'b', phase: 'thinking', startedAt: 100 }),
      run({ label: 'c', phase: 'thinking', startedAt: 100 }),
    ];
    const first = labels(selectPanelRows(runs, 3));
    expect(first).toEqual(['a', 'b', 'c']);
    expect(labels(selectPanelRows(runs, 3))).toEqual(first);
  });

  it('AC-11: an already-settled run whose endedAt advances does not reorder the running rows', () => {
    const live = [
      run({ label: 'live1', phase: 'tool', startedAt: 10 }),
      run({ label: 'live2', phase: 'thinking', startedAt: 20 }),
    ];
    const before = selectPanelRows([...live, run({ label: 'old', phase: 'done', endedAt: 5 })], 5);
    const after = selectPanelRows([...live, run({ label: 'old', phase: 'done', endedAt: 999 })], 5);
    expect(labels(before).slice(0, 2)).toEqual(['live1', 'live2']);
    expect(labels(after).slice(0, 2)).toEqual(['live1', 'live2']);
  });

  it('AC-11a: a retry re-stamps startedAt, moving that row to the END of the running group only', () => {
    // The one place F-2 and F-4 interact. `startedAt` changes exactly once in a
    // run's life outside its first assignment - on a cold-start retry - and the
    // running group is ordered by "how long has this been going", which a retry
    // resets. No settled or queued row may move because of it (P2-4).
    const before = [
      run({ label: 'first', phase: 'thinking', startedAt: 100 }),
      run({ label: 'retried', phase: 'starting', startedAt: 110 }),
      run({ label: 'third', phase: 'tool', startedAt: 120 }),
      run({ label: 'waiting', phase: 'queued' }),
      run({ label: 'settled', phase: 'done', startedAt: 1, endedAt: 90 }),
    ];
    expect(labels(selectPanelRows(before, 5)))
      .toEqual(['first', 'retried', 'third', 'waiting', 'settled']);

    const after = before.map((r) =>
      r.label === 'retried' ? { ...r, startedAt: 500, retries: 1 } : r,
    );
    expect(labels(selectPanelRows(after, 5)))
      .toEqual(['first', 'third', 'retried', 'waiting', 'settled']);
  });

  it('counts hidden running rows so `+N more` can say how many are working', () => {
    const runs = Array.from({ length: 8 }, (_, i) =>
      run({ label: `a${i}`, phase: 'thinking', startedAt: 100 + i }),
    );
    const rows = selectPanelRows(runs, TEAM_LIMITS.panelMaxRows);
    expect(rows.hiddenTotal).toBe(3);
    expect(rows.hiddenRunning).toBe(3);
  });

  it('handles an empty roster and a zero / negative cap without throwing', () => {
    expect(selectPanelRows([], 5)).toEqual({ visible: [], hiddenTotal: 0, hiddenRunning: 0 });
    const one = [run({ label: 'a', phase: 'thinking', startedAt: 1 })];
    expect(selectPanelRows(one, 0)).toEqual({ visible: [], hiddenTotal: 1, hiddenRunning: 1 });
    expect(selectPanelRows(one, -3).visible).toEqual([]);
  });

  it('does not mutate the roster it was handed', () => {
    // `App` holds the snapshot; sorting it in place would reorder the live state
    // the reducer owns.
    const runs = [
      run({ label: 'settled', phase: 'done', endedAt: 5 }),
      run({ label: 'running', phase: 'tool', startedAt: 9 }),
    ];
    selectPanelRows(runs, 5);
    expect(runs.map((r) => r.label)).toEqual(['settled', 'running']);
  });
});
