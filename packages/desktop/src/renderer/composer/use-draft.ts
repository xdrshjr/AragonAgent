/**
 * The composer's editable state: text, caret, pasted chips - kept per session in memory - plus the
 * ways text gets in from outside (prompt picker, the [+] menu, dropped files) and the focus rules.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { getDraft, setDraft, type PasteChipData } from '../lib/chat-drafts.js';
import { insertAt, type Edit } from '../lib/chat-triggers.js';
import { sessionStore } from '../store/session-store.js';
import { useUi } from '../store/ui-store.js';
import { onComposerIntent } from './composer-bus.js';

/** Twelve 20 px lines plus the vertical padding; the CSS line-height must stay 20 px. */
const MAX_INPUT_HEIGHT = 12 * 20 + 16;

/** Insert requests from the prompt picker are applied once per nonce, even across remounts. */
let consumedInsertNonce = 0;

export interface DraftState {
  text: string;
  chips: PasteChipData[];
  caret: number;
  inputRef: MutableRefObject<HTMLTextAreaElement | null>;
  setText(text: string): void;
  setChips(update: (current: PasteChipData[]) => PasteChipData[]): void;
  setCaret(caret: number): void;
  /** Replace the text and place the caret once React has committed it. */
  applyEdit(edit: Edit): void;
  insertText(value: string): void;
  clear(): void;
}

export function useDraft(sessionId: string): DraftState {
  const initial = useMemo(() => getDraft(sessionId), [sessionId]);
  const [text, setText] = useState(initial.text);
  const [chips, setChips] = useState<PasteChipData[]>(initial.chips);
  const [caret, setCaret] = useState(initial.text.length);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const pendingCaret = useRef<number | null>(null);
  const latest = useRef({ text, caret });
  latest.current = { text, caret };
  const focusNonce = useUi((state) => state.composerFocusNonce);
  const insertRequest = useUi((state) => state.composerInsert);

  useEffect(() => { setDraft(sessionId, { text, chips }); }, [sessionId, text, chips]);

  // Grow with the content up to twelve lines, then scroll inside the box.
  useLayoutEffect(() => {
    const element = inputRef.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, MAX_INPUT_HEIGHT)}px`;
  }, [text]);

  useLayoutEffect(() => {
    if (pendingCaret.current === null) return;
    inputRef.current?.setSelectionRange(pendingCaret.current, pendingCaret.current);
    pendingCaret.current = null;
  });

  useEffect(() => {
    // An approval card asks for focus on its Deny button; do not take it back on first mount.
    if (focusNonce === 0 && (sessionStore.get(sessionId)?.requests.length ?? 0) > 0) return;
    inputRef.current?.focus();
  }, [focusNonce, sessionId]);

  const applyEdit = useCallback((edit: Edit): void => {
    pendingCaret.current = edit.caret;
    setText(edit.text);
    setCaret(edit.caret);
  }, []);

  const insertText = useCallback((value: string): void => {
    applyEdit(insertAt(latest.current.text, latest.current.caret, value));
    inputRef.current?.focus();
  }, [applyEdit]);

  useEffect(() => {
    if (!insertRequest || insertRequest.nonce <= consumedInsertNonce) return;
    consumedInsertNonce = insertRequest.nonce;
    insertText(insertRequest.text);
  }, [insertRequest, insertText]);
  useEffect(() => onComposerIntent('insert-at', (value) => insertText(value ?? '')), [insertText]);

  // A withdrawn queued message comes back here: replace an empty box, otherwise append on a new
  // line so whatever the user has since typed is never overwritten. Caret ends after the text.
  useEffect(() => onComposerIntent('restore-text', (value) => {
    if (!value) return;
    const current = latest.current.text;
    const next = current.trim().length === 0 ? value : `${current}\n${value}`;
    applyEdit({ text: next, caret: next.length });
    inputRef.current?.focus();
  }), [applyEdit]);

  const clear = useCallback((): void => { setText(''); setChips([]); setCaret(0); }, []);
  return { text, chips, caret, inputRef, setText, setChips, setCaret, applyEdit, insertText, clear };
}
