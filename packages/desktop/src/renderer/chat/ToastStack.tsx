/**
 * Renders a session's renderer-only toasts and auto-dismisses them.
 *
 * The view state carries `toasts` (the reducer assigns ids and a `ttlMs`) but nothing in the
 * shell draws them: this pane is where they land, so this is also where their timers live.
 * One timer per toast id, cleared if the toast goes away first.
 */

import { X } from 'lucide-react';
import { useEffect, useRef, useSyncExternalStore, type FocusEvent } from 'react';
import type { Toast } from '@aragon-agent/tui/model/agent/reducer';
import { useT } from '../i18n/index.js';
import { sessionStore, useSession } from '../store/session-store.js';
import { IconButton } from '../ui/primitives.js';
import {
  dismissActionToast,
  getActionToasts,
  subscribeActionToasts,
  type ActionToast,
} from './action-toast-store.js';

const EMPTY: Toast[] = [];
/** Errors stay a little longer than the engine's 2.5 s default: they carry something to read. */
const MIN_ERROR_MS = 6000;

function ttlOf(toast: Toast): number {
  return toast.level === 'error' ? Math.max(toast.ttlMs, MIN_ERROR_MS) : toast.ttlMs;
}

/**
 * One toast with a button. Its clock stops while the pointer is over it or focus is inside it
 * (a person reaching for "Undo" must not lose it under their hand) and resumes with the time
 * that was LEFT, not a fresh one.
 */
function ActionToastRow({ toast, onDone }: { toast: ActionToast; onDone(): void }) {
  const t = useT();
  const remaining = useRef(toast.ttlMs);
  const startedAt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hover = useRef(false);
  const focus = useRef(false);
  const done = useRef(onDone);
  done.current = onDone;

  const arm = (): void => {
    if (timer.current !== null || hover.current || focus.current) return;
    startedAt.current = Date.now();
    timer.current = setTimeout(() => done.current(), remaining.current);
  };
  const pause = (): void => {
    if (timer.current === null) return;
    clearTimeout(timer.current);
    timer.current = null;
    remaining.current = Math.max(0, remaining.current - (Date.now() - startedAt.current));
  };
  useEffect(() => {
    arm();
    return () => { if (timer.current !== null) clearTimeout(timer.current); timer.current = null; };
  }, []);

  const leaveFocus = (event: FocusEvent<HTMLDivElement>): void => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    focus.current = false;
    arm();
  };
  return (
    <div className="toast toast-action" data-level={toast.level}
      onMouseEnter={() => { hover.current = true; pause(); }}
      onMouseLeave={() => { hover.current = false; arm(); }}
      onFocus={() => { focus.current = true; pause(); }}
      onBlur={leaveFocus}>
      <span className="selectable">{toast.text}</span>
      <button type="button" className="toast-action-button"
        onClick={() => { toast.action.onRun(); onDone(); }}>
        {toast.action.label}
      </button>
      <IconButton size="sm" label={t('common.close')} onClick={onDone}>
        <X size={14} strokeWidth={1.5} />
      </IconButton>
    </div>
  );
}

export function ToastStack({ sessionId }: { sessionId: string }) {
  const t = useT();
  const toasts = useSession(sessionId, (mirror) => mirror?.view?.toasts) ?? EMPTY;
  const actionToasts = useSyncExternalStore(
    subscribeActionToasts, () => getActionToasts(sessionId), () => getActionToasts(sessionId),
  );

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

  if (toasts.length === 0 && actionToasts.length === 0) return null;
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
      {actionToasts.map((toast) => (
        <ActionToastRow key={toast.id} toast={toast} onDone={() => dismissActionToast(sessionId, toast.id)} />
      ))}
    </div>
  );
}
