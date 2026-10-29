/**
 * The session bar's ⋯ menu as DATA, shared by the menu itself and the command palette so the two
 * cannot drift apart. `matrixIds` ties an item to the parity-matrix commands whose target text
 * names it; `parity.test.ts` fails if a matrix row points at a menu entry that does not exist.
 */

import type { MessageKey } from '../i18n/index.js';

export type SessionMenuItemId = 'new' | 'save' | 'export' | 'branch' | 'copy-id' | 'reveal' | 'close';

export interface SessionMenuItem {
  id: SessionMenuItemId;
  labelKey: MessageKey;
  /** Parity-matrix command ids this entry fulfils. */
  matrixIds: readonly string[];
  /** When set (and the context says so), the item is disabled with this explanation. */
  disabledKey?: MessageKey;
  separatorBefore?: boolean;
  shortcut?: string;
}

export interface SessionMenuContext {
  running: boolean;
  hasCwd: boolean;
}

export const SESSION_MENU: readonly SessionMenuItem[] = [
  { id: 'new', labelKey: 'chat.menu.new', matrixIds: ['clear', 'reset'], disabledKey: 'chat.menu.newBusy' },
  { id: 'save', labelKey: 'chat.menu.save', matrixIds: ['save'] },
  { id: 'export', labelKey: 'chat.menu.export', matrixIds: ['save'] },
  { id: 'branch', labelKey: 'chat.menu.branch', matrixIds: ['branch'], separatorBefore: true },
  { id: 'copy-id', labelKey: 'chat.menu.copyId', matrixIds: ['session'] },
  { id: 'reveal', labelKey: 'chat.menu.reveal', matrixIds: [], disabledKey: 'chat.bar.cwdNone' },
  { id: 'close', labelKey: 'chat.menu.close', matrixIds: ['exit'], separatorBefore: true, shortcut: 'mod+w' },
];

/** The reason an item is unavailable right now, or null. */
export function disabledReasonKey(item: SessionMenuItem, context: SessionMenuContext): MessageKey | null {
  if (item.id === 'new' && context.running) return item.disabledKey ?? null;
  if (item.id === 'reveal' && !context.hasCwd) return item.disabledKey ?? null;
  return null;
}

/** Every matrix command id some menu item claims to fulfil. */
export function menuMatrixIds(): Set<string> {
  return new Set(SESSION_MENU.flatMap((item) => item.matrixIds));
}
