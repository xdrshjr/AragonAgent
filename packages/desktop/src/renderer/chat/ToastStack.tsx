/**
 * Renders a session's renderer-only toasts and auto-dismisses them.
 *
 * The view state carries `toasts` (the reducer assigns ids and a `ttlMs`) but nothing in the
 * shell draws them: this pane is where they land, so this is also where their timers live.
 * One timer per toast id, cleared if the toast goes away first.
 */

import { X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { Toast } from '@aragon-agent/tui/model/agent/reducer';
import { useT } from '../i18n/index.js';
import { sessionStore, useSession } from '../store/session-store.js';
import { IconButton } from '../ui/primitives.js';

const EMPTY: Toast[] = [];
/** Errors stay a little longer than the engine's 2.5 s default: they carry something to read. */
const MIN_ERROR_MS = 6000;

function ttlOf(toast: Toast): number {
  return toast.level === 'error' ? Math.max(toast.ttlMs, MIN_ERROR_MS) : toast.ttlMs;
}

export function ToastStack({ sessionId }: { sessionId: string }) {
  const t = useT();
  const toasts = useSession(sessionId, (mirror) => mirror?.view?.toasts) ?? EMPTY;

  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    // Arm only toasts we have not armed yet, so a new toast never extends an older one's life.
    const live = new Set(toasts.map((toast) => toast.id));
    for (const toast of toasts) {
      if (timers.current.has(toast.id)) continue;
      timers.current.set(toast.id, setTimeout(
        () => sessionStore.dispatchLocal(sessionId, { type: 'dismissToast', id: toast.id }),
        ttlOf(toast),
      ));
    }
    for (const [id, timer] of timers.current) {
      if (live.has(id)) continue;
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, [toasts, sessionId]);
  useEffect(() => () => { for (const timer of timers.current.values()) clearTimeout(timer); }, []);

  if (toasts.length === 0) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className="toast" data-level={toast.level}>
          <span className="selectable">{toast.text}</span>
          <IconButton size="sm" label={t('common.close')}
            onClick={() => sessionStore.dispatchLocal(sessionId, { type: 'dismissToast', id: toast.id })}>
            <X size={14} strokeWidth={1.5} />
          </IconButton>
        </div>
      ))}
    </div>
  );
}
