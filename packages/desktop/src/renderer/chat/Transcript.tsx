/**
 * The conversation: a windowed list of every `Entry`, pinned to the tail while the user has not
 * scrolled away. Rows are memoised on primitive props (the reducer is immutable, so an
 * unchanged entry keeps its reference) and only the rows near the viewport are in the DOM.
 */

import { ArrowDown } from 'lucide-react';
import {
  forwardRef, useCallback, useImperativeHandle, useLayoutEffect, useMemo, useRef,
  type ReactNode,
} from 'react';
import type { Entry } from '@aragon-agent/tui/model/agent/reducer';
import { useT } from '../i18n/index.js';
import type { ErrorAction } from '../lib/chat-errors.js';
import { useSession, type PendingSend } from '../store/session-store.js';
import { PendingSendRow } from './PendingSendRow.js';
import { Button } from '../ui/primitives.js';
import { runErrorAction } from './error-actions.js';
import { TranscriptItem } from './TranscriptItem.js';
import { useVirtualScroll } from './use-virtual-scroll.js';

export interface TranscriptHandle {
  /** Resume following the tail (called when the user sends a message). */
  resumeFollow(): void;
  /** Scroll entry `index` into the middle of the view (find); the tail stops being followed. */
  scrollToEntry(index: number): void;
  isFollowing(): boolean;
}

/** A row wrapper that reports its measured height to the shared ResizeObserver. */
function MeasuredRow(props: { id: string; index: number; observer: ResizeObserver | null; children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const { observer } = props;
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !observer) return undefined;
    observer.observe(element);
    return () => observer.unobserve(element);
  }, [observer]);
  return <div ref={ref} className="row" data-id={props.id} data-index={props.index}>{props.children}</div>;
}

/** 1-based position of each queued entry among the queued ones (0 for every other kind). */
function queueNumbers(entries: readonly Entry[]): number[] {
  let count = 0;
  return entries.map((entry) => (entry.kind === 'queued' ? ++count : 0));
}

const NO_ENTRIES: Entry[] = [];
const NO_SENDS: readonly PendingSend[] = [];

export const Transcript = forwardRef<TranscriptHandle, { sessionId: string; tail?: ReactNode }>(function Transcript(props, handle) {
  const t = useT();
  const { sessionId } = props;
  const entries = useSession(sessionId, (mirror) => mirror?.view?.entries) ?? NO_ENTRIES;
  const expandedIds = useSession(sessionId, (mirror) => mirror?.view?.expandedToolIds);
  const thinkingVisible = useSession(sessionId, (mirror) => mirror?.view?.thinkingVisible) ?? false;
  const running = useSession(sessionId, (mirror) => mirror?.view?.status === 'running');
  const dropped = useSession(sessionId, (mirror) => mirror?.view?.droppedEntries) ?? 0;
  const pendingSends = useSession(sessionId, (mirror) => mirror?.pendingSends) ?? NO_SENDS;

  const scroll = useVirtualScroll(entries);
  useImperativeHandle(handle, () => ({
    resumeFollow: scroll.resume, scrollToEntry: scroll.scrollToIndex, isFollowing: scroll.isFollowing,
  }), [scroll.resume, scroll.scrollToIndex, scroll.isFollowing]);
  const queued = useMemo(() => queueNumbers(entries), [entries]);
  const onErrorAction = useCallback((action: ErrorAction): void => {
    void runErrorAction(sessionId, action, t);
  }, [sessionId, t]);

  const rows: ReactNode[] = [];
  for (let index = scroll.range.start; index < scroll.range.end; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    rows.push(
      <MeasuredRow key={entry.id} id={entry.id} index={index} observer={scroll.observer}>
        <TranscriptItem
          sessionId={sessionId} entry={entry} expanded={expandedIds?.[entry.id] === true}
          thinkingVisible={thinkingVisible} running={running} queueNumber={queued[index] ?? 0}
          canRetry={!running && index >= entries.length - 2} onErrorAction={onErrorAction} />
      </MeasuredRow>,
    );
  }

  return (
    <div className="transcript-wrap">
      {/* Live announcements only while pinned to the tail: rows mounted by scrolling are not news. */}
      <div ref={scroll.scrollerRef} className="transcript" role="log" aria-label={t('chat.transcript')}
        aria-live={scroll.following ? 'polite' : 'off'} aria-relevant="additions" tabIndex={0} {...scroll.handlers}>
        <div className="transcript-inner">
          {dropped > 0 ? <div className="trimmed">{t('chat.trimmed', { n: dropped })}</div> : null}
          {entries.length === 0 ? <div className="transcript-empty">{t('chat.empty')}</div> : null}
          <div aria-hidden="true" style={{ height: scroll.topSpace }} />
          {rows}
          <div aria-hidden="true" style={{ height: scroll.bottomSpace }} />
          {pendingSends.map((send) => <PendingSendRow key={send.localId} sessionId={sessionId} send={send} />)}
          {props.tail}
        </div>
      </div>
      {scroll.showJump ? (
        <Button className="jump" size="sm" onClick={scroll.resume}>
          <ArrowDown size={14} strokeWidth={1.5} aria-hidden="true" /> {t('chat.backToBottom')}
        </Button>
      ) : null}
    </div>
  );
});
