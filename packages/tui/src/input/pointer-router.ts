import type { MouseEvent } from './mouse-events.js';
import type { MouseSource } from './stdin-filter.js';

export interface PointerRouter {
  selectionSource: MouseSource;
  dispose(): void;
}

/** Deliver each button gesture to the scrollbar before the selection source. */
export function createPointerRouter(options: {
  source: MouseSource;
  handle(event: MouseEvent): boolean;
}): PointerRouter {
  const listeners = new Set<(event: MouseEvent) => void>();
  const unsubscribe = options.source.subscribe((event) => {
    if (event.kind !== 'wheel' && options.handle(event)) return;
    for (const listener of listeners) listener(event);
  });
  return { selectionSource: { subscribe: (listener) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  } }, dispose: () => { unsubscribe(); listeners.clear(); } };
}
