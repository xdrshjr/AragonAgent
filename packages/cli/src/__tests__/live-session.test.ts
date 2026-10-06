/**
 * The live tail is not persisted (agent-activity-presentation-live D-24 / AC-34),
 * and every path to idle releases it (D-35 / AC-40).
 *
 * BOTH ARE SILENT WHEN THEY BREAK. A persisted tail resumes as a multi-row card
 * describing a process that died with the last session, counting seconds against
 * a `lastOutputAt` from yesterday; a tail nothing releases pins `Transcript`'s
 * MONOTONIC settled boundary and re-renders the tail every frame for the rest of
 * the session — the failure `settleRetryCard` states in its own words at
 * `reducer.ts:744-748`, one entry kind over.
 *
 * Named for the `retry-session` / `team-session` / `todo-session` convention.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSession, saveSession } from '../session/persist.js';
import { initialViewState, viewReducer, type Entry, type ViewState } from '../agent/reducer.js';

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aragon-live-session-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

type ToolEntry = Extract<Entry, { kind: 'tool' }>;

function runningWithTail(over: Partial<ToolEntry> = {}): ToolEntry {
  return {
    id: 'e1',
    kind: 'tool',
    toolCallId: 'c1',
    name: 'bash',
    label: 'Shell',
    argsRaw: '{"command":"npm test"}',
    status: 'running',
    live: ['PASS tests/patch.test.ts', 'PASS tests/diff-view.test.tsx'],
    liveSeq: 7,
    lastOutputAt: 1_700_000_000_000,
    ...over,
  } as ToolEntry;
}

const save = (entries: Entry[]): string => {
  const file = join(dir, 'mid-run.json');
  saveSession(file, {
    model: { providerId: 'anthropic', modelId: 'm' },
    messages: [],
    entries,
    todos: [],
  });
  return file;
};

describe('AC-34 — a mid-run /save writes no live tail', () => {
  /**
   * THE SERIALIZER IS `session/persist.ts`, AND IT IS THE ONLY ONE (P1-2).
   * `saveSession` writes `entries` verbatim and `agent/reducer.ts` has no
   * serializer at all, so a strip written anywhere else could not hold.
   */
  it('the file on disk mentions none of the three fields', () => {
    const raw = readFileSync(save([runningWithTail()]), 'utf-8');
    expect(raw).not.toContain('"live"');
    expect(raw).not.toContain('"liveSeq"');
    expect(raw).not.toContain('"lastOutputAt"');
    // The rest of the entry is untouched — this strips, it does not normalize.
    expect(raw).toContain('"toolCallId": "c1"');
    expect(raw).toContain('"status": "running"');
  });

  it('the tail is not in the file even when the surrounding rows are', () => {
    const raw = readFileSync(
      save([
        { id: 'e0', kind: 'notice', level: 'info', text: 'before' },
        runningWithTail(),
      ]),
      'utf-8',
    );
    expect(raw).toContain('before');
    expect(raw).not.toContain('PASS tests/patch.test.ts');
  });

  it('does not mutate the caller`s entries', () => {
    // `/save` happens mid-run: the array it is handed is live `ViewState`.
    const entry = runningWithTail();
    save([entry]);
    expect(entry.live).toHaveLength(2);
    expect(entry.liveSeq).toBe(7);
  });

  /**
   * D-24's "omission needs no clause" is only honest BECAUSE the write path
   * strips: `normalizeLoadedEntries` has no clause for tool entries, so a
   * resumed card keeps `status: 'running'` — and only an absent tail makes it
   * identical to what today's build draws for the same file.
   */
  it('reloads as the one-row running card today`s build draws', () => {
    const loaded = loadSession(save([runningWithTail()]));
    const card = loaded.entries[0]!;
    expect(card.kind).toBe('tool');
    expect(card.kind === 'tool' && card.status).toBe('running');
    expect(card.kind === 'tool' && card.live).toBeUndefined();
    expect(card.kind === 'tool' && card.liveSeq).toBeUndefined();
    expect(card.kind === 'tool' && card.lastOutputAt).toBeUndefined();
  });

  it('leaves a settled tool entry byte-identical through the round trip', () => {
    const settled = runningWithTail({
      status: 'done',
      durationMs: 42,
      preview: 'PASS  18 tests',
      live: undefined,
      liveSeq: undefined,
      lastOutputAt: undefined,
    });
    const loaded = loadSession(save([settled]));
    expect(loaded.entries[0]).toEqual(settled);
  });
});

describe('AC-40 — every path to idle releases the tail (D-35)', () => {
  /** A state holding one running tool entry with a live tail. */
  function stateWithTail(): ViewState {
    const base = initialViewState();
    return { ...base, status: 'running', entries: [runningWithTail()] };
  }

  const toolOf = (s: ViewState) => s.entries[0] as ToolEntry;

  it('`runEnd` clears `live` and `lastOutputAt`', () => {
    const after = viewReducer(stateWithTail(), { type: 'runEnd' });
    expect(toolOf(after).live).toBeUndefined();
    expect(toolOf(after).lastOutputAt).toBeUndefined();
  });

  it('`abortMark` clears them too — Esc during `npm test` is the common case', () => {
    const after = viewReducer(stateWithTail(), { type: 'abortMark' });
    expect(toolOf(after).live).toBeUndefined();
    expect(toolOf(after).lastOutputAt).toBeUndefined();
  });

  it('does NOT change the tool`s status, which is a different decision (D-35)', () => {
    for (const action of [{ type: 'runEnd' } as const, { type: 'abortMark' } as const]) {
      const after = viewReducer(stateWithTail(), action);
      expect(toolOf(after).status, action.type).toBe('running');
    }
  });

  it('bumps `liveSeq`, because nothing else in the revision moves', () => {
    // With the status untouched and the preview untouched, `liveSeq` is the only
    // term that can tell the height cache the card is now one row (I-L3-1).
    const after = viewReducer(stateWithTail(), { type: 'runEnd' });
    expect(toolOf(after).liveSeq).toBe(8);
  });

  it('leaves entries without a tail referentially identical (memo boundary)', () => {
    const base = initialViewState();
    const untouched: Entry = { id: 'n1', kind: 'notice', level: 'info', text: 'x' };
    const state: ViewState = {
      ...base,
      status: 'running',
      entries: [untouched, runningWithTail()],
    };
    const after = viewReducer(state, { type: 'runEnd' });
    expect(after.entries[0]).toBe(untouched);
  });

  it('a released card no longer pins the monotonic settled boundary`s cost', () => {
    // It still holds the boundary (its status is unchanged, by design), but it
    // costs the ONE spinner row it costs today rather than a permanent multi-row
    // card with a stall clock frozen at its last value.
    const after = viewReducer(stateWithTail(), { type: 'abortMark' });
    const tail: Entry = { id: 'e2', kind: 'notice', level: 'info', text: 'x' };
    expect(toolOf(after).live).toBeUndefined();
  });

  it('is a no-op when there is no tail to release', () => {
    const base = initialViewState();
    const noTail = runningWithTail({ live: undefined, liveSeq: undefined, lastOutputAt: undefined });
    const state: ViewState = { ...base, status: 'running', entries: [noTail] };
    const after = viewReducer(state, { type: 'runEnd' });
    expect(after.entries[0]).toBe(noTail);
  });
});
