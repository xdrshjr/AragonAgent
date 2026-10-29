/**
 * Find in the conversation (Ctrl/Cmd+F). Searches the entries, not the DOM (the transcript is
 * virtualised), jumps the list to the match and highlights it in its row.
 *
 * Enter / F3 next, Shift+Enter / Shift+F3 previous, Esc closes and hands focus back to the composer.
 * While open the transcript does not follow the tail - a streaming reply would otherwise pull the
 * view away from the match; closing restores whatever the user had before.
 */

import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { useT } from '../i18n/index.js';
import { findMatches, stepMatch } from '../lib/chat-find.js';
import { sessionStore, useSession } from '../store/session-store.js';
import { useUi } from '../store/ui-store.js';
import { IconButton } from '../ui/primitives.js';
import { clearHighlights, highlightRow } from './find-highlight.js';
import type { TranscriptHandle } from './Transcript.js';

const QUERY_DEBOUNCE_MS = 120;
/** Frames to wait for a virtualised row to mount after scrolling to it. */
const MOUNT_FRAMES = 12;

export function FindBar({ sessionId, transcript }: { sessionId: string; transcript: RefObject<TranscriptHandle | null> }) {
  const t = useT();
  const entries = useSession(sessionId, (mirror) => mirror?.view?.entries);
  const dropped = useSession(sessionId, (mirror) => mirror?.view?.droppedEntries) ?? 0;
  const close = useUi((state) => state.setFindSession);
  const [raw, setRaw] = useState('');
  const [query, setQuery] = useState('');
  const [current, setCurrent] = useState(-1);
  const input = useRef<HTMLInputElement | null>(null);
  const wasFollowing = useRef(transcript.current?.isFollowing() ?? true);

  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);
  useEffect(() => {
    const timer = setTimeout(() => setQuery(raw), QUERY_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [raw]);

  const result = useMemo(() => findMatches(entries ?? [], query), [entries, query]);
  const count = result.matches.length;

  // A new query starts at the first match; a growing transcript keeps the position if still valid.
  useEffect(() => { setCurrent(count === 0 ? -1 : 0); }, [query]);
  useEffect(() => { if (current >= count) setCurrent(count === 0 ? -1 : count - 1); }, [count, current]);

  // Re-run when the TARGET changes (which match, which query), not whenever the transcript grows: a streaming
  // token replaces `result.matches` with an equal-valued array on every update and must not re-jump the view.
  const targetMatch = result.matches[current];
  const targetKey = targetMatch ? `${targetMatch.entryIndex}:${targetMatch.start}` : '';

  useEffect(() => {
    const match = result.matches[current];
    if (!match || !entries) return undefined;
    const entry = entries[match.entryIndex];
    // Which occurrence inside that entry is the current one (entries can hold several).
    const occurrence = result.matches.slice(0, current).filter((other) => other.entryIndex === match.entryIndex).length;
    transcript.current?.scrollToEntry(match.entryIndex);
    if (entry?.kind === 'tool' && sessionStore.get(sessionId)?.view?.expandedToolIds[entry.id] !== true) {
      sessionStore.dispatchLocal(sessionId, { type: 'toggleExpand', id: entry.id });
    }
    let frame = 0;
    let tries = 0;
    const apply = (): void => {
      const row = document.querySelector(`.transcript [data-index="${match.entryIndex}"]`);
      if (!row) {
        tries += 1;
        if (tries < MOUNT_FRAMES) frame = requestAnimationFrame(apply);
        return;
      }
      const range = highlightRow(row, query, occurrence);
      const target = range?.startContainer.parentElement ?? (row as HTMLElement);
      target.scrollIntoView?.({ block: 'nearest' });
      row.setAttribute('data-find-current', 'true');
    };
    frame = requestAnimationFrame(apply);
    return () => {
      cancelAnimationFrame(frame);
      clearHighlights();
      document.querySelector('[data-find-current]')?.removeAttribute('data-find-current');
    };
    // `entries` / `result.matches` are deliberately not dependencies (see `targetKey`).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, query, targetKey]);

  useEffect(() => () => {
    clearHighlights();
    if (wasFollowing.current) transcript.current?.resumeFollow();
  }, [transcript]);

  const step = (direction: 1 | -1): void => setCurrent((held) => stepMatch(held, count, direction));
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close(null);
      useUi.getState().focusComposer();
    } else if (event.key === 'Enter' || event.key === 'F3') {
      event.preventDefault();
      step(event.shiftKey ? -1 : 1);
    }
  };

  const status = query === '' ? '' : count === 0
    ? t('chat.find.none')
    : t(result.truncated ? 'chat.find.countMore' : 'chat.find.count', { n: current + 1, total: count });

  return (
    <div className="find-bar" role="search" aria-label={t('chat.find.label')} title={dropped > 0 ? t('chat.find.partial', { n: entries?.length ?? 0, dropped }) : undefined}>
      <input ref={input} className="find-input" type="text" value={raw} placeholder={t('chat.find.placeholder')}
        aria-label={t('chat.find.label')} spellCheck={false} onChange={(event) => setRaw(event.target.value)} onKeyDown={onKeyDown} />
      <span className="find-count" aria-live="polite" data-empty={query !== '' && count === 0 ? 'true' : undefined}>{status}</span>
      <IconButton size="sm" label={t('chat.find.prev')} disabled={count === 0} onClick={() => step(-1)}>
        <ChevronUp size={14} strokeWidth={1.5} />
      </IconButton>
      <IconButton size="sm" label={t('chat.find.next')} disabled={count === 0} onClick={() => step(1)}>
        <ChevronDown size={14} strokeWidth={1.5} />
      </IconButton>
      {dropped > 0 ? <span className="sr-only">{t('chat.find.partial', { n: entries?.length ?? 0, dropped })}</span> : null}
      <IconButton size="sm" label={t('chat.find.close')} onClick={() => { close(null); useUi.getState().focusComposer(); }}>
        <X size={14} strokeWidth={1.5} />
      </IconButton>
    </div>
  );
}
