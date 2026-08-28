/**
 * The retry card in the view reducer (llm-api-retry-backoff §11,
 * AC-21...AC-25b).
 *
 * The two cases that matter most are AC-22 (the removal must not touch anything at
 * or below `Transcript`'s settled boundary, or `<Static>` duplicates the live
 * entry) and AC-25b (the ENGINE aborts itself, and that path reaches `runEnd`
 * with no `abortMark`, no `turn_end` and no error notice — a card left unsettled
 * there re-renders the whole tail every frame for the rest of the session).
 */

import { describe, expect, it } from 'vitest';
import type { StreamEvent, TokenUsage } from '@aragon-agent/core';
import {
  initialViewState,
  reduceEvent,
  viewReducer,
  type Entry,
  type ViewAction,
  type ViewState,
} from '../agent/reducer.js';
import { computeSettledCount } from '../ui/Transcript.js';

const usage: TokenUsage = { inputTokens: 1, outputTokens: 2 };

function apply(state: ViewState, ...actions: ViewAction[]): ViewState {
  return actions.reduce(viewReducer, state);
}

function scheduled(attempt: number, resumeAt = 1_000): ViewAction {
  return {
    type: 'retryScheduled',
    attempt,
    maxRetries: 10,
    delayMs: 1000,
    resumeAt,
    errorType: 'overloaded',
    message: 'anthropic API error 529: overloaded',
  };
}

function retryEntry(state: ViewState): Extract<Entry, { kind: 'retry' }> | undefined {
  return state.entries.find((e): e is Extract<Entry, { kind: 'retry' }> => e.kind === 'retry');
}

/** A turn far enough along to have a streaming assistant entry and a tool card. */
function midTurn(): ViewState {
  return apply(
    initialViewState(),
    { type: 'submit', text: 'hello' },
    { type: 'runStart' },
    { type: 'turnStart' },
    { type: 'textDelta', delta: 'partial answer' },
    { type: 'toolCallStart', toolCallId: 't1', toolName: 'read_file' },
    { type: 'toolCallStart', toolCallId: 't2', toolName: 'bash' },
  );
}

// ---------------------------------------------------------------------------
// Event mapping
// ---------------------------------------------------------------------------

describe('reduceEvent maps the three retry stream events', () => {
  const wrap = (streamEvent: StreamEvent): ViewAction[] =>
    reduceEvent({ type: 'message_update', streamEvent });

  it('maps retry_scheduled with every field', () => {
    expect(
      wrap({
        type: 'retry_scheduled',
        attempt: 2,
        maxRetries: 10,
        delayMs: 2000,
        resumeAt: 5000,
        errorType: 'rate_limit',
        message: 'slow down',
      }),
    ).toEqual([
      {
        type: 'retryScheduled',
        attempt: 2,
        maxRetries: 10,
        delayMs: 2000,
        resumeAt: 5000,
        errorType: 'rate_limit',
        message: 'slow down',
      },
    ]);
  });

  it('maps retry_attempt and stream_restart', () => {
    expect(wrap({ type: 'retry_attempt', attempt: 3, maxRetries: 10 })).toEqual([
      { type: 'retryAttempt', attempt: 3, maxRetries: 10 },
    ]);
    expect(
      wrap({ type: 'stream_restart', attempt: 1, discardedToolCallIds: ['t1'] }),
    ).toEqual([{ type: 'streamRestart', discardedToolCallIds: ['t1'] }]);
  });
});

// ---------------------------------------------------------------------------
// AC-21 — one card per turn
// ---------------------------------------------------------------------------

