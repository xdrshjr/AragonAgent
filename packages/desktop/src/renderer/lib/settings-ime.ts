import type { KeyboardEvent } from 'react';

/**
 * Enter that CONFIRMS an IME candidate (`isComposing`, or the legacy keyCode 229) must never
 * act as Enter: in a form it would submit half-typed text. Returns true when it swallowed the key.
 */
export function blockEnterWhileComposing(event: KeyboardEvent): boolean {
  if (event.key !== 'Enter' || !(event.nativeEvent.isComposing || event.keyCode === 229)) return false;
  event.preventDefault();
  return true;
}
