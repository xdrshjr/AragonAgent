import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Box, measureElement, useStdout, type DOMElement } from 'ink';
import type { Theme } from '../theme.js';
import type { TermCapabilities } from '../capabilities.js';
import { createScrollbarController, type ScrollbarBridge } from '../scrollbar-controller.js';
import { ViewportGeometryContext } from './viewport-geometry.js';
import { applyScrollTimes, type ScrollIntent } from './scroll.js';
import { reduceFollow, shouldArmResume, type TailSink } from './follow-state.js';
import { thumbRange } from './scroll-indicator.js';
import { ScrollIndicator } from './ScrollIndicator.js';
import { buildDocumentLayout } from './document-layout.js';

export interface ScrollViewportProps {
  intent?: { kind: ScrollIntent; nonce: number; repeat?: number };
  pinToBottomNonce?: number;
  resetKey?: unknown;
  onScrolledLinesChange?: (lines: number) => void;
  onViewportShiftChange?: (shift: number) => void;
  tailRowsRef?: TailSink;
  hold?: boolean;
  resumeMs?: number;
  showScrollIndicator?: boolean;
  cols?: number;
  footer?: React.ReactNode;
  rail?: React.ReactNode;
  overlay?: React.ReactNode;
  active?: boolean;
  scrollbar?: ScrollbarBridge;
  composerRef?: React.RefObject<DOMElement>;
  onComposerVisibilityChange?: (visible: boolean) => void;
  /** The run status row above the input box (tui-scrollbar-edge-and-run-row). */
  activityRef?: React.RefObject<DOMElement>;
  onActivityVisibilityChange?: (visible: boolean) => void;
  theme: Theme;
  caps: TermCapabilities;
  children: React.ReactNode;
}

interface Measurement {
  viewport: number;
  content: number;
  body: number;
  footer: number;
  padding: number;
  cols: number;
  tail: number;
}

/**
 * Whether `element` lies fully inside `clip`. A missing element (not mounted) or
 * clip reports `true`, so a caller that consumes the answer must first know the
 * element is actually mounted. Rows are one line tall, so "partially visible"
 * cannot occur for the run status row.
 */
function elementVisible(element: DOMElement | null, clip: DOMElement | null): boolean {
  if (!element || !clip) return true;
  let top = 0;
  let current: DOMElement | undefined = element;
  while (current && current !== clip) {
    top += current.yogaNode?.getComputedTop() ?? 0;
    current = current.parentNode;
  }
  return current === clip && top >= 0 &&
    top + measureElement(element).height <= measureElement(clip).height;
}

