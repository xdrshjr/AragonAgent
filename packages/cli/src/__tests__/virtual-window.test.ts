import { describe, expect, it } from 'vitest';
import {
  VIRTUAL_LIMITS,
  entryRevision,
  estimateEntryRows,
  heightKey,
  selectWindow,
} from '../ui/layout/virtual-window.js';
import { initialViewState, viewReducer, type Entry } from '../agent/reducer.js';
import { USER_ENTRY_MAX_ROWS } from '../ui/composer-limits.js';
import { userEntryRenderedRows } from '../ui/entries/UserEntry.js';

const uniform = (entries: Entry[], rows: number) => (): number => rows;

function entries(n: number): Entry[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `e${i}`,
    kind: 'notice' as const,
    level: 'info' as const,
    text: `n${i}`,
  }));
}

// ---------------------------------------------------------------------------
// I-L3-1 — the revision must change whenever the rendered output changes
// ---------------------------------------------------------------------------

describe('entryRevision (I-L3-1)', () => {
  it('is stable for an immutable entry', () => {
    const user: Entry = { id: 'e1', kind: 'user', text: 'hi' };
    expect(entryRevision(user)).toBe(entryRevision({ ...user }));
  });

  it('changes for every mutating action on an assistant entry', () => {
    let state = viewReducer(initialViewState(), { type: 'turnStart' });
    const revisions = new Set<string>();
    const record = (): void => {
      const e = state.entries[state.entries.length - 1]!;
      revisions.add(entryRevision(e));
    };
    record();
    state = viewReducer(state, { type: 'textDelta', delta: 'hello' });
    record();
    state = viewReducer(state, { type: 'thinkingDelta', delta: 'ponder' });
    record();
    state = viewReducer(state, { type: 'abortMark' });
    record();
    // 4 distinct states => 4 distinct revisions, or a stale height and a stale
    // subtree freeze with nothing anywhere reporting it.
    expect(revisions.size).toBe(4);
  });

  it('changes for every mutating action on a tool entry', () => {
    let state = viewReducer(initialViewState(), {
      type: 'toolCallStart',
      toolCallId: 'c1',
      toolName: 'bash',
    });
    const revisions = new Set<string>();
    const record = (): void => {
      revisions.add(entryRevision(state.entries[0]!));
    };
    record();
    state = viewReducer(state, { type: 'toolCallDelta', toolCallId: 'c1', argsDelta: '{"a":1}' });
    record();
    state = viewReducer(state, { type: 'toolExecStart', toolCallId: 'c1' });
    record();
    state = viewReducer(state, {
      type: 'toolExecEnd',
      toolCallId: 'c1',
      isError: false,
      duration: 12,
      preview: 'out',
    });
    record();
    expect(revisions.size).toBe(4);
  });

  /**
   * BOTH SWITCHES IN THIS FILE'S SOURCE, EVERY TIME (RV-13). Adding a field to
   * `estimateEntryRows` and not to `entryRevision` yields a transcript whose
   * scroll arithmetic disagrees with what it drew — drift, not an error.
   */
  it('changes when a thinking clock is sealed', () => {
    // With thinking HIDDEN, `thinkingMs` turns `* thought` into
    // `* thought for 12s` — and that row IS the entry's whole rendered height.
    const base: Extract<Entry, { kind: 'assistant' }> = {
      id: 'e1',
      kind: 'assistant',
      text: 'answer',
      thinking: 'ponder',
      thinkingOpen: false,
      streaming: false,
    };
    const sealed: Extract<Entry, { kind: 'assistant' }> = { ...base, thinkingMs: 12_000 };
    expect(entryRevision(base)).not.toBe(entryRevision(sealed));
  });

  it('changes when a tool entry gains a patch', () => {
    const base: Extract<Entry, { kind: 'tool' }> = {
      id: 'e1',
      kind: 'tool',
      toolCallId: 'c1',
      name: 'edit_file',
      label: 'Edit File',
      argsRaw: '{}',
      status: 'done',
      preview: 'Applied edit to a.ts:',
    };
    const patched: Extract<Entry, { kind: 'tool' }> = {
      ...base,
      patch: {
        path: 'a.ts',
        kind: 'update',
        added: 1,
        removed: 1,
        hunks: [],
        truncated: false,
        lineCount: 8,
      },
    };
    expect(entryRevision(base)).not.toBe(entryRevision(patched));
    // O(1): the term is the PRECOMPUTED `lineCount`, not a walk of the hunks.
    const wider = { ...patched, patch: { ...patched.patch!, lineCount: 9 } };
    expect(entryRevision(patched)).not.toBe(entryRevision(wider));
  });

  it('changes when a team roster advances', () => {
    const base: Extract<Entry, { kind: 'team' }> = {
      id: 'e1',
      kind: 'team',
      dispatchId: 'd',
      requested: 1,
      runs: [
        {
          label: 'a',
          description: 'd',
          tier: 'main',
          phase: 'queued',
          turns: 0,
          toolCalls: 0,
          usage: { inputTokens: 0, outputTokens: 0 },
          filesTouched: [],
          messagesSent: 0,
        },
      ],
      aborted: false,
      active: true,
    };
    const advanced: Extract<Entry, { kind: 'team' }> = {
      ...base,
      runs: [{ ...base.runs[0]!, phase: 'tool', toolCalls: 3 }],
    };
    const finished: Extract<Entry, { kind: 'team' }> = { ...advanced, active: false };
    const set = new Set([base, advanced, finished].map(entryRevision));
    expect(set.size).toBe(3);
  });

  it('changes when a todo card advances', () => {
    const base: Extract<Entry, { kind: 'todo' }> = {
      id: 'e1',
      kind: 'todo',
      items: [{ content: 'a', activeForm: 'a', status: 'pending' }],
      doneCount: 0,
      total: 1,
      live: true,
    };
    const done: Extract<Entry, { kind: 'todo' }> = { ...base, doneCount: 1 };
    const settled: Extract<Entry, { kind: 'todo' }> = { ...done, live: false };
    expect(new Set([base, done, settled].map(entryRevision)).size).toBe(3);
  });

  it('is O(1) rather than a hash of the content', () => {
    // A hash of a 256 KiB string once per entry per frame would recreate the very
    // cost the module exists to remove. Two different long texts of the SAME
    // length are allowed to collide; two of different lengths are not.
    const a: Extract<Entry, { kind: 'assistant' }> = {
      id: 'e1',
      kind: 'assistant',
      text: 'a'.repeat(1000),
      thinkingOpen: false,
      streaming: false,
    };
    const b: Extract<Entry, { kind: 'assistant' }> = { ...a, text: 'b'.repeat(1000) };
    const c: Extract<Entry, { kind: 'assistant' }> = { ...a, text: 'a'.repeat(1001) };
    expect(entryRevision(a)).toBe(entryRevision(b));
    expect(entryRevision(a)).not.toBe(entryRevision(c));
  });
});

