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
import {
  groupOfEntry, groupToolRuns, isToolGroup, rowIndexOfEntry, type TranscriptRow,
} from '../lib/chat-tool-groups.js';
import { useSession, type PendingSend } from '../store/session-store.js';
import { useUi } from '../store/ui-store.js';
import { ActivityRow } from './ActivityRow.js';
import { useVoice } from '../lib/voice.js';
import { PendingSendRow } from './PendingSendRow.js';
import { Button } from '../ui/primitives.js';
import { runErrorAction } from './error-actions.js';
import { ToolGroupCard } from './tools/ToolGroupCard.js';
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
function queueNumbers(rows: readonly TranscriptRow[]): number[] {
  let count = 0;
  return rows.map((row) => (row.kind === 'queued' ? ++count : 0));
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

  const { voiceMode } = useVoice();
  const groupingOn = useUi((state) => state.groupToolRuns);
  const expandedGroups = useUi((state) => state.expandedToolGroups);
  // The list is ROWS, not entries: a run of finished reads / searches is one row. With the feature
  // off (or in developer mode) this is the entries array itself, so nothing downstream changes.
  const rows = useMemo(
    () => groupToolRuns(entries, { enabled: groupingOn, voiceMode, expanded: expandedGroups }),
    [entries, groupingOn, voiceMode, expandedGroups],
  );
  const scroll = useVirtualScroll(rows);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  useImperativeHandle(handle, () => ({
    resumeFollow: scroll.resume,
    // Find hands over an ENTRY index; the list is indexed by row. A match folded into a group opens
    // that group first (the row is only worth scrolling to once its members exist).
    scrollToEntry: (entryIndex: number): void => {
      const entry = entriesRef.current[entryIndex];
      if (!entry) return;
      const group = groupOfEntry(rowsRef.current, entry.id);
      if (group && !group.expanded) useUi.getState().expandToolGroup(group.id);
      scroll.scrollToIndex(rowIndexOfEntry(rowsRef.current, entry.id));
    },
    isFollowing: scroll.isFollowing,
  }), [scroll.resume, scroll.scrollToIndex, scroll.isFollowing]);
  const queued = useMemo(() => queueNumbers(rows), [rows]);
  const onErrorAction = useCallback((action: ErrorAction): void => {
    void runErrorAction(sessionId, action, t);
  }, [sessionId, t]);

  const visibleRows = rows;
  const rendered: ReactNode[] = [];
  for (let index = scroll.range.start; index < scroll.range.end; index += 1) {
    const row = visibleRows[index];
    if (!row) continue;
    if (isToolGroup(row)) {
      rendered.push(
        <MeasuredRow key={row.id} id={row.id} index={index} observer={scroll.observer}>
          <ToolGroupCard sessionId={sessionId} group={row} expandedIds={expandedIds} voiceMode={voiceMode} />
        </MeasuredRow>,
      );
      continue;
    }
    rendered.push(
      <MeasuredRow key={row.id} id={row.id} index={index} observer={scroll.observer}>
        <TranscriptItem
          sessionId={sessionId} entry={row} expanded={expandedIds?.[row.id] === true}
          thinkingVisible={thinkingVisible} running={running} queueNumber={queued[index] ?? 0}
          canRetry={!running && index >= visibleRows.length - 2} voiceMode={voiceMode}
          onErrorAction={onErrorAction} />
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
          {rendered}
          <div aria-hidden="true" style={{ height: scroll.bottomSpace }} />
          {pendingSends.map((send) => <PendingSendRow key={send.localId} sessionId={sessionId} send={send} />)}
          <ActivityRow sessionId={sessionId} voiceMode={voiceMode} />
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
