/**
 * The shortcut list shown by the shortcut sheet and Settings > Shortcuts.
 *
 * Two parts: the desktop's own bindings (wired in `layout/AppShell.tsx`) and the terminal keys
 * from the parity matrix with what each one maps to. `Mod` is Cmd on macOS and Ctrl elsewhere.
 * `settings-shortcuts.test.ts` fails when a matrix key has no label here, so a new terminal key
 * cannot be added to the matrix and silently missing from the sheet.
 */

import { KEY_MATRIX } from '../../shared/parity-matrix.js';
import type { MessageKey } from '../i18n/index.js';

export interface DesktopShortcut {
  combo: string;
  labelKey: MessageKey;
}

export const DESKTOP_SHORTCUTS: readonly DesktopShortcut[] = [
  { combo: 'mod+k', labelKey: 'workspace.keys.palette' },
  { combo: 'mod+n', labelKey: 'workspace.keys.newSession' },
  { combo: 'mod+w', labelKey: 'workspace.keys.closeSession' },
  { combo: 'mod+f', labelKey: 'workspace.keys.find' },
  { combo: 'mod+1..9', labelKey: 'workspace.keys.switchSession' },
  { combo: 'mod+b', labelKey: 'workspace.keys.sidebar' },
  { combo: 'mod+j', labelKey: 'workspace.keys.inspector' },
  { combo: 'mod+shift+b', labelKey: 'workspace.keys.agents' },
  { combo: 'mod+p', labelKey: 'workspace.keys.prompts' },
  { combo: 'mod+,', labelKey: 'workspace.keys.settings' },
  { combo: 'mod+/', labelKey: 'workspace.keys.shortcuts' },
  { combo: '?', labelKey: 'workspace.keys.shortcutsBare' },
  { combo: 'shift+tab', labelKey: 'workspace.keys.mode' },
  { combo: 'esc', labelKey: 'workspace.keys.interrupt' },
];

/** One label per `KEY_MATRIX` id: what that terminal key does in the desktop app. */
export const TERMINAL_KEY_LABELS: Readonly<Record<string, MessageKey>> = {
  'Shift+Tab': 'workspace.keys.term.shiftTab',
  'Ctrl+B': 'workspace.keys.term.ctrlB',
  'Ctrl+K': 'workspace.keys.term.ctrlK',
  'Ctrl+P': 'workspace.keys.term.ctrlP',
  'Ctrl+I': 'workspace.keys.term.ctrlI',
  'Ctrl+L': 'workspace.keys.term.ctrlL',
  'Esc': 'workspace.keys.term.esc',
  '?': 'workspace.keys.term.question',
  'scroll/selection/mouse': 'workspace.keys.term.native',
};

export interface TerminalKeyRow {
  id: string;
  labelKey: MessageKey | null;
  /** The matrix says the terminal behaviour has no meaning in a window. */
  notApplicable: boolean;
}

export function terminalKeyRows(): TerminalKeyRow[] {
  return KEY_MATRIX.map((entry) => ({
    id: entry.id,
    labelKey: TERMINAL_KEY_LABELS[entry.id] ?? null,
    notApplicable: entry.status === 'na',
  }));
}

const MAC_GLYPHS: Readonly<Record<string, string>> = { mod: '\u2318', shift: '\u21E7', alt: '\u2325', esc: 'Esc', tab: 'Tab' };

/** `mod+shift+b` -> `['Ctrl','Shift','B']` (or the Mac glyphs). */
export function comboParts(combo: string, isMac: boolean): string[] {
  return combo.split('+').filter((part) => part !== '').map((raw, index, all) => {
    const part = raw.toLowerCase();
    if (part === 'mod') return isMac ? MAC_GLYPHS.mod! : 'Ctrl';
    if (part === 'shift') return isMac ? MAC_GLYPHS.shift! : 'Shift';
    if (part === 'alt') return isMac ? MAC_GLYPHS.alt! : 'Alt';
    if (part === 'esc') return 'Esc';
    if (part === 'tab') return 'Tab';
    return index === all.length - 1 && part.length === 1 ? part.toUpperCase() : raw;
  });
}