/** One offset for messages, padding and editor; hidden trees keep their local state. */
export function ScrollViewport(props: ScrollViewportProps): React.ReactElement {
  const { stdout } = useStdout();
  const { active = true, hold = false, resumeMs = 0, scrollbar } = props;
  const cols = props.cols ?? stdout?.columns ?? 80;
  const clipRef = useRef<DOMElement>(null);
  const bodyRef = useRef<DOMElement>(null);
  const footerRef = useRef<DOMElement>(null);
  const [{ metrics, offset }, setGeometry] = useState({
    metrics: { viewport: 0, content: 0, padding: 0, footer: 0 }, offset: 0,
  });
  const pendingMetrics = useRef(metrics);
  const geometryScheduled = useRef(false);
  const mounted = useRef(true);
  const [dragging, setDragging] = useState(false);
  const offsetRef = useRef(0);
  const baseline = useRef<Measurement | null>(null);
  const latest = useRef({ active, hold, resumeMs, metrics, scrollbar });
  latest.current = { active, hold, resumeMs, metrics, scrollbar };
  const pausedLines = useRef(0);
  const resumeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastIntent = useRef(props.intent?.nonce);
  const lastPin = useRef(props.pinToBottomNonce);
  const lastReset = useRef(props.resetKey);
  const lastVisible = useRef<boolean>();
  const lastActivityVisible = useRef<boolean>();
  const previousActive = useRef(active);
  const geometryRevision = useRef(0);
  const geometryBounds = useRef('');

  const clearResume = useCallback(() => {
    if (resumeTimer.current) clearTimeout(resumeTimer.current);
    resumeTimer.current = null;
  }, []);
  const publishGeometry = useCallback(() => {
    if (geometryScheduled.current) return;
    geometryScheduled.current = true;
    queueMicrotask(() => {
      geometryScheduled.current = false;
      if (!mounted.current) return;
      const nextMetrics = pendingMetrics.current;
      const nextOffset = offsetRef.current;
      setGeometry((previous) => previous.offset === nextOffset &&
        Object.keys(nextMetrics).every((key) =>
          previous.metrics[key as keyof typeof nextMetrics] ===
            nextMetrics[key as keyof typeof nextMetrics])
        ? previous : { metrics: nextMetrics, offset: nextOffset });
    });
  }, []);
  const publishOffset = useCallback((next: number) => {
    offsetRef.current = next;
    if (next === 0) pausedLines.current = 0;
    publishGeometry();
  }, [publishGeometry]);
  const isHeld = useCallback(() => latest.current.hold ||
    !!latest.current.scrollbar?.controller?.isCaptured(), []);
  const armResume = useCallback(() => {
    clearResume();
    const current = latest.current;
    if (!current.active || !shouldArmResume({ resumeMs: current.resumeMs,
      offset: offsetRef.current, newLinesWhilePaused: pausedLines.current, hold: isHeld() })) return;
    resumeTimer.current = setTimeout(() => {
      resumeTimer.current = null;
      if (latest.current.active && !isHeld()) publishOffset(0);
    }, current.resumeMs);
    resumeTimer.current.unref?.();
  }, [clearResume, isHeld, publishOffset]);

  useLayoutEffect(() => {
    if (!scrollbar) return;
    const controller = createScrollbarController({
      getGeometry: () => scrollbar.geometry,
      isEnabled: () => latest.current.active && scrollbar.frameReady && scrollbar.isEnabled(),
      setOffset: (next) => { publishOffset(next); armResume(); },
      page: (kind) => {
        publishOffset(applyScrollTimes({ offset: offsetRef.current }, kind,
          latest.current.metrics, 1).offset);
      },
      onStart: () => { clearResume(); scrollbar.onStart?.(); },
      onHold: (held) => { setDragging(held); armResume(); },
    });
    scrollbar.controller = controller;
    return () => {
      controller.dispose();
      scrollbar.controller = null;
      scrollbar.geometry = null;
      scrollbar.invalidate();
    };
  }, [scrollbar, publishOffset, armResume, clearResume]);
  useEffect(() => clearResume, [clearResume]);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => { armResume(); }, [hold, resumeMs, armResume]);

  useLayoutEffect(() => {
    const reset = lastReset.current !== props.resetKey;
    lastReset.current = props.resetKey;
    const pin = lastPin.current !== props.pinToBottomNonce;
    lastPin.current = props.pinToBottomNonce;
    const intent = lastIntent.current !== props.intent?.nonce ? props.intent : undefined;
    lastIntent.current = props.intent?.nonce;
    if (reset) {
      baseline.current = null;
      pausedLines.current = 0;
      publishOffset(0);
      scrollbar?.controller?.cancel();
    }
    if (!active) {
      clearResume();
      scrollbar?.invalidate();
      if (scrollbar) scrollbar.geometry = null;
      previousActive.current = false;
      return;
    }
    const viewport = clipRef.current ? measureElement(clipRef.current).height : 0;
    const body = bodyRef.current ? measureElement(bodyRef.current).height : 0;
    const footer = footerRef.current ? measureElement(footerRef.current).height : 0;
    const layout = buildDocumentLayout({ rows: viewport + 4, bodyRows: body, footerRows: footer });
    const padding = props.footer === undefined ? 0 : layout.paddingRows;
    const content = body + footer + padding;
    const tail = props.tailRowsRef?.current.rows ?? 0;
    const old = baseline.current;
    const reflow = !old || old.cols !== cols || old.viewport !== viewport;
    const tailDelta = reflow ? 0 : tail - old.tail;
    const footerDelta = reflow ? 0 : footer - old.footer;
    const paddingDelta = !old || reflow || props.footer === undefined ? 0 :
      Math.max(0, viewport - old.body - old.footer - tailDelta - footerDelta) - old.padding;
    const nextMetrics = { viewport, content, padding, footer };
    latest.current.metrics = nextMetrics;
    // Markdown estimates may take more than 50 measurements to converge in a
    // tall viewport. Publishing during the layout commit recursively mounts
    // another window before the height store's microtask can finish. Coalesce
    // geometry with that store outside the commit; keep measuring every frame.
    // Offset clamps must join the same publication: at the top, each corrected
    // estimate shrinks the overflow and would otherwise recurse via setOffset.
    pendingMetrics.current = nextMetrics;
    publishGeometry();
    const followed = reduceFollow({ offset: offsetRef.current,
      overflowLines: Math.max(0, content - viewport), tailDelta,
      layoutTailDelta: footerDelta + paddingDelta, hold: isHeld(),
      newLinesWhilePaused: pausedLines.current });
    pausedLines.current = followed.newLinesWhilePaused;
    let next = pin || reset ? 0 : followed.offset;
    if (!pin && intent) next = applyScrollTimes({ offset: next }, intent.kind,
      nextMetrics, intent.repeat ?? 1).offset;
    publishOffset(next);
    baseline.current = { viewport, content, body, footer, padding, cols, tail };
    if (tailDelta !== 0 || pin || intent || !previousActive.current) armResume();
    previousActive.current = true;
    const bounds = `${cols}:${stdout?.columns}:${stdout?.rows}:${viewport}`;
    if (bounds !== geometryBounds.current) {
      geometryBounds.current = bounds;
      geometryRevision.current++;
      scrollbar?.invalidate();
    }
    if (scrollbar) {
      scrollbar.geometry = { trackTop: 2, trackCol: stdout?.columns ?? cols,
        trackRows: viewport, contentRows: content, offset: next,
        thumb: thumbRange(viewport, content, next, true), revision: geometryRevision.current };
      scrollbar.onGeometry?.();
    }
    const visible = elementVisible(props.composerRef?.current ?? null, clipRef.current);
    if (lastVisible.current !== visible) {
      lastVisible.current = visible;
      props.onComposerVisibilityChange?.(visible);
    }
    const activityVisible = elementVisible(props.activityRef?.current ?? null, clipRef.current);
    if (lastActivityVisible.current !== activityVisible) {
      lastActivityVisible.current = activityVisible;
      props.onActivityVisibilityChange?.(activityVisible);
    }
  });

  const shiftUp = Math.max(0, metrics.content - metrics.viewport - offset);
  useEffect(() => { props.onScrolledLinesChange?.(offset); },
    [offset, props.onScrolledLinesChange]);
  useEffect(() => { if (active) props.onViewportShiftChange?.(shiftUp); },
    [active, shiftUp, props.onViewportShiftChange]);
  const geometry = useMemo(() => ({ viewportRows: metrics.viewport, offset,
    contentRows: metrics.content, trailingContentRows: metrics.padding + metrics.footer }),
  [metrics, offset]);

  return (
    <Box flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">
      <Box display={active ? 'flex' : 'none'} flexDirection="row"
        flexGrow={1} flexShrink={1} overflow="hidden">
        <Box ref={clipRef} flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">
          <Box flexDirection="column" flexShrink={0} marginTop={-shiftUp}>
            <ViewportGeometryContext.Provider value={geometry}>
              <Box ref={bodyRef} flexDirection="column" flexShrink={0}>{props.children}</Box>
            </ViewportGeometryContext.Provider>
            <Box height={metrics.padding} flexShrink={0} />
            <Box ref={footerRef} flexDirection="column" flexShrink={0}>{props.footer}</Box>
          </Box>
        </Box>
        {props.rail}
        {props.showScrollIndicator && <ScrollIndicator rows={metrics.viewport}
          thumb={thumbRange(metrics.viewport, metrics.content, offset, true)}
          dragging={dragging} theme={props.theme} caps={props.caps} />}
      </Box>
      <Box display={active ? 'none' : 'flex'} flexDirection="column" flexGrow={1}
        flexShrink={1} overflow="hidden">{props.overlay ?? null}</Box>
    </Box>
  );
}
