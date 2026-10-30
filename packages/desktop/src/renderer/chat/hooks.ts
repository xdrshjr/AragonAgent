/** Small hooks shared by the transcript rows. */

import { useCallback, useEffect, useRef, useState } from 'react';
import { sessionStore } from '../store/session-store.js';
import type { ToastLevel } from '../../shared/port-protocol.js';

/** Re-renders once a second, and ONLY while `enabled`: an idle transcript owns no timer. */
export function useNow(enabled: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [enabled, intervalMs]);
  return now;
}

/** Copy text to the clipboard; `copied` is true for 1.5 s afterwards. Never throws. */
export function useCopy(): { copied: boolean; copy(text: string): void } {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const copy = useCallback((text: string): void => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1500);
      } catch {
        setCopied(false);
      }
    })();
  }, []);
  return { copied, copy };
}

/** Show a toast in one session's pane (toasts are renderer-only view state). */
export function pushToast(sessionId: string, level: ToastLevel, text: string, ttlMs?: number): void {
  sessionStore.dispatchLocal(sessionId, { type: 'pushToast', level, text, ...(ttlMs === undefined ? {} : { ttlMs }) });
}
