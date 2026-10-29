import { useEffect, useRef } from 'react';

/**
 * Run `handler` when Esc is pressed anywhere while the component is mounted.
 *
 * The approval dialogs cannot be dismissed by clicking outside (a stray click must not throw
 * away a half-written answer), so Radix's own Esc handling is switched off with it; this puts
 * Esc back, and routes it to the dialog's FAIL-CLOSED answer (deny / cancel / dismiss).
 */
export function useEscape(handler: () => void): void {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      latest.current();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, []);
}
