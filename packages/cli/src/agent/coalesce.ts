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
 */

import type { ViewAction } from './reducer.js';

type DeltaType = 'textDelta' | 'thinkingDelta';

function isDelta(action: ViewAction): action is { type: DeltaType; delta: string } {
  return action.type === 'textDelta' || action.type === 'thinkingDelta';
}

/** Merge consecutive same-kind deltas; flush on kind change or a non-delta. */
export function mergeDeltas(actions: ViewAction[]): ViewAction[] {
  const out: ViewAction[] = [];
  let pendingType: DeltaType | null = null;
  let pendingDelta = '';

  const flush = () => {
    if (pendingType !== null) {
      out.push({ type: pendingType, delta: pendingDelta });
      pendingType = null;
      pendingDelta = '';
    }
  };

  for (const action of actions) {
    if (isDelta(action)) {
      if (pendingType !== null && pendingType !== action.type) flush();
      pendingType = action.type;
      pendingDelta += action.delta;
    } else {
      flush();
      out.push(action);
    }
  }
  flush();
  return out;
}