describe('heightKey (V-5)', () => {
  const entry: Entry = { id: 'e1', kind: 'user', text: 'x' };

  it('changes with cols, so a resize invalidates every cached height', () => {
    expect(heightKey(entry, 80, false, 'comfortable')).not.toBe(
      heightKey(entry, 120, false, 'comfortable'),
    );
  });

  it('changes with expansion, density and the flag string', () => {
    const base = heightKey(entry, 80, false, 'comfortable');
    expect(heightKey(entry, 80, true, 'comfortable')).not.toBe(base);
    expect(heightKey(entry, 80, false, 'compact')).not.toBe(base);
    expect(heightKey(entry, 80, false, 'comfortable', 't')).not.toBe(base);
  });
});

describe('estimateEntryRows', () => {
  it('is monotone (non-increasing) in cols', () => {
    const entry: Entry = { id: 'e1', kind: 'user', text: 'x'.repeat(500) };
    const narrow = estimateEntryRows(entry, 40, 'comfortable', false);
    const wide = estimateEntryRows(entry, 200, 'comfortable', false);
    expect(wide).toBeLessThanOrEqual(narrow);
  });

  it('counts hard newlines as well as wraps', () => {
    const entry: Entry = { id: 'e1', kind: 'user', text: 'a\nb\nc' };
    expect(estimateEntryRows(entry, 200, 'compact', false)).toBe(3);
  });

  it('never returns zero for any kind', () => {
    const kinds: Entry[] = [
      { id: '1', kind: 'user', text: '' },
      { id: '2', kind: 'notice', level: 'info', text: '' },
      { id: '3', kind: 'assistant', text: '', thinkingOpen: false, streaming: true },
      { id: '4', kind: 'tool', toolCallId: 'c', name: 'bash', label: 'bash', argsRaw: '', status: 'pending' },
      { id: '5', kind: 'team', dispatchId: 'd', requested: 0, runs: [], aborted: false, active: false },
      { id: '6', kind: 'todo', items: [], doneCount: 0, total: 0, live: false },
    ];
    for (const e of kinds) {
      expect(estimateEntryRows(e, 80, 'compact', false), e.kind).toBeGreaterThan(0);
    }
  });

  it('estimates a patch card from the PATCH, not the one-line preview', () => {
    // A patch-bearing entry's stored preview is one line (D-19), so estimating
    // from it would report a 3-row card for a 12-row diff — an UNDER-estimate,
    // which is the direction this module names as unsafe.
    const entry: Entry = {
      id: 'e1',
      kind: 'tool',
      toolCallId: 'c1',
      name: 'edit_file',
      label: 'Edit File',
      argsRaw: '{}',
      status: 'done',
      preview: 'Applied edit to a.ts:',
      patch: {
        path: 'a.ts',
        kind: 'update',
        added: 10,
        removed: 10,
        hunks: [
          { oldStart: 1, oldCount: 15, newStart: 1, newCount: 15, lines: [] },
          { oldStart: 90, oldCount: 15, newStart: 90, newCount: 15, lines: [] },
        ],
        truncated: false,
        lineCount: 30,
      },
    };
    // header + summary + min(30 rows + 1 separator, 12) + footer
    expect(estimateEntryRows(entry, 80, 'compact', false)).toBe(1 + 1 + 12 + 1);
    // Expanded: all 30 rows plus the one hunk separator.
    expect(estimateEntryRows(entry, 80, 'compact', true)).toBe(1 + 1 + 31 + 1);
  });
});

