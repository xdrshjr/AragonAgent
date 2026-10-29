/** The `/` and `@` menus' state: which one is open, its rows, the highlighted row. */

import { useMemo, useState } from 'react';
import { buildSlashItems, type SlashItem } from '../lib/chat-slash.js';
import { detectMention, detectSlash, type TriggerMatch } from '../lib/chat-triggers.js';
import type { MentionState } from './MentionMenu.js';
import { useMentionSearch } from './use-mentions.js';

export interface Menus {
  slash: TriggerMatch | null;
  mention: TriggerMatch | null;
  slashItems: SlashItem[];
  mentionState: MentionState;
  length: number;
  activeIndex: number;
  setIndex(index: number): void;
  /** Close whichever menu is open until the text changes again. */
  dismiss(): void;
  /** The text changed: reopen menus and go back to the first row. */
  reset(): void;
}

export function useMenus(sessionId: string, text: string, caret: number): Menus {
  const [index, setIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const slash = dismissed ? null : detectSlash(text, caret);
  const mention = dismissed || slash ? null : detectMention(text, caret);
  const slashQuery = slash ? slash.query : null;
  const slashItems = useMemo(() => (slashQuery === null ? [] : buildSlashItems(slashQuery)), [slashQuery]);
  const mentionState = useMentionSearch(sessionId, mention ? mention.query : null);
  const length = slash ? slashItems.length : mention ? mentionState.paths.length : 0;
  return {
    slash, mention, slashItems, mentionState, length,
    activeIndex: Math.min(index, Math.max(0, length - 1)),
    setIndex,
    dismiss: () => setDismissed(true),
    reset: () => { setDismissed(false); setIndex(0); },
  };
}
