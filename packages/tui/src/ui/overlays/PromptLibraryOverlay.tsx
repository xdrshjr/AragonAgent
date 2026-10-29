/**
 * The prompt manager: `Ctrl+P` (quick-prompt-library §4.4 / §6.4).
 *
 * ASCII ONLY - `src/ui/**` is inside `glyphs.test.ts::inScope`.
 *
 * A LIST PLUS A DETAIL BLOCK, the `KitPicker` idiom (F-17): three columns of prompt
 * metadata never fit on a 72-column terminal, and the detail block is how this
 * package already shows everything that does not fit in a row.
 *
 * THE OVERLAY OWNS NO DATA. Every mutation goes out through `onMutate`, and the new
 * snapshot comes back through `library`. An overlay that patched its own copy would
 * show a prompt the disk does not have (I-6), and the first time that happened the
 * user would find out at the next launch.
 */

import React, { useEffect, useReducer, useRef } from 'react';
import { Text, useInput } from 'ink';
import type { Theme } from '../theme.js';
import type { TermCapabilities } from '../capabilities.js';
import { pickGlyphs } from '../glyphs.js';
import { OverlayFrame } from '../layout/OverlayFrame.js';
import { clipProfileText, useProfileScroll } from './ModelProfilePicker.js';
import { promptDeletedCopy, promptErrorCopy, promptSavedCopy,
  PROMPT_EMPTY_BODY_COPY, PROMPT_EMPTY_TITLE_COPY } from '../../model/prompts/copy.js';
import type {
  PromptLibrary,
  PromptLibraryIntent,
  PromptLibraryMutation,
  PromptMutationResult,
} from '../../model/prompts/types.js';
import {
  INITIAL_PROMPT_LIBRARY_STATE,
  deleteDetail,
  finishPromptEditor,
  libraryDetail,
  libraryHint,
  libraryRows,
  promptLibraryReducer,
  type PromptLibraryAction,
  type PromptLibraryState,
} from './prompt-library-state.js';
import { PromptEditorPage } from './PromptEditorPage.js';

export interface PromptLibraryOverlayProps {
  isActive: boolean;
  library: PromptLibrary;
  /** D-21's one-shot hand-off; consumed at most once (I-8). */
  intent?: PromptLibraryIntent;
  cols: number;
  maxRows: number;
  scrollOffset: number;
  onScrollClamp?: (offset: number) => void;
  theme: Theme;
  caps: TermCapabilities;
  reducedMotion?: boolean;
  /** The store, reached through `App` so this component stays a view. */
  onMutate: (action: PromptLibraryMutation) => PromptMutationResult;
  /** One-shot feedback (save, delete, write failure) for `App`'s toast channel. */
  onNotice?: (level: 'info' | 'warn' | 'error', text: string) => void;
  onClose: () => void;
}

interface Dispatched {
  action: PromptLibraryAction;
  library: PromptLibrary;
}

/** The reducer takes the library as a third argument, so it is bound per dispatch. */
function reduce(state: PromptLibraryState, dispatched: Dispatched): PromptLibraryState {
  return promptLibraryReducer(state, dispatched.action, dispatched.library);
}