describe('selectWindow', () => {
  const heightOf = (): number => 1;

  it('mounts only a viewport-sized band plus overscan', () => {
    const list = entries(5000);
    const sel = selectWindow({
      entries: list,
      heightOf,
      viewportRows: 40,
      offset: 2000,
      overscan: VIRTUAL_LIMITS.overscan,
    });
    const mounted = sel.endIndex - sel.startIndex;
    expect(mounted).toBeLessThanOrEqual(40 + 2 * VIRTUAL_LIMITS.overscan + 2);
    expect(sel.totalRows).toBe(5000);
  });

  it('accounts for every row: leading + mounted + trailing === total', () => {
    const list = entries(500);
    const sel = selectWindow({
      entries: list,
      heightOf: uniform(list, 3),
      viewportRows: 30,
      offset: 90,
      overscan: 2,
    });
    const mountedRows = (sel.endIndex - sel.startIndex) * 3;
    expect(sel.leadingRows + mountedRows + sel.trailingRows).toBe(sel.totalRows);
  });

  it('V-3: the LAST entry is mounted whenever offset is 0, however tall', () => {
    const list = entries(1000);
    const sel = selectWindow({
      entries: list,
      // The tail is a 5 000-row answer; a naive band would leave it out.
      heightOf: (i) => (i === 999 ? 5000 : 1),
      viewportRows: 40,
      offset: 0,
      overscan: 2,
    });
    expect(sel.endIndex).toBe(1000);
    expect(sel.trailingRows).toBe(0);
  });

  it('V-2: raises an overscan below 2 rather than honouring it', () => {
    const list = entries(200);
    const tight = selectWindow({ entries: list, heightOf, viewportRows: 10, offset: 100, overscan: 0 });
    const explicit = selectWindow({ entries: list, heightOf, viewportRows: 10, offset: 100, overscan: 2 });
    expect(tight.startIndex).toBe(explicit.startIndex);
    expect(tight.endIndex).toBe(explicit.endIndex);
  });

  it('mounts the live tail on the first frame, before anything is measured', () => {
    // `viewportRows: 0` is the pre-measure state; falling through to an empty
    // window would paint a blank rectangle and only fill in on the next frame.
    const list = entries(100);
    const sel = selectWindow({ entries: list, heightOf, viewportRows: 0, offset: 0, overscan: 2 });
    expect(sel.endIndex).toBe(100);
    expect(sel.endIndex).toBeGreaterThan(sel.startIndex);
  });

  it('is empty for an empty transcript', () => {
    const sel = selectWindow({ entries: [], heightOf, viewportRows: 40, offset: 0, overscan: 2 });
    expect(sel).toEqual({
      startIndex: 0,
      endIndex: 0,
      leadingRows: 0,
      trailingRows: 0,
      totalRows: 0,
    });
  });
});

