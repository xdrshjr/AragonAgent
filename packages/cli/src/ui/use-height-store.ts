/**
 * The transcript height cache (tui-render-performance L3).
 *
 * Virtualisation needs a height for entries it is NOT mounting. Measured
 * heights are authoritative; entries that have never been on screen fall back to
 * `estimateEntryRows`, and both are memoised on the same `heightKey` so a
 * `cols` change or a content change invalidates them together (V-5).
 *
 * THE MAP LIVES IN A REF, NOT IN STATE, and the version counter is bumped at
 * most once per frame through a microtask and ONLY when a value actually
 * changed. K-2 is the failure this shape exists to prevent: a naive
 * measure -> setState -> re-measure store never converges, and the symptom is a
 * hung terminal rather than an error. In steady state — settled entries at a
 * fixed width — this produces zero extra renders.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { VIRTUAL_LIMITS, type HeightKey } from './layout/virtual-window.js';

export interface HeightStoreStats {
  measured: number;
  estimated: number;
}

export interface HeightStore {
  /** Bumped at most once per frame, and only when a measurement changed. */
  version: number;
  /** Measured rows, else the memoised estimate, computing it once if needed. */
  resolve: (key: HeightKey, estimate: () => number) => number;
  /** Called from `MeasuredEntry`'s layout effect. Idempotent per (key, value). */
  report: (key: HeightKey, rows: number) => void;
  stats: () => HeightStoreStats;
  clear: () => void;
}

/** Drop the oldest keys once a map passes the ceiling (insertion-ordered LRU). */
function trim(map: Map<HeightKey, number>): void {
  while (map.size > VIRTUAL_LIMITS.heightEntries) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

export function useHeightStore(): HeightStore {
  const measured = useRef<Map<HeightKey, number>>(new Map());
  const estimated = useRef<Map<HeightKey, number>>(new Map());
  const [version, setVersion] = useState(0);
  const scheduled = useRef(false);
  const mounted = useRef(true);

  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const report = useCallback((key: HeightKey, rows: number): void => {
    const value = Number.isFinite(rows) && rows > 0 ? Math.floor(rows) : 0;
    if (value <= 0) return;
    if (measured.current.get(key) === value) return;
    measured.current.set(key, value);
    trim(measured.current);
    // An estimate that has been superseded is dead weight; dropping it here is
    // what keeps `stats()` honest for `/perf`.
    estimated.current.delete(key);
    if (scheduled.current) return;
    scheduled.current = true;
    queueMicrotask(() => {
      scheduled.current = false;
      if (mounted.current) setVersion((v) => v + 1);
    });
  }, []);

  const resolve = useCallback((key: HeightKey, estimate: () => number): number => {
    const hit = measured.current.get(key);
    if (hit !== undefined) return hit;
    const cached = estimated.current.get(key);
    if (cached !== undefined) return cached;
    const value = Math.max(1, Math.floor(estimate()));
    estimated.current.set(key, value);
    trim(estimated.current);
    return value;
  }, []);

  const stats = useCallback(
    (): HeightStoreStats => ({ measured: measured.current.size, estimated: estimated.current.size }),
    [],
  );

  const clear = useCallback((): void => {
    measured.current.clear();
    estimated.current.clear();
    if (mounted.current) setVersion((v) => v + 1);
  }, []);

  return { version, resolve, report, stats, clear };
}
