/**
 * "Sticky follow" for the transcript, as pure functions (no DOM, so it is testable without layout).
 *
 * The rule: the view follows the tail until the USER scrolls away from it. Two things must not
 * count as the user scrolling away, or the transcript would stop following on its own:
 *   - content growing under a fixed `scrollTop` (a streaming token) - no scroll event fires at
 *     all, so nothing here runs;
 *   - our own `scrollTo(bottom)` - its scroll event lands at the bottom, i.e. "near bottom".
 * A scroll event that moves UP and ends away from the bottom is the only thing that pauses it.
 */

export interface ScrollMetrics {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

export interface FollowState {
  following: boolean;
  /** `scrollTop` at the previous event, to tell "moved up" from "content moved under us". */
  lastTop: number;
}

/** How close to the bottom still counts as "at the bottom" (sub-pixel rounding and padding). */
export const NEAR_BOTTOM_PX = 48;

export const INITIAL_FOLLOW: FollowState = { following: true, lastTop: 0 };

export function distanceFromBottom(metrics: ScrollMetrics): number {
  return Math.max(0, metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop);
}

export function isNearBottom(metrics: ScrollMetrics, threshold = NEAR_BOTTOM_PX): boolean {
  return distanceFromBottom(metrics) <= threshold;
}

/** Fold one scroll event into the follow state. */
export function onScroll(state: FollowState, metrics: ScrollMetrics): FollowState {
  if (isNearBottom(metrics)) return { following: true, lastTop: metrics.scrollTop };
  const movedUp = metrics.scrollTop < state.lastTop;
  return { following: movedUp ? false : state.following, lastTop: metrics.scrollTop };
}

/** An explicit wheel/touch/keyboard "up" gesture pauses following even before a scroll event. */
export function onUpGesture(state: FollowState, metrics: ScrollMetrics): FollowState {
  return isNearBottom(metrics, 2) ? state : { ...state, following: false };
}

/** Sending a message, or pressing "Back to bottom", resumes following. */
export function resumeFollow(state: FollowState): FollowState {
  return { ...state, following: true };
}

/** Whether the "Back to bottom" button should be shown. */
export function shouldShowJump(state: FollowState, metrics: ScrollMetrics): boolean {
  return !state.following && !isNearBottom(metrics);
}
