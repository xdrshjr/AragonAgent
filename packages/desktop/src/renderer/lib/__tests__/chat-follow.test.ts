import { describe, expect, it } from 'vitest';
import {
  INITIAL_FOLLOW, isNearBottom, onScroll, onUpGesture, resumeFollow, shouldShowJump, type ScrollMetrics,
} from '../chat-follow.js';

const metrics = (scrollTop: number, scrollHeight = 2000, clientHeight = 500): ScrollMetrics =>
  ({ scrollTop, clientHeight, scrollHeight });
const BOTTOM = 1500; // scrollHeight - clientHeight

describe('sticky follow', () => {
  it('starts out following', () => {
    expect(INITIAL_FOLLOW.following).toBe(true);
  });

  it('keeps following when content grows and the view is re-pinned to the new bottom', () => {
    // Growth itself fires no scroll event; the re-pin lands "near bottom" and must not pause.
    expect(onScroll(INITIAL_FOLLOW, metrics(1700, 2200)).following).toBe(true);
  });

  it('pauses when the user scrolls up and away from the bottom', () => {
    const atBottom = onScroll(INITIAL_FOLLOW, metrics(BOTTOM));
    expect(onScroll(atBottom, metrics(900)).following).toBe(false);
  });

  it('stays paused while the user keeps reading and content grows below', () => {
    const paused = onScroll(onScroll(INITIAL_FOLLOW, metrics(BOTTOM)), metrics(900));
    // Same scrollTop, taller content: not an upward movement, so still paused.
    expect(onScroll(paused, metrics(900, 2600)).following).toBe(false);
  });

  it('resumes when the user scrolls back to the bottom', () => {
    const paused = onScroll(onScroll(INITIAL_FOLLOW, metrics(BOTTOM)), metrics(900));
    expect(onScroll(paused, metrics(BOTTOM - 10)).following).toBe(true);
  });

  it('resumes on send / "Back to bottom"', () => {
    const paused = onScroll(onScroll(INITIAL_FOLLOW, metrics(BOTTOM)), metrics(900));
    expect(resumeFollow(paused).following).toBe(true);
  });

  it('a wheel-up gesture pauses before any scroll event, unless already at the very bottom', () => {
    expect(onUpGesture(INITIAL_FOLLOW, metrics(BOTTOM - 200)).following).toBe(false);
    expect(onUpGesture(INITIAL_FOLLOW, metrics(BOTTOM)).following).toBe(true);
  });

  it('shows the jump button only when paused and away from the bottom', () => {
    const paused = { following: false, lastTop: 900 };
    expect(shouldShowJump(paused, metrics(900))).toBe(true);
    expect(shouldShowJump(paused, metrics(BOTTOM))).toBe(false);
    expect(shouldShowJump(INITIAL_FOLLOW, metrics(900))).toBe(false);
  });

  it('treats a few pixels from the bottom as the bottom', () => {
    expect(isNearBottom(metrics(BOTTOM - 20))).toBe(true);
    expect(isNearBottom(metrics(BOTTOM - 400))).toBe(false);
  });
});
