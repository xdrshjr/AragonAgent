/** Confirmation window for two independent decoded Escape events. */
export const INTERRUPT_CONFIRM_MS = 1500;

export type InterruptGestureState =
  | { phase: 'ready' }
  | { phase: 'armed'; armedAt: number }
  | { phase: 'stopping' };

export interface InterruptGestureResult {
  state: InterruptGestureState;
  action: 'hint' | 'abort' | 'force-stop';
}

/** Advance using a monotonic clock; the caller owns the current run's lifetime. */
export function advanceInterruptGesture(
  state: InterruptGestureState, now: number,
): InterruptGestureResult {
  if (state.phase === 'stopping') {
    return { state: { phase: 'ready' }, action: 'force-stop' };
  }
  if (state.phase === 'armed') {
    const elapsed = now - state.armedAt;
    if (elapsed >= 0 && elapsed <= INTERRUPT_CONFIRM_MS) {
      return { state: { phase: 'stopping' }, action: 'abort' };
    }
  }
  return { state: { phase: 'armed', armedAt: now }, action: 'hint' };
}

/** Other input cancels confirmation, but cannot undo an already requested stop. */
export function cancelInterruptConfirmation(state: InterruptGestureState): InterruptGestureState {
  return state.phase === 'armed' ? { phase: 'ready' } : state;
}