/**
 * T-32 / I-13 — the render cap and the height estimate are ONE number.
 *
 * This is I-8's failure relocated from the composer to the transcript, and it is
 * WORSE here: this file's own note records that "an entry estimated at 400 rows is
 * exactly the one that never gets mounted", and an unmounted entry is never
 * measured, so an over-estimate never self-corrects. It stays wrong for the rest
 * of the session, and the only symptom is that one message never appears.
 */
describe('estimateEntryRows — the user entry cap (T-32 / I-13)', () => {
  const huge: Entry = {
    id: 'u1',
    kind: 'user',
    text: Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n'),
  };

  it('caps a 5 000-line message at the cap plus its tail plus separation', () => {
    const rows = estimateEntryRows(huge, 80, 'comfortable', false);
    expect(rows).toBeLessThanOrEqual(USER_ENTRY_MAX_ROWS + 2);
  });

  it('EQUALS what UserEntry actually renders, rather than merely being under 40', () => {
    // Asserted as an EQUALITY, not as two independent ceilings: two numbers that
    // are each "at most 40" can still disagree, and disagreeing is the defect.
    const compact = estimateEntryRows(huge, 80, 'compact', false);
    expect(compact).toBe(userEntryRenderedRows(huge.text.split('\n').length));
  });

  it('leaves an ordinary message untouched', () => {
    const small: Entry = { id: 'u2', kind: 'user', text: 'one\ntwo\nthree' };
    expect(estimateEntryRows(small, 80, 'compact', false)).toBe(3);
    expect(estimateEntryRows(small, 80, 'compact', false)).toBe(
      userEntryRenderedRows(small.text.split('\n').length),
    );
  });

  it('is still an upper bound on a message wide enough to wrap', () => {
    // The cap must not turn the estimate into an UNDER-estimate for a message
    // whose few logical lines wrap into many rows: that is the failure the
    // file own "upper bound rather than best guess" note rules out.
    const wide: Entry = { id: 'u3', kind: 'user', text: 'x'.repeat(300) };
    expect(estimateEntryRows(wide, 40, 'compact', false)).toBeGreaterThan(1);
  });
});


describe('document footer projection', () => {
  it('projects the footer into the visible message interval before overscan', () => {
    const base = { entries: entries(100), heightOf: () => 1, viewportRows: 20,
      overscan: 2, trailingContentRows: 6 };
    expect(selectWindow({ ...base, offset: 0 }))
      .toMatchObject({ startIndex: 84, endIndex: 100 });
    expect(selectWindow({ ...base, offset: 10 }))
      .toMatchObject({ startIndex: 74, endIndex: 98 });
  });
  it('keeps only the tail overscan when the editor fills the visible interval', () => {
    const result = selectWindow({ entries: entries(10000), heightOf: () => 1,
      viewportRows: 20, offset: 0, overscan: 2, trailingContentRows: 50 });
    expect(result.endIndex - result.startIndex).toBeLessThanOrEqual(3);
  });
});
