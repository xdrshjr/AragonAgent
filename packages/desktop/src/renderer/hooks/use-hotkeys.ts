/**
 * Global keyboard shortcuts. `Mod` is Cmd on macOS and Ctrl elsewhere.
 *
 * Two rules keep this from fighting the user: a shortcut that uses a printable key without
 * Mod (`?`) only fires when focus is NOT in a text field, and shortcuts with Mod fire
 * everywhere EXCEPT while an IME composition is in progress. Matching is on `event.key`
 * (what the user typed), not `event.code`, so non-US layouts get the shortcut they expect.
 */

import { useEffect } from 'react';

export interface Hotkey {
  /** e.g. `mod+k`, `mod+shift+b`, `mod+,`, `?`. */
  combo: string;
  handler(event: KeyboardEvent): void;
  /** Allow it while a text field has focus (default: true for Mod combos, false for bare keys). */
  inTextField?: boolean;
}

export function parseCombo(combo: string): { mod: boolean; shift: boolean; alt: boolean; key: string } {
  const parts = combo.toLowerCase().split('+');
  const key = parts[parts.length - 1] ?? '';
  return { mod: parts.includes('mod'), shift: parts.includes('shift'), alt: parts.includes('alt'), key };
}

export function matches(event: KeyboardEvent, combo: string, isMac: boolean): boolean {
  const want = parseCombo(combo);
  const mod = isMac ? event.metaKey : event.ctrlKey;
  if (want.mod !== mod) return false;
  if (want.alt !== event.altKey) return false;
  // `?` is itself a shifted character, so Shift is only compared for letters and digits.
  const shiftMatters = /^[a-z0-9]$/.test(want.key);
  if (shiftMatters && want.shift !== event.shiftKey) return false;
  return event.key.toLowerCase() === want.key;
}

function inTextField(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;
  return element.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName);
}

export function useHotkeys(hotkeys: readonly Hotkey[], isMac: boolean): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.isComposing || event.keyCode === 229) return; // never steal a keystroke from an IME
      for (const hotkey of hotkeys) {
        if (!matches(event, hotkey.combo, isMac)) continue;
        const hasMod = hotkey.combo.toLowerCase().includes('mod');
        const allowInField = hotkey.inTextField ?? hasMod;
        if (!allowInField && inTextField(event.target)) continue;
        event.preventDefault();
        hotkey.handler(event);
        return;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [hotkeys, isMac]);
}
