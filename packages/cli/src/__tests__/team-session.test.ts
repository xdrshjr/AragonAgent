import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSession, normalizeLoadedEntries, saveSession } from '../session/persist.js';
import { computeSettledCount } from '../ui/Transcript.js';
import { initialViewState, viewReducer, type Entry } from '../agent/reducer.js';
import type {
  DispatchOutcome,
  SubagentRun,
  SubagentSpec,
  TeamSnapshot,
} from '../team/types.js';

const dir = mkdtempSync(join(tmpdir(), 'aragon-team-session-'));

function run(over: Partial<SubagentRun> = {}): SubagentRun {
  return {
    label: 'a1',
    description: 'read the auth middleware',
    tier: 'main',
    phase: 'thinking',
    turns: 1,
    toolCalls: 2,
    usage: { inputTokens: 10, outputTokens: 5 },
    filesTouched: [],
    messagesSent: 0,
    ...over,
  };
}

const liveTeamEntry: Entry = {
  id: 'e1',
  kind: 'team',
  dispatchId: 'd1',
  requested: 3,
  runs: [run(), run({ label: 'a2' }), run({ label: 'a3' })],
  aborted: false,
  active: true,
};

describe('P1-5 — a session saved mid-dispatch resumes settled', () => {
  it('rewrites an active team entry to { active: false, aborted: true } on load', () => {
    // `saveSession` writes `entries` verbatim and `loadSession` validates only
    // array-ness, so without this the card resumes claiming to be running while
    // nothing is. TWO things then go wrong at once: it spins forever, and
    // `Transcript`'s settled boundary is MONOTONIC, so an entry that never
    // settles is re-rendered on every frame for the rest of the session.
    const file = join(dir, 'mid-dispatch.json');
    saveSession(file, {
      model: { providerId: 'anthropic', modelId: 'm' },
      messages: [],
      entries: [liveTeamEntry],
      // REQUIRED, not optional, and deliberately so (todo-plan-execution P0-2):
      // widening `SavedSession` alone would leave `/save` never writing the
      // field, so the writer takes it from THIS parameter. An empty list is the
      // honest value for a dispatch fixture that never planned anything.
      todos: [],
    });

    const loaded = loadSession(file);
    const entry = loaded.entries[0]!;
    expect(entry.kind).toBe('team');
    if (entry.kind !== 'team') throw new Error('unreachable');
    expect(entry.active).toBe(false);
    // Also simply true: the children died with the process.
    expect(entry.aborted).toBe(true);
  });

  it('leaves a settled team entry exactly as it was written', () => {
    const settled: Entry = { ...liveTeamEntry, active: false, aborted: false, durationMs: 84_200 };
    expect(normalizeLoadedEntries([settled])).toEqual([settled]);
  });

  it('leaves every other entry kind untouched', () => {
    const entries: Entry[] = [
      { id: 'e1', kind: 'user', text: 'hi' },
      { id: 'e2', kind: 'notice', level: 'info', text: 'note' },
    ];
    expect(normalizeLoadedEntries(entries)).toEqual(entries);
  });

  it('the normalized entry SETTLES, so it can reach <Static>', () => {
    // The point of the fix: an unsettled entry is what pins the transcript into
    // a permanent re-render. `computeSettledCount` keeps a live dispatch out of
    // the settled prefix and lets the normalized one in.
    const tail: Entry = { id: 'e9', kind: 'user', text: 'later' };
    expect(computeSettledCount([liveTeamEntry, tail], {})).toBe(0);
    expect(computeSettledCount([...normalizeLoadedEntries([liveTeamEntry]), tail], {})).toBe(1);
  });
});

