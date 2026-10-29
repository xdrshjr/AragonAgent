/**
 * The prompt picker: `/prompts` (quick-prompt-library §4.5).
 *
 * ASCII ONLY - `src/ui/**` is inside `glyphs.test.ts::inScope`.
 *
 * THE QUERY BOX IS THE LIST. There is no separate search field and no `/` mode: the
 * picker exists for one keystroke-to-answer gesture, and an extra mode to enter is an
 * extra thing that can be wrong about which component owns the next key.
 *
 * `Ctrl+Enter` IS RECOGNISED BY ITS BYTES, NOT BY `key.ctrl && key.return`. The stdin
 * filter normalises every modified Enter (`\x1b[13;5u`, the win32 record, `\x1b[13;2u`)
 * into `ENTER_NEWLINE_FRAME` before Ink sees it (enter-sequences.ts), so the parsed
 * chord never occurs - a branch written that way is dead code that LOOKS implemented
 * (R-11). On a terminal without keyboard enhancement the chord degrades to a plain
 * `Enter`, which fills without sending; the footer therefore names `Enter fill` first.
 */

import React, { useState } from 'react';
import { Text, useInput } from 'ink';
import type { Theme } from '../theme.js';
import type { TermCapabilities } from '../capabilities.js';
import { pickGlyphs } from '../glyphs.js';
import { OverlayFrame } from '../layout/OverlayFrame.js';
import { ENTER_NEWLINE_FRAME } from '../../input/limits.js';
import { PROMPT_PICKER_LIMITS } from '../../model/prompts/limits.js';
import { nextView } from '../../model/prompts/search.js';
import type { PromptLibrary, PromptLibraryEntry, PromptSortView } from '../../model/prompts/types.js';
import { stripPasteFrames } from '../paste-frames.js';
import { stripEnterFrames } from '../enter-frames.js';
import { clipProfileText, useProfileScroll } from './ModelProfilePicker.js';
import {
  pickerDetail,
  pickerDigitTarget,
  pickerHint,
  pickerRows,
} from './prompt-picker-state.js';

/** Every modified Enter the stdin filter folds into its frame, plus the raw CSI-u. */
const SUBMIT_FRAMES: readonly string[] = [ENTER_NEWLINE_FRAME, '\x1b[13;5u'];

export interface PromptPickerProps {
  isActive: boolean;
  library: PromptLibrary;
  cols: number;
  maxRows: number;
  scrollOffset: number;
  onScrollClamp?: (offset: number) => void;
  theme: Theme;
  caps: TermCapabilities;
  /** `submit` is true only for `Ctrl+Enter` (see `SUBMIT_FRAMES`). */
  onFill: (id: string, submit: boolean) => void;
  /** `Tab` / `a`: hand over to the manager without leaving the overlay stack. */
  onManage: (entry: PromptLibraryEntry) => void;
  onClose: () => void;
}

export function PromptPicker(props: PromptPickerProps): React.ReactElement {
  const { library, cols, theme, caps } = props;
  const glyphs = pickGlyphs(caps);
  const [query, setQuery] = useState('');
  const [view, setView] = useState<PromptSortView>('manual');
  // THE FOCUS IS AN ID, NOT AN INDEX (D-9's cost, paid here): both filtering and
  // `Ctrl+S` can reorder the list under the cursor, and an index would silently point
  // at a different prompt after either.
  const [focusId, setFocusId] = useState<string | null>(null);
  const rows = pickerRows({ library, query, view });
  const found = rows.findIndex((row) => row.id === focusId);
  const cursor = rows.length === 0 ? 0 : Math.max(0, Math.min(found, rows.length - 1));
  const focused = rows[cursor];
  const offset = useProfileScroll(props, cursor);
  const empty = library.prompts.length === 0;

  const fill = (id: string | undefined, submit: boolean): void => {
    if (!id) return;
    props.onFill(id, submit);
  };

  useInput((input, key) => {
    if (props.isActive === false) return;
    if (key.escape) { props.onClose(); return; }
    // BEFORE `key.return`: the frame arrives with `return` false, so this branch must
    // not be reachable only through the plain-Enter path.
    if (SUBMIT_FRAMES.includes(input)) { fill(focused?.id, true); return; }
    if (key.return) { fill(focused?.id, false); return; }
    if (key.ctrl && (input === 's' || input === 'S')) { setView(nextView(view)); return; }
    if (key.upArrow) {
      if (rows.length === 0) return;
      setFocusId(rows[(cursor - 1 + rows.length) % rows.length]!.id);
      return;
    }
    if (key.downArrow) {
      if (rows.length === 0) return;
      setFocusId(rows[(cursor + 1) % rows.length]!.id);
      return;
    }
    if (key.tab) {
      // ONE OVERLAY STACK, NOT TWO (AC-23): the picker hands the manager an intent and
      // closes, and an empty library lands straight in the editor because there is
      // nothing for a list page to show.
      props.onManage(empty ? { kind: 'create' } : { kind: 'list' });
      return;
    }
    if (key.backspace || key.delete) {
      setQuery((value) => [...value].slice(0, -1).join(''));
      return;
    }
    if (key.ctrl || key.meta) return;
    const clean = stripPasteFrames(stripEnterFrames(input));
    if (clean.length === 0) return;
    if (query.length === 0) {
      // `1`-`9` PICK A ROW (AC-21). Only while the query is empty: otherwise the digit
      // is the first character of what the user is searching for.
      if (input === 'a' && empty) { props.onManage({ kind: 'create' }); return; }
      const target = pickerDigitTarget(rows, input);
      if (target !== null) { fill(target, false); return; }
    }
    setQuery((value) =>
      (value + clean).slice(0, PROMPT_PICKER_LIMITS.queryMaxChars));
    setFocusId(null);
  });

  const body: React.ReactElement[] = [
    <Text key="query" wrap="truncate" color={theme.primary}>
      {`${glyphs.caret} ${query.length > 0 ? query : '(type to filter)'}`}
    </Text>,
  ];
  for (const [at, row] of rows.entries()) {
    const isCursor = at === cursor;
    const marks = `${row.favorite ? ' [fav]' : ''}${row.tags.length > 0 ? ` #${row.tags[0]}` : ''}`;
    body.push(
      <Text key={row.id} wrap="truncate" color={isCursor ? theme.accent : theme.muted}>
        {`${isCursor ? glyphs.caret : ' '} ${row.index}. `
          + clipProfileText(`${row.title}${marks}`, cols - 12)}
      </Text>,
    );
  }
  for (const [at, line] of pickerDetail(focused, library).entries()) {
    body.push(<Text key={`detail-${at}`} wrap="truncate" color={theme.muted}>
      {clipProfileText(`  ${line}`, cols - 8)}
    </Text>);
  }

  return (
    <OverlayFrame
      title={`Pick a prompt (${rows.length}/${library.prompts.length})`}
      hint={pickerHint({ count: rows.length, query, view })}
      rows={body}
      scrollOffset={offset}
      onScrollClamp={props.onScrollClamp}
      maxRows={props.maxRows}
      cols={cols}
      theme={theme}
      caps={caps}
    />
  );
}
