/**
 * Streaming delta coalescer (spec §3.8). Pure: merges a run of consecutive
 * `textDelta` / `thinkingDelta` view actions into a single action of the same
 * kind while preserving order — any non-delta action (a tool call, `turnEnd`,
 * `runEnd`, `notice`) flushes the pending run first, so `text, tool, text`
 * stays `text, tool, text` and is never reordered.
 *
 * App buffers per-event actions and runs them through this before dispatching,
 * so a fast token stream re-renders the transcript once per frame instead of
 * once per token. The reducer and event semantics are unchanged.
 *
 * A THIRD MERGED KIND ARRIVED WITH THE LIVE TOOL TAIL
 * (agent-activity-presentation-live §3.3.2 / D-30), and it merges differently:
 * `toolOutputDelta` carries the store's WHOLE tail rather than an increment, so
 * consecutive ones with the same `toolCallId` collapse to the LAST rather than
 * concatenating, and a differing id starts a new pending action because merging
 * across ids would paint one command's output onto another's card.
 *
 * ONE PENDING SLOT, DISCRIMINATED, NEVER TWO (P1-5). A second, independent slot
 * for the object-shaped payload would let a chunk overtake a token and reorder
 * the two streams — exactly what I-L4-1 (`ui/render-governor.ts:14-19`) forbids:
 * "the governor changes only HOW OFTEN the view updates. Never what is
 * dispatched, never the order."
 */

import type { ViewAction } from './reducer.js';

type DeltaType = 'textDelta' | 'thinkingDelta';
type TextDelta = { type: DeltaType; delta: string };
type ToolOutputDelta = Extract<ViewAction, { type: 'toolOutputDelta' }>;
/** The single pending slot: a text run, a tool tail, or nothing. */
type Pending = { kind: 'text'; action: TextDelta } | { kind: 'tool'; action: ToolOutputDelta };

function isTextDelta(action: ViewAction): action is TextDelta {
  return action.type === 'textDelta' || action.type === 'thinkingDelta';
}

function isToolOutputDelta(action: ViewAction): action is ToolOutputDelta {
  return action.type === 'toolOutputDelta';
}

/** Merge consecutive same-kind deltas; flush on kind change or a non-delta. */
export function mergeDeltas(actions: ViewAction[]): ViewAction[] {
  const out: ViewAction[] = [];
  let pending: Pending | null = null;

  const flush = () => {
    if (pending !== null) {
      out.push(pending.action);
      pending = null;
    }
  };

  for (const action of actions) {
    // Read into a local before the branch: `flush` clears the slot, so the value
    // a merge decision needs is the one held HERE, before any flush.
    //
    // The assertion restores the DECLARED type and asserts nothing beyond it.
    // `flush` assigns `pending = null` from inside a closure, which TypeScript's
    // flow analysis does not model, so it pins the reference at this point to
    // the declaration's `null` and every `prev.kind` below reads as `never`.
    const prev = pending as Pending | null;
    if (isTextDelta(action)) {
      // A pending TOOL tail flushes first, so a chunk cannot overtake a token.
      const carry: string | null =
        prev !== null && prev.kind === 'text' && prev.action.type === action.type
          ? prev.action.delta
          : null;
      if (carry === null) flush();
      pending = {
        kind: 'text',
        action: { type: action.type, delta: (carry ?? '') + action.delta },
      };
    } else if (isToolOutputDelta(action)) {
      // A pending TEXT run flushes first, for the mirror-image reason, and so
      // does a tail belonging to a DIFFERENT call: merging across ids would
      // paint one command's output onto another's card.
      const merges =
        prev !== null && prev.kind === 'tool' && prev.action.toolCallId === action.toolCallId;
      if (!merges) flush();
      // LAST WINS. The payload is the store's whole tail rather than an
      // increment, so merging means replacing (D-30).
      pending = { kind: 'tool', action };
    } else {
      flush();
      out.push(action);
    }
  }
  flush();
  return out;
}