export function PromptLibraryOverlay(props: PromptLibraryOverlayProps): React.ReactElement {
  const { library, cols, theme, caps } = props;
  const glyphs = pickGlyphs(caps);
  const [state, rawDispatch] = useReducer(reduce, INITIAL_PROMPT_LIBRARY_STATE);
  const dispatch = (action: PromptLibraryAction): void =>
    rawDispatch({ action, library });
  const rows = libraryRows(library);
  const count = rows.length;
  const cursor = count === 0 ? 0 : Math.min(state.index, count - 1);
  const focused = rows[cursor];
  const offset = useProfileScroll(props, cursor);

  /**
   * CONSUME THE INTENT EXACTLY ONCE (I-8).
   *
   * A `useRef`, not state: the ref is written before the dispatch is processed, so a
   * StrictMode double-invoke of this effect sees `nonce <= consumed` and does nothing.
   * State would be one render behind and would open the editor twice.
   */
  const consumed = useRef(0);
  const intent = props.intent;
  useEffect(() => {
    if (!intent || intent.nonce <= consumed.current) return;
    consumed.current = intent.nonce;
    dispatch({ type: 'init', entry: intent.entry, library, nonce: intent.nonce });
  }, [intent]);

  /** One mutation, its refusal routed to the same two channels every time. */
  const mutate = (action: PromptLibraryMutation): PromptMutationResult => {
    const result = props.onMutate(action);
    if (!result.ok) props.onNotice?.('warn', promptErrorCopy(result.code));
    return result;
  };

  const save = (): void => {
    const verdict = finishPromptEditor(state.draft);
    if (!verdict.ok) {
      dispatch({ type: 'failed', code: verdict.code, field: verdict.field });
      props.onNotice?.('warn', promptErrorCopy(verdict.code));
      return;
    }
    const draft = state.draft;
    const result = draft.id === null
      ? mutate({ kind: 'create', draft })
      : mutate({ kind: 'update', id: draft.id, draft });
    if (!result.ok) {
      // THE PAGE DOES NOT CLOSE AND THE DRAFT IS NOT TOUCHED (D-12): the editor is
      // where the user has invested the most, so a refusal must cost nothing.
      dispatch({ type: 'failed', code: result.code });
      return;
    }
    dispatch({ type: 'commit', id: result.id ?? draft.id });
    props.onNotice?.('info', promptSavedCopy(draft.title.trim()));
  };

  const confirmDelete = (): void => {
    const id = state.pendingDeleteId;
    if (!id) { dispatch({ type: 'cancelled' }); return; }
    const title = library.prompts.find((prompt) => prompt.id === id)?.title ?? '';
    const result = mutate({ kind: 'delete', id });
    dispatch({ type: 'cancelled' });
    // `promptDeletedCopy`, not `promptSavedCopy`: the two sentences are one word apart
    // and the wrong one tells the user their prompt still exists.
    if (result.ok) props.onNotice?.('info', promptDeletedCopy(title));
  };

  useInput((input, key) => {
    if (props.isActive === false) return;
    // THE EDITOR PAGE OWNS EVERY KEY WHILE IT IS OPEN, Esc INCLUDED. Two `useInput`
    // hooks are live at once (this one and the page's), so handling Esc in both would
    // dispatch `esc` TWICE for one keypress: the first arms the discard and the second
    // executes it, which silently throws away a drafted body on a single Esc. The page
    // already reports Esc through `onEsc`, so this branch must stay silent.
    if (state.page === 'editor') return;
    if (state.page === 'delete') {
      if (key.escape || input === 'n' || input === 'N') { dispatch({ type: 'cancelled' }); return; }
      if (key.return || input === 'y' || input === 'Y') confirmDelete();
      return;
    }
    // --- list page ---------------------------------------------------------
    if (key.escape) { props.onClose(); return; }
    // THE RAW SEQUENCE **AND** THE PARSED CHORD (D-23, corrected by measurement).
    // Ink 5's `parse-keypress` recognises `\x1b[1;5A`, reports it as
    // `ctrl + upArrow`, and hands the component an EMPTY `input` - so the sequence
    // comparison alone would be a dead branch on this runtime, and the chord
    // comparison alone would miss a host that passes the raw bytes through. Either
    // shape reorders; `\x1b[A` (modifier lost) matches neither and only moves focus.
    const reorderUp = input === '\x1b[1;5A' || (key.ctrl && key.upArrow);
    const reorderDown = input === '\x1b[1;5B' || (key.ctrl && key.downArrow);
    if (reorderUp || reorderDown) {
      if (!focused) return;
      const result = mutate({ kind: 'move', id: focused.id, delta: reorderUp ? -1 : 1 });
      if (result.ok) dispatch({ type: 'list', focusId: focused.id });
      return;
    }
    if (key.upArrow || (key.tab && key.shift)) {
      dispatch({ type: 'focus', index: count === 0 ? 0 : (cursor - 1 + count) % count });
      return;
    }
    if (key.downArrow) {
      dispatch({ type: 'focus', index: count === 0 ? 0 : (cursor + 1) % count });
      return;
    }
    if (key.return) {
      if (focused) dispatch({ type: 'edit', id: focused.id, library });
      return;
    }
    if (key.ctrl || key.meta) return;
    if (input === 'a') { dispatch({ type: 'create' }); return; }
    if (input === 'd' && focused) { dispatch({ type: 'delete', id: focused.id }); return; }
    if (input === 'f' && focused) {
      const prompt = library.prompts.find((entry) => entry.id === focused.id);
      mutate({ kind: 'favorite', id: focused.id, favorite: prompt?.favorite !== true });
      dispatch({ type: 'list', focusId: focused.id });
    }
  });

  if (state.page === 'editor') {
    return (
      <PromptEditorPage
        isActive={props.isActive}
        state={state}
        cols={cols}
        maxRows={props.maxRows}
        theme={theme}
        caps={caps}
        {...(props.reducedMotion === undefined ? {} : { reducedMotion: props.reducedMotion })}
        onDraft={(patch) => dispatch({ type: 'draft', patch })}
        onSave={save}
        onEsc={() => dispatch({ type: 'esc' })}
        onCancel={() => dispatch({ type: 'cancelled' })}
      />
    );
  }

  const body: React.ReactElement[] = [];
  if (state.page === 'delete') {
    for (const [at, line] of deleteDetail(library, state.pendingDeleteId).entries()) {
      body.push(
        <Text key={`del-${at}`} wrap="truncate" color={at === 0 ? theme.accent : theme.muted}>
          {clipProfileText(line, cols - 8)}
        </Text>,
      );
    }
    return (
      <OverlayFrame
        title="Delete prompt"
        hint={libraryHint(state, count)}
        rows={body}
        scrollOffset={0}
        maxRows={props.maxRows}
        cols={cols}
        theme={theme}
        caps={caps}
      />
    );
  }

  for (const [at, row] of rows.entries()) {
    const isCursor = at === cursor;
    body.push(
      <Text key={row.id} wrap="truncate" color={isCursor ? theme.accent : theme.muted}>
        {`${isCursor ? glyphs.caret : ' '} ${clipProfileText(row.label, cols - 8)}`}
      </Text>,
    );
  }
  if (count === 0) {
    // TWO ROWS, NOT AN EMPTY SCREEN (§9.7): an empty list that says nothing reads as a
    // broken panel, and the key that fixes it (`a`) is not otherwise discoverable. The
    // sentences come from `prompts/copy.ts` so this state and the picker's own empty
    // state cannot drift into two wordings of the same advice.
    body.push(<Text key="empty-title" wrap="truncate" color={theme.muted}>
      {clipProfileText(PROMPT_EMPTY_TITLE_COPY, cols - 8)}
    </Text>);
    body.push(<Text key="empty-body" wrap="truncate" color={theme.muted}>
      {clipProfileText(PROMPT_EMPTY_BODY_COPY, cols - 8)}
    </Text>);
  }
  // THE DETAIL BLOCK DESCRIBES THE FOCUSED ROW ONLY, and it is last so a narrow
  // terminal clips the description rather than the list.
  for (const [at, line] of libraryDetail(focused, library, cols).entries()) {
    body.push(<Text key={`detail-${at}`} wrap="truncate" color={theme.muted}>
      {clipProfileText(`  ${line}`, cols - 8)}
    </Text>);
  }

  return (
    <OverlayFrame
      title={`Prompts${count > 0 ? ` (${count})` : ''}`}
      hint={libraryHint(state, count)}
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