describe('one card per turn, rewritten in place (AC-21)', () => {
  it('three retry_scheduled events produce ONE entry with attempt 3', () => {
    const state = apply(midTurn(), scheduled(1), scheduled(2), scheduled(3));
    const cards = state.entries.filter((e) => e.kind === 'retry');
    expect(cards).toHaveLength(1);
    expect(retryEntry(state)).toMatchObject({ attempt: 3, phase: 'waiting', maxRetries: 10 });
    expect(state.retry).toMatchObject({ attempt: 3, phase: 'waiting' });
  });

  it('startedAt is the FIRST retry, so elapsedMs measures the whole ladder', () => {
    const first = apply(midTurn(), scheduled(1));
    const startedAt = retryEntry(first)!.startedAt;
    const later = apply(first, scheduled(2), scheduled(3));
    expect(retryEntry(later)!.startedAt).toBe(startedAt);
  });

  it('retryAttempt clears the countdown but keeps the counter', () => {
    const state = apply(midTurn(), scheduled(2), { type: 'retryAttempt', attempt: 2, maxRetries: 10 });
    expect(retryEntry(state)).toMatchObject({ phase: 'retrying', attempt: 2 });
    expect(retryEntry(state)!.resumeAt).toBeUndefined();
    expect(state.retry).toMatchObject({ phase: 'retrying' });
    expect(state.retry?.resumeAt).toBeUndefined();
  });

  it('a new turn gets its own card and leaves the previous one where it is', () => {
    const settled = apply(
      midTurn(),
      scheduled(1),
      { type: 'turnEnd', usage, costDelta: 0 },
      { type: 'runEnd' },
    );
    const next = apply(settled, { type: 'submit', text: 'again' }, { type: 'runStart' },
      { type: 'turnStart' }, scheduled(1));
    expect(next.entries.filter((e) => e.kind === 'retry')).toHaveLength(2);
    // History is not retracted: the first card keeps its settled phase.
    const cards = next.entries.filter((e): e is Extract<Entry, { kind: 'retry' }> => e.kind === 'retry');
    expect(cards[0]?.phase).toBe('recovered');
    expect(cards[1]?.phase).toBe('waiting');
  });

  it('retryAttempt with no card is a no-op rather than a crash', () => {
    const state = midTurn();
    expect(apply(state, { type: 'retryAttempt', attempt: 1, maxRetries: 10 })).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// AC-22 — the rewind
// ---------------------------------------------------------------------------

describe('streamRestart rewinds the view (AC-22)', () => {
  it('clears the streaming text and removes exactly the named tool cards', () => {
    const before = apply(midTurn(), { type: 'thinkingStart' }, { type: 'thinkingDelta', delta: 'hmm' });
    const after = apply(before, { type: 'streamRestart', discardedToolCallIds: ['t1'] });

    const assistant = after.entries.find((e) => e.kind === 'assistant');
    expect(assistant).toMatchObject({ text: '', thinkingOpen: false });
    expect((assistant as { thinking?: string }).thinking).toBeUndefined();

    const toolIds = after.entries.filter((e) => e.kind === 'tool').map((e) => (e as { toolCallId: string }).toolCallId);
    expect(toolIds).toEqual(['t2']);
  });

  it('leaves EARLIER turns untouched', () => {
    const firstTurn = apply(
      initialViewState(),
      { type: 'submit', text: 'one' },
      { type: 'runStart' },
      { type: 'turnStart' },
      { type: 'textDelta', delta: 'kept' },
      { type: 'toolCallStart', toolCallId: 'old', toolName: 'bash' },
      { type: 'turnEnd', usage, costDelta: 0 },
      { type: 'runEnd' },
    );
    const secondTurn = apply(
      firstTurn,
      { type: 'submit', text: 'two' },
      { type: 'runStart' },
      { type: 'turnStart' },
      { type: 'textDelta', delta: 'partial' },
      { type: 'toolCallStart', toolCallId: 'new', toolName: 'bash' },
      { type: 'streamRestart', discardedToolCallIds: ['new'] },
    );
    const toolIds = secondTurn.entries
      .filter((e) => e.kind === 'tool')
      .map((e) => (e as { toolCallId: string }).toolCallId);
    expect(toolIds).toEqual(['old']);
    const kept = secondTurn.entries.filter((e) => e.kind === 'assistant');
    expect(kept[0]).toMatchObject({ text: 'kept' });
    expect(kept[1]).toMatchObject({ text: '' });
  });

  it('does not move Transcript\'s settled boundary', () => {
    /**
     * THE PROPERTY THAT KEEPS `<Static>` FROM DUPLICATING THE LIVE ENTRY.
     *
     * `Transcript` clamps with a MONOTONIC high-water mark, so if `highWater` ever
     * exceeded `entries.length` the clamp would mark EVERYTHING settled — including
     * the still-streaming assistant entry. It cannot, because the entries this
     * action removes were created AFTER the streaming entry and the boundary scan
     * already breaks at that entry. Asserting the boundary here is what forces the
     * next action that shrinks `entries` to argue with a test.
     */
    const before = apply(
      initialViewState(),
      { type: 'submit', text: 'one' },
      { type: 'runStart' },
      { type: 'turnStart' },
      { type: 'textDelta', delta: 'a' },
      { type: 'turnEnd', usage, costDelta: 0 },
      { type: 'runEnd' },
      { type: 'submit', text: 'two' },
      { type: 'runStart' },
      { type: 'turnStart' },
      { type: 'textDelta', delta: 'partial' },
      { type: 'toolCallStart', toolCallId: 'x', toolName: 'bash' },
    );
    const boundaryBefore = computeSettledCount(before.entries, before.expandedToolIds);
    const after = apply(before, { type: 'streamRestart', discardedToolCallIds: ['x'] });
    const boundaryAfter = computeSettledCount(after.entries, after.expandedToolIds);

    expect(boundaryAfter).toBe(boundaryBefore);
    expect(boundaryAfter).toBeLessThanOrEqual(after.entries.length);
  });

  it('an in-flight retry card is NOT settled by the boundary scan', () => {
    const state = apply(midTurn(), scheduled(1));
    // The card is the tail here, but the property being pinned is that a `waiting`
    // card can never be inside the settled prefix at all.
    const settled = computeSettledCount(state.entries, state.expandedToolIds);
    const prefix = state.entries.slice(0, settled);
    expect(prefix.some((e) => e.kind === 'retry')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC-23 / AC-24 / AC-25 / AC-25b — the four settle paths
// ---------------------------------------------------------------------------

describe('turnEnd settles to recovered (AC-23)', () => {
  it('records the retry count and nulls the projection', () => {
    const state = apply(midTurn(), scheduled(1), scheduled(2), { type: 'turnEnd', usage, costDelta: 0 });
    expect(retryEntry(state)).toMatchObject({ phase: 'recovered', totalRetries: 2 });
    expect(retryEntry(state)!.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(retryEntry(state)!.resumeAt).toBeUndefined();
    expect(state.retry).toBeNull();
    expect(state.retryEntryId).toBeUndefined();
  });

  it('leaves the usage accounting exactly as it was', () => {
    const withRetry = apply(midTurn(), scheduled(1), { type: 'turnEnd', usage, costDelta: 1.5 });
    const without = apply(midTurn(), { type: 'turnEnd', usage, costDelta: 1.5 });
    expect(withRetry.usageTotal).toEqual(without.usageTotal);
    expect(withRetry.contextTokens).toEqual(without.contextTokens);
    expect(withRetry.turnProduced).toBe(true);
  });
});

describe('a terminal error notice settles to exhausted (AC-24)', () => {
  it('marks the card and does not additionally fire the generic run-failure guard', () => {
    const errored = apply(
      midTurn(),
      scheduled(10),
      { type: 'notice', level: 'error', text: 'Provider overloaded - please retry shortly.' },
    );
    expect(retryEntry(errored)).toMatchObject({ phase: 'exhausted', totalRetries: 10 });
    expect(errored.errorNoticed).toBe(true);

    const ended = apply(errored, { type: 'runEnd' });
    // `errorNoticed` is already true, so `GENERIC_RUN_FAILURE` must not be added.
    const notices = ended.entries.filter((e) => e.kind === 'notice');
    expect(notices).toHaveLength(1);
    expect(retryEntry(ended)).toMatchObject({ phase: 'exhausted' });
  });

  it('a NON-error notice leaves the card alone', () => {
    const state = apply(midTurn(), scheduled(1), { type: 'notice', level: 'info', text: 'fyi' });
    expect(retryEntry(state)).toMatchObject({ phase: 'waiting' });
    expect(state.retry).not.toBeNull();
  });
});

describe('abortMark settles to interrupted (AC-25)', () => {
  it('marks the card, the assistant entry and nulls the projection', () => {
    const state = apply(midTurn(), scheduled(2), { type: 'abortMark' });
    expect(retryEntry(state)).toMatchObject({ phase: 'interrupted', totalRetries: 2 });
    expect(state.retry).toBeNull();
    expect(state.aborted).toBe(true);
    expect(state.entries.find((e) => e.kind === 'assistant')).toMatchObject({ aborted: true });
  });

  it('still works when nothing is streaming', () => {
    const noStream = apply(
      initialViewState(),
      { type: 'submit', text: 'x' },
      { type: 'runStart' },
      scheduled(1),
      { type: 'abortMark' },
    );
    expect(retryEntry(noStream)).toMatchObject({ phase: 'interrupted' });
    expect(noStream.aborted).toBe(true);
  });
});

describe('runEnd is the terminal backstop (AC-25b)', () => {
  it('settles a waiting card with NO abortMark, error notice or turnEnd', () => {
    /**
     * THE ENGINE'S OWN WATCHDOG PATH. `Agent`'s idle watchdog calls
     * `Agent.abort()` directly, the run unwinds, and the UI sees `agent_end` ->
     * `runEnd` with none of the three signals the other settle rules key on.
     * `abortMark` is dispatched ONLY from the Esc handler.
     */
    const state = apply(midTurn(), scheduled(2), { type: 'runEnd' });

    expect(retryEntry(state)).toMatchObject({ phase: 'interrupted', totalRetries: 2 });
    expect(state.retry).toBeNull();
    // THIS is what lets `Transcript`'s monotonic boundary advance past the card.
    expect(state.retryEntryId).toBeUndefined();
    expect(state.status).toBe('idle');
  });

  it('lets the settled card reach the settled prefix afterwards', () => {
    // NO PENDING TOOL CARDS in this one: the boundary scan breaks at the first
    // unsettled entry of ANY kind, and `midTurn`'s two `pending` tool cards would
    // stop it before the retry card is even reached — which would make this assert
    // nothing about the retry card at all.
    const state = apply(
      initialViewState(),
      { type: 'submit', text: 'hello' },
      { type: 'runStart' },
      { type: 'turnStart' },
      { type: 'textDelta', delta: 'partial' },
      scheduled(1),
      { type: 'runEnd' },
      // One more entry so the card is no longer inside `LIVE_TAIL`.
      { type: 'notice', level: 'info', text: 'after' },
    );
    const settled = computeSettledCount(state.entries, state.expandedToolIds);
    const prefix = state.entries.slice(0, settled);
    expect(prefix.some((e) => e.kind === 'retry')).toBe(true);
  });

  it('does not double-settle a card an earlier path already closed', () => {
    const viaTurnEnd = apply(midTurn(), scheduled(3), { type: 'turnEnd', usage, costDelta: 0 });
    const totalBefore = retryEntry(viaTurnEnd)!.totalRetries;
    const ended = apply(viaTurnEnd, { type: 'runEnd' });
    expect(retryEntry(ended)).toMatchObject({ phase: 'recovered', totalRetries: totalBefore });
  });
});

describe('the retry tick', () => {
  it('refreshes the card by IDENTITY so React re-renders exactly one entry', () => {
    // A flat nonce on `ViewState` would not reach `EntryView`, whose memo
    // comparator's first clause is `a.entry === b.entry` — the countdown would
    // freeze at whatever second it was first drawn on.
    const state = apply(midTurn(), scheduled(1));
    const before = retryEntry(state)!;
    const ticked = apply(state, { type: 'retryTick' });
    const after = retryEntry(ticked)!;
    expect(after).not.toBe(before);
    expect(after).toEqual(before);
  });

  it('is a no-op when nothing is waiting, so a stray tick costs no render', () => {
    const retrying = apply(midTurn(), scheduled(1), { type: 'retryAttempt', attempt: 1, maxRetries: 10 });
    expect(apply(retrying, { type: 'retryTick' })).toBe(retrying);
    const idle = initialViewState();
    expect(apply(idle, { type: 'retryTick' })).toBe(idle);
  });
});

describe('clear / reset / restore drop the card reference', () => {
  it('/clear drops both the id and the projection', () => {
    const state = apply(midTurn(), scheduled(1), { type: 'clearTranscript' });
    expect(state.retryEntryId).toBeUndefined();
    expect(state.retry).toBeNull();
    expect(state.entries).toEqual([]);
  });

  it('/reset drops both', () => {
    const state = apply(midTurn(), scheduled(1), { type: 'resetConversation' });
    expect(state.retryEntryId).toBeUndefined();
    expect(state.retry).toBeNull();
  });

  it('/resume drops both', () => {
    const restored: Entry[] = [
      {
        id: 'e1',
        kind: 'retry',
        attempt: 2,
        maxRetries: 10,
        errorType: 'overloaded',
        message: 'x',
        delayMs: 1000,
        phase: 'interrupted',
        startedAt: 1,
        totalRetries: 2,
      },
    ];
    const state = apply(initialViewState(), { type: 'restoreEntries', entries: restored });
    expect(state.retryEntryId).toBeUndefined();
    expect(state.retry).toBeNull();
    expect(state.entries).toHaveLength(1);
  });
});
