import { describe, expect, it } from 'vitest';
import {
  GOVERNOR_DOWN_STREAK,
  GOVERNOR_LADDER,
  GOVERNOR_UP_RATIO,
  initialGovernor,
  intervalOf,
  stepGovernor,
  type GovernorState,
} from '../ui/render-governor.js';
import { mergeDeltas } from '../agent/coalesce.js';
import { initialViewState, viewReducer, type ViewAction } from '../agent/reducer.js';

const MAX = 320;

/** Feed `n` commits of `cost` ms through the ladder. */
function drive(state: GovernorState, cost: number, n: number, max = MAX): GovernorState {
  let next = state;
  for (let i = 0; i < n; i += 1) next = stepGovernor(next, cost, max);
  return next;
}

describe('intervalOf', () => {
  it('starts at the pre-feature 33 ms', () => {
    expect(intervalOf(initialGovernor(), MAX)).toBe(GOVERNOR_LADDER[0]);
  });

  it('clamps to maxIntervalMs, so 33 flattens the ladder', () => {
    // The documented way to get the pre-feature cadence WITHOUT the kill switch.
    for (let rung = 0; rung < GOVERNOR_LADDER.length; rung += 1) {
      expect(intervalOf({ rung, cheapStreak: 0 }, 33)).toBe(33);
    }
  });

  it('never returns a rung above the ceiling', () => {
    expect(intervalOf({ rung: 99, cheapStreak: 0 }, 125)).toBe(125);
  });
});