describe('the reducer keeps the live card and the panel in step (§5.3)', () => {
  const specs: SubagentSpec[] = [
    { label: 'a1', description: 'one', prompt: 'p', readOnly: false, tier: 'main' },
    { label: 'a2', description: 'two', prompt: 'p', readOnly: false, tier: 'main' },
  ];

  it('teamStart appends an active card AND opens the panel', () => {
    const state = viewReducer(initialViewState(), {
      type: 'teamStart',
      dispatchId: 'd1',
      requested: 5,
      specs,
    });
    expect(state.team?.active).toBe(true);
    expect(state.team?.requested).toBe(5);
    const entry = state.entries[0]!;
    expect(entry.kind).toBe('team');
    if (entry.kind !== 'team') throw new Error('unreachable');
    expect(entry.active).toBe(true);
    expect(entry.runs).toHaveLength(2);
  });

  it('teamUpdate rewrites the known entry rather than scanning for it', () => {
    let state = viewReducer(initialViewState(), {
      type: 'teamStart',
      dispatchId: 'd1',
      requested: 2,
      specs,
    });
    const snapshot: TeamSnapshot = {
      dispatchId: 'd1',
      active: true,
      runs: [run({ label: 'a1', phase: 'tool', lastTool: 'grep' }), run({ label: 'a2' })],
      requested: 2,
      startedAt: 0,
      messageCount: 1,
    };
    state = viewReducer(state, { type: 'teamUpdate', snapshot });
    expect(state.team).toBe(snapshot);
    const entry = state.entries[0]!;
    if (entry.kind !== 'team') throw new Error('unreachable');
    expect(entry.runs[0]!.lastTool).toBe('grep');
  });

  it('teamEnd settles the card and CLOSES the panel (D-11)', () => {
    let state = viewReducer(initialViewState(), {
      type: 'teamStart',
      dispatchId: 'd1',
      requested: 2,
      specs,
    });
    const outcome: DispatchOutcome = {
      dispatchId: 'd1',
      runs: [run({ label: 'a1', phase: 'done', summary: 's' }), run({ label: 'a2', phase: 'failed' })],
      requested: 2,
      startedAt: 1000,
      endedAt: 85_200,
      aborted: false,
      leadMail: [],
      usage: { inputTokens: 1, outputTokens: 2 },
    };
    state = viewReducer(state, { type: 'teamEnd', outcome });
    // The requirement's "(dang you de shi hou)": the panel exists only while a
    // dispatch does.
    expect(state.team).toBeNull();
    const entry = state.entries[0]!;
    if (entry.kind !== 'team') throw new Error('unreachable');
    expect(entry.active).toBe(false);
    expect(entry.durationMs).toBe(84_200);
  });

  it('AC-15: teamUsage touches usageTotal and NOT the context gauge', () => {
    // `context` shows the LEAD's context occupancy against the model's window;
    // folding five children into it would read 180% on a perfectly healthy
    // session. Child spend is real money, and it belongs in the cost readout
    // instead.
    const before = {
      ...initialViewState(),
      context: { ...initialViewState().context, occupied: 4200, pct: 2 },
    };
    const after = viewReducer(before, {
      type: 'teamUsage',
      usage: { inputTokens: 900, outputTokens: 300 },
      costDelta: 0.25,
    });
    expect(after.usageTotal).toEqual({
      inputTokens: 900,
      outputTokens: 300,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.25,
    });
    expect(after.context).toBe(before.context);
  });

  it('drops the live entry pointer when the transcript is cleared', () => {
    let state = viewReducer(initialViewState(), {
      type: 'teamStart',
      dispatchId: 'd1',
      requested: 2,
      specs,
    });
    expect(state.teamEntryId).toBeDefined();
    state = viewReducer(state, { type: 'clearTranscript' });
    expect(state.teamEntryId).toBeUndefined();
    // A later update must not resurrect a card that no longer exists.
    state = viewReducer(state, {
      type: 'teamUpdate',
      snapshot: { dispatchId: 'd1', active: true, runs: [], requested: 2, startedAt: 0, messageCount: 0 },
    });
    expect(state.entries).toEqual([]);
  });
});

process.on('exit', () => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup.
  }
});
