/**
 * DOM glue for the transcript's virtual list: measuring rows, windowing, and sticky follow.
 * The arithmetic is in `lib/chat-virtual.ts` and `lib/chat-follow.ts` (pure, unit-tested);
 * these hooks only wire it to scroll events and ResizeObservers.
 */

import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MutableRefObject,
  type WheelEvent,
} from 'react';
import type { Entry } from '@aragon-agent/tui/model/agent/reducer';
import {
  INITIAL_FOLLOW, onScroll, onUpGesture, resumeFollow, shouldShowJump, type FollowState, type ScrollMetrics,
} from '../lib/chat-follow.js';
import { buildOffsets, estimateHeight, rowAt, visibleRange, type VirtualRange } from '../lib/chat-virtual.js';

const OVERSCAN_PX = 800;
const DEFAULT_VIEWPORT = 800;
const UP_KEYS = new Set(['PageUp', 'ArrowUp', 'Home']);

type ScrollerRef = MutableRefObject<HTMLDivElement | null>;

export interface VirtualScroll {
  scrollerRef: ScrollerRef;
  range: VirtualRange;
  topSpace: number;
  bottomSpace: number;
  following: boolean;
  showJump: boolean;
  observer: ResizeObserver | null;
  handlers: {
    onScroll(): void;
    onWheel(event: WheelEvent): void;
    onKeyDown(event: KeyboardEvent): void;
  };
  /** Resume following the tail and jump there. */
  resume(): void;
  /** Bring row `index` to the middle of the viewport and stop following the tail. */
  scrollToIndex(index: number): void;
  /** Whether the view is currently pinned to the tail. */
  isFollowing(): boolean;
}

function metricsOf(element: HTMLElement): ScrollMetrics {
  return { scrollTop: element.scrollTop, clientHeight: element.clientHeight, scrollHeight: element.scrollHeight };
}

/** Measured heights, the prefix sums built from them, and the observer that keeps them fresh. */
function useRowHeights(
  entries: readonly Entry[], scrollerRef: ScrollerRef, followRef: MutableRefObject<FollowState>,
  anchorRef: MutableRefObject<number>,
): { offsets: number[]; observer: ResizeObserver | null } {
  const heights = useRef(new Map<string, number>());
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const frame = useRef(0);
  const [version, setVersion] = useState(0);

  const offsets = useMemo(
    () => buildOffsets(entries.map((entry) => heights.current.get(entry.id) ?? estimateHeight(entry))),
    // `version` is the revision term for the mutable heights map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [entries, version],
  );

  const observer = useMemo(() => {
    if (typeof ResizeObserver === 'undefined') return null;
    return new ResizeObserver((records) => {
      let changed = false;
      for (const record of records) {
        const element = record.target as HTMLElement;
        const id = element.dataset['id'];
        const index = Number(element.dataset['index']);
        if (!id) continue;
        const next = Math.round(record.borderBoxSize?.[0]?.blockSize ?? element.offsetHeight);
        const entry = entriesRef.current[index];
        const previous = heights.current.get(id) ?? (entry ? estimateHeight(entry) : next);
        if (Math.abs(next - previous) < 1) continue;
        heights.current.set(id, next);
        changed = true;
        // A row ABOVE the viewport changed size: shift the scroll offset by the same amount so
        // the content the user is reading does not jump (we disabled the browser's own anchoring).
        const scroller = scrollerRef.current;
        if (scroller && !followRef.current.following && index < anchorRef.current) scroller.scrollTop += next - previous;
      }
      if (changed && frame.current === 0) {
        frame.current = requestAnimationFrame(() => { frame.current = 0; setVersion((value) => value + 1); });
      }
    });
  }, [scrollerRef, followRef, anchorRef]);

  useEffect(() => () => {
    observer?.disconnect();
    if (frame.current) cancelAnimationFrame(frame.current);
  }, [observer]);

  return { offsets, observer };
}

function useViewportHeight(scrollerRef: ScrollerRef): number {
  const [viewport, setViewport] = useState(DEFAULT_VIEWPORT);
  useEffect(() => {
    const element = scrollerRef.current;
    if (!element) return undefined;
    const sync = (): void => { if (element.clientHeight > 0) setViewport(element.clientHeight); };
    sync();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const watcher = new ResizeObserver(sync);
    watcher.observe(element);
    return () => watcher.disconnect();
  }, [scrollerRef]);
  return viewport;
}

