/** Sending a message and stopping a run: the two commands with behaviour worth isolating. */

import { useCallback, useEffect, useRef, useState } from 'react';
import { pushToast } from '../chat/hooks.js';
import { useT } from '../i18n/index.js';
import { composeMessage, type Draft } from '../lib/chat-drafts.js';
import { describeFailure } from '../lib/chat-results.js';
import { sessionStore } from '../store/session-store.js';

/** How long the "press Esc again" hint stays up - the host's own double-press window. */
const ESC_HINT_MS = 1500;
/** Only these two typed commands run on the host; any other leading "/" is an ordinary message. */
const TYPED_COMMAND = /^\/(clear|compact)(?:\s+([\s\S]*))?$/;

export function useSend(sessionId: string, onSent: () => void) {
  const t = useT();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = useCallback(async (draft: Draft): Promise<boolean> => {
    const message = composeMessage(draft);
    if (message.trim() === '' || sending) return false;
    const typed = draft.chips.length === 0 ? TYPED_COMMAND.exec(message.trim()) : null;
    if (!typed) {
      // An ordinary message becomes a grey bubble at once; from here the bubble owns the text and
      // its failure (Retry / Edit), so the box can empty immediately without losing anything.
      void sessionStore.sendMessage(sessionId, message);
      setError(null);
      onSent();
      return true;
    }
    setSending(true);
    setError(null);
    const result = await sessionStore.command(sessionId, { c: 'slash', name: typed[1]!, args: (typed[2] ?? '').trim() });
    setSending(false);
    if (!result.ok) {
      setError(describeFailure(t, result)); // the draft stays: nothing the user typed is lost
      return false;
    }
    onSent();
    return true;
  }, [sending, sessionId, t, onSent]);

  return { send, sending, error, clearError: () => setError(null) };
}

export function useStop(sessionId: string) {
  const t = useT();
  const [escHint, setEscHint] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  /** One press of the host's Esc ladder; returns the host's answer (`hint`, `abort`, `force-stop`). */
  const press = useCallback(async (): Promise<string | null> => {
    const result = await sessionStore.command(sessionId, { c: 'interrupt' });
    if (!result.ok) {
      pushToast(sessionId, 'error', describeFailure(t, result));
      return null;
    }
    return (result.value as { action?: string } | undefined)?.action ?? null;
  }, [sessionId, t]);

  const interrupt = useCallback(async (): Promise<void> => {
    if ((await press()) !== 'hint') return;
    setEscHint(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setEscHint(false), ESC_HINT_MS);
  }, [press]);

  /** The labelled Stop button is an explicit decision: it takes both steps of the ladder. */
  const stopRun = useCallback(async (): Promise<void> => {
    if ((await press()) === 'hint') await press();
  }, [press]);

  return { escHint, interrupt, stopRun };
}
