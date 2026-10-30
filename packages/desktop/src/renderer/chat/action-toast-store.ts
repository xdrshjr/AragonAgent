/**
 * Toasts that carry a button ("Undo"). Renderer-only, in memory, bucketed per session.
 *
 * WHY NOT `pushToast`: the engine's `Toast` type and reducer are shared with the terminal UI.
 * A callback does not belong in that view state (it would be cloned, snapshotted, compared), and
 * adding a field there changes a published package for a desktop-only need. So the plain toast
 * path is untouched and this store sits beside it; `ToastStack` renders both.
 */

import type { ToastLevel } from '../../shared/port-protocol.js';

export interface ToastAction {
  label: string;
  onRun(): void;
}

export interface ActionToast {
  id: string;
  level: ToastLevel;
  text: string;
  action: ToastAction;
  ttlMs: number;
}

export interface ActionToastInit {
  level: ToastLevel;
  text: string;
  action: ToastAction;
  ttlMs?: number;
}

/** Long enough to notice, read and decide; the clock pauses while the pointer or focus is on it. */
export const ACTION_TOAST_TTL_MS = 8000;

const EMPTY: readonly ActionToast[] = Object.freeze([]);
const buckets = new Map<string, readonly ActionToast[]>();
const listeners = new Set<() => void>();
let counter = 0;

function emit(): void {
  for (const listener of [...listeners]) listener();
}

export function subscribeActionToasts(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** A stable reference between changes, so it is safe as a `useSyncExternalStore` snapshot. */
export function getActionToasts(sessionId: string): readonly ActionToast[] {
  return buckets.get(sessionId) ?? EMPTY;
}

/** Returns the new toast's id. Ids live in their own namespace (`act-N`), apart from the reducer's. */
export function pushActionToast(sessionId: string, init: ActionToastInit): string {
  counter += 1;
  const toast: ActionToast = {
    id: `act-${counter}`, level: init.level, text: init.text, action: init.action, ttlMs: init.ttlMs ?? ACTION_TOAST_TTL_MS,
  };
  buckets.set(sessionId, [...getActionToasts(sessionId), toast]);
  emit();
  return toast.id;
}

export function dismissActionToast(sessionId: string, id: string): void {
  const current = getActionToasts(sessionId);
  if (!current.some((toast) => toast.id === id)) return;
  const next = current.filter((toast) => toast.id !== id);
  if (next.length > 0) buckets.set(sessionId, next); else buckets.delete(sessionId);
  emit();
}

export function clearActionToasts(sessionId: string): void {
  if (!buckets.delete(sessionId)) return;
  emit();
}

/** Test seam. */
export function resetActionToasts(): void {
  buckets.clear();
  emit();
}