/** Sticky follow: the state machine from `chat-follow` bound to scroll, wheel and key events. */
function useFollow(scrollerRef: ScrollerRef, followRef: MutableRefObject<FollowState>) {
  const [scrollTop, setScrollTop] = useState(0);
  const [following, setFollowing] = useState(true);
  const [showJump, setShowJump] = useState(false);

  // Pinned to the tail: runs after EVERY commit (content growth fires no scroll event).
  useLayoutEffect(() => {
    const element = scrollerRef.current;
    if (!element || !followRef.current.following) return;
    const wanted = element.scrollHeight - element.clientHeight;
    if (wanted > element.scrollTop + 1) element.scrollTop = wanted;
  });

  const apply = useCallback((state: FollowState, element: HTMLElement): void => {
    followRef.current = state;
    setFollowing(state.following);
    setShowJump(shouldShowJump(state, metricsOf(element)));
  }, [followRef]);

  const handlers = useMemo(() => ({
    onScroll: (): void => {
      const element = scrollerRef.current;
      if (!element) return;
      apply(onScroll(followRef.current, metricsOf(element)), element);
      setScrollTop(element.scrollTop);
    },
    onWheel: (event: WheelEvent): void => {
      const element = scrollerRef.current;
      if (element && event.deltaY < 0) apply(onUpGesture(followRef.current, metricsOf(element)), element);
    },
    onKeyDown: (event: KeyboardEvent): void => {
      const element = scrollerRef.current;
      if (element && UP_KEYS.has(event.key) && event.target === element) {
        apply(onUpGesture(followRef.current, metricsOf(element)), element);
      }
    },
  }), [apply, scrollerRef, followRef]);

  const resume = useCallback((): void => {
    followRef.current = resumeFollow(followRef.current);
    setFollowing(true);
    setShowJump(false);
    const element = scrollerRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [scrollerRef, followRef]);

  /** Stop following without a user gesture (a programmatic jump, e.g. to a find match). */
  const pause = useCallback((): void => {
    followRef.current = { ...followRef.current, following: false };
    setFollowing(false);
    setShowJump(true);
  }, [followRef]);

  return { scrollTop, following, showJump, handlers, resume, pause };
}

export function useVirtualScroll(entries: readonly Entry[]): VirtualScroll {
  const scrollerRef: ScrollerRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef<FollowState>(INITIAL_FOLLOW);
  const anchorRef = useRef(0);
  const { offsets, observer } = useRowHeights(entries, scrollerRef, followRef, anchorRef);
  const viewport = useViewportHeight(scrollerRef);
  const follow = useFollow(scrollerRef, followRef);

  const total = offsets[offsets.length - 1] ?? 0;
  // While pinned, window around the tail even before the first scroll event has been seen.
  const effectiveTop = follow.following ? Math.max(0, total - viewport) : follow.scrollTop;
  const range = useMemo(
    () => visibleRange(offsets, effectiveTop, viewport, OVERSCAN_PX),
    [offsets, effectiveTop, viewport],
  );
  anchorRef.current = rowAt(offsets, follow.scrollTop);
  const offsetsRef = useRef(offsets);
  offsetsRef.current = offsets;
  const { pause } = follow;

  const scrollToIndex = useCallback((index: number): void => {
    const element = scrollerRef.current;
    const table = offsetsRef.current;
    if (!element || index < 0 || index >= table.length - 1) return;
    const top = table[index] ?? 0;
    const height = (table[index + 1] ?? top) - top;
    pause(); // before scrolling: a streaming token must not pull the view back to the tail
    element.scrollTop = Math.max(0, top - Math.max(0, (element.clientHeight - height) / 2));
  }, [pause]);

  return {
    scrollerRef, range, observer,
    topSpace: offsets[range.start] ?? 0,
    bottomSpace: Math.max(0, total - (offsets[range.end] ?? total)),
    following: follow.following, showJump: follow.showJump, handlers: follow.handlers, resume: follow.resume,
    scrollToIndex, isFollowing: () => followRef.current.following,
  };
}