describe('stepGovernor', () => {
  it('steps up when a commit costs more than the up-ratio of the interval', () => {
    const cost = GOVERNOR_LADDER[0]! * GOVERNOR_UP_RATIO + 1;
    const next = stepGovernor(initialGovernor(), cost, MAX);
    expect(next.rung).toBe(1);
    expect(intervalOf(next, MAX)).toBe(GOVERNOR_LADDER[1]);
  });

  it('does not step up on a cheap frame', () => {
    expect(stepGovernor(initialGovernor(), 1, MAX).rung).toBe(0);
  });

  it('needs a streak of cheap frames before stepping down (hysteresis)', () => {
    let state = drive(initialGovernor(), 1000, 3, MAX);
    expect(state.rung).toBe(3);
    // One cheap frame short of the streak: still at rung 3.
    state = drive(state, 0, GOVERNOR_DOWN_STREAK - 1, MAX);
    expect(state.rung).toBe(3);
    state = stepGovernor(state, 0, MAX);
    expect(state.rung).toBe(2);
  });

  it('saturates at the top of the ladder rather than running away', () => {
    const state = drive(initialGovernor(), 100_000, 50, MAX);
    expect(state.rung).toBe(GOVERNOR_LADDER.length - 1);
    expect(intervalOf(state, MAX)).toBe(MAX);
  });

  it('returns to rung 0 within about a second of the load ending (K-7)', () => {
    let state = drive(initialGovernor(), 100_000, 20, MAX);
    // 5 rungs down, GOVERNOR_DOWN_STREAK cheap frames each; at the top rung's
    // 320 ms cadence that is well under two seconds of wall clock.
    state = drive(state, 0, GOVERNOR_DOWN_STREAK * GOVERNOR_LADDER.length, MAX);
    expect(state.rung).toBe(0);
  });

  it('cannot leave rung 0 when the ceiling flattens the ladder', () => {
    expect(drive(initialGovernor(), 100_000, 20, 33).rung).toBe(0);
  });

  it('treats a non-finite cost as free rather than throwing', () => {
    expect(stepGovernor(initialGovernor(), Number.NaN, MAX).rung).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// I-L4-1 / AC-6 — the rung must not change the final ViewState
// ---------------------------------------------------------------------------

describe('I-L4-1: the governor changes only HOW OFTEN, never WHAT', () => {
  const events: ViewAction[] = [
    { type: 'submit', text: 'hi' },
    { type: 'runStart' },
    { type: 'turnStart' },
    { type: 'thinkingDelta', delta: 'pon' },
    { type: 'thinkingDelta', delta: 'der' },
    { type: 'textDelta', delta: 'Hel' },
    { type: 'textDelta', delta: 'lo ' },
    { type: 'toolCallStart', toolCallId: 'c1', toolName: 'bash' },
    { type: 'textDelta', delta: 'wor' },
    { type: 'textDelta', delta: 'ld' },
    { type: 'toolExecStart', toolCallId: 'c1' },
    { type: 'toolExecEnd', toolCallId: 'c1', isError: false, duration: 5, preview: 'ok' },
    { type: 'turnEnd', usage: { inputTokens: 1, outputTokens: 2 }, costDelta: 0 },
    { type: 'runEnd' },
  ];

  /**
   * Reproduce `App`'s coalescer for a given flush size: deltas accumulate and
   * are merged, any non-delta flushes the pending run first. A longer interval
   * is exactly a larger `batch`.
   */
  function replay(batch: number): ReturnType<typeof viewReducer> {
    let state = initialViewState();
    let pending: ViewAction[] = [];
    const flush = (): void => {
      if (pending.length === 0) return;
      for (const action of mergeDeltas(pending)) state = viewReducer(state, action);
      pending = [];
    };
    for (const event of events) {
      if (event.type === 'textDelta' || event.type === 'thinkingDelta') {
        pending.push(event);
        if (pending.length >= batch) flush();
      } else {
        flush();
        state = viewReducer(state, event);
      }
    }
    flush();
    return state;
  }

  it('produces the same final ViewState at every rung (AC-6)', () => {
    const baseline = replay(1);
    for (const batch of [2, 3, 5, 8, 13, 100]) {
      const other = replay(batch);
      expect(other.entries, `batch=${batch}`).toEqual(baseline.entries);
      expect(other.usageTotal, `batch=${batch}`).toEqual(baseline.usageTotal);
      expect(other.status, `batch=${batch}`).toBe(baseline.status);
    }
  });
});

/**
 * The same property, extended to the third merged kind
 * (agent-activity-presentation-live §3.3.2 / D-34).
 *
 * `toolOutputDelta` is the first action to join `textDelta` / `thinkingDelta` in
 * `pending.current`, so the governor's ladder now reorders it too — and I-L4-1
 * says the rung may change HOW OFTEN the view updates, never what is dispatched
 * and never the order.
 *
 * ONE FIELD IS DELIBERATELY EXEMPT, and saying so is the point of the helper
 * below: `liveSeq` is a RENDER-INVALIDATION COUNTER, not content. It counts
 * dispatched tail updates, so a batch of eight chunks merged into one action
 * legitimately advances it once where eight separate ones advance it eight
 * times. That difference is invisible on screen — the tail, the stall clock and
 * every rendered row are identical — and comparing it would pin the ladder
 * rather than the semantics.
 */
describe('I-L4-1 extends to toolOutputDelta (D-34)', () => {
  const tail = (rows: string[], at: number): ViewAction => ({
    type: 'toolOutputDelta',
    toolCallId: 'c1',
    rows,
    at,
  });

  const events: ViewAction[] = [
    { type: 'submit', text: 'run the build' },
    { type: 'runStart' },
    { type: 'turnStart' },
    { type: 'textDelta', delta: 'Runn' },
    { type: 'textDelta', delta: 'ing it' },
    { type: 'toolCallStart', toolCallId: 'c1', toolName: 'bash' },
    { type: 'toolExecStart', toolCallId: 'c1' },
    tail(['step 1'], 1_000),
    tail(['step 1', 'step 2'], 1_100),
    { type: 'textDelta', delta: ' (still' },
    tail(['step 2', 'step 3'], 1_200),
    tail(['step 3', 'step 4'], 1_300),
    { type: 'textDelta', delta: ' going)' },
    tail(['step 4', 'step 5'], 1_400),
    { type: 'toolExecEnd', toolCallId: 'c1', isError: false, duration: 9, preview: 'ok' },
    { type: 'turnEnd', usage: { inputTokens: 1, outputTokens: 2 }, costDelta: 0 },
  ];

  /** App's real buffer: the three streaming kinds in, everything else straight through. */
  function replay(batch: number): ReturnType<typeof viewReducer> {
    let state = initialViewState();
    let pending: ViewAction[] = [];
    const flush = (): void => {
      if (pending.length === 0) return;
      for (const action of mergeDeltas(pending)) state = viewReducer(state, action);
      pending = [];
    };
    for (const event of events) {
      if (
        event.type === 'textDelta' ||
        event.type === 'thinkingDelta' ||
        event.type === 'toolOutputDelta'
      ) {
        pending.push(event);
        if (pending.length >= batch) flush();
      } else {
        flush();
        state = viewReducer(state, event);
      }
    }
    flush();
    return state;
  }

  const withoutSeq = (state: ReturnType<typeof viewReducer>) =>
    state.entries.map((e) => (e.kind === 'tool' ? { ...e, liveSeq: undefined } : e));

  it('produces the same rendered entries at every rung', () => {
    const baseline = withoutSeq(replay(1));
    for (const batch of [2, 3, 5, 8, 13, 100]) {
      expect(withoutSeq(replay(batch)), `batch=${batch}`).toEqual(baseline);
    }
  });

  it('settles the tail identically at every rung, whatever the batching', () => {
    for (const batch of [1, 4, 100]) {
      const card = replay(batch).entries.find((e) => e.kind === 'tool');
      expect(card?.kind === 'tool' && card.live, `batch=${batch}`).toBeUndefined();
      expect(card?.kind === 'tool' && card.preview, `batch=${batch}`).toBe('ok');
    }
  });

  it('advances `liveSeq` on every rung, which is what the height cache watches', () => {
    // Exempt from the equality above, but NOT allowed to stop moving: a rung at
    // which the counter never advanced would be one where the card froze.
    for (const batch of [1, 4, 100]) {
      const card = replay(batch).entries.find((e) => e.kind === 'tool');
      expect(card?.kind === 'tool' && (card.liveSeq ?? 0), `batch=${batch}`).toBeGreaterThan(0);
    }
  });

  it('never lets a tail overtake a token, at any rung', () => {
    // The ordering half of I-L4-1: the assistant text is assembled in one piece
    // whatever the interleaving, because `mergeDeltas` flushes across kinds.
    for (const batch of [1, 2, 5, 100]) {
      const assistant = replay(batch).entries.find((e) => e.kind === 'assistant');
      expect(assistant?.kind === 'assistant' && assistant.text, `batch=${batch}`).toBe(
        'Running it (still going)',
      );
    }
  });
});
