'use client';

/**
 * The scrollable conversation area. Auto-follows new content unless the user
 * scrolls up (then a "jump to latest" affordance appears).
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { SessionView } from '@lib/store';
import type { TranscriptEntry } from '@shared/fold';
import { isRunning } from '@lib/format';
import { ChevronIcon } from './Icons';
import {
  AssistantMessage,
  NoticeRow,
  PendingUser,
  ResultRow,
  ReviewRow,
  ThinkingBlock,
  TodoPanel,
  UserMessage,
} from './blocks';
import ToolCard from './ToolCard';

export default function Transcript({ view }: { view: SessionView }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const entries = view.fold.entries;

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    setFollow(distance < 80);
  };

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
  }, [entries.length, view.rev, follow]);

  // Re-follow when switching sessions.
  useEffect(() => {
    setFollow(true);
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [view.meta.id]);

  const empty = entries.length === 0 && view.pending.length === 0;

  return (
    <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        style={{ height: '100%', overflowY: 'auto', padding: '20px 20px 12px' }}
      >
        <div style={{ maxWidth: 780, margin: '0 auto' }}>
          {empty ? <EmptyHints running={isRunning(view.phase)} /> : null}
          {entries.map((entry, index) => (
            <div key={entry.key}>
              {view.dividers.includes(index) ? <ContextDivider /> : null}
              <EntryRow entry={entry} />
            </div>
          ))}
          {view.pending.map((text, index) => (
            <PendingUser key={`pending-${index}-${text.slice(0, 12)}`} text={text} />
          ))}
          {view.phase === 'running' && lastIsSettled(entries) ? <WorkingLine label="working..." /> : null}
          {view.phase === 'starting' ? <WorkingLine label="starting the agent..." /> : null}
          <div style={{ height: 8 }} />
        </div>
      </div>
      {!follow ? (
        <button
          className="btn btn-secondary"
          style={{
            position: 'absolute',
            bottom: 14,
            left: '50%',
            transform: 'translateX(-50%)',
            padding: '5px 12px',
            fontSize: 12.5,
            boxShadow: 'var(--shadow-2)',
          }}
          onClick={() => {
            setFollow(true);
            const el = scrollRef.current;
            if (el) el.scrollTop = el.scrollHeight;
          }}
        >
          <ChevronIcon size={13} style={{ transform: 'rotate(90deg)' }} /> Jump to latest
        </button>
      ) : null}
    </div>
  );
}

function EntryRow({ entry }: { entry: TranscriptEntry }) {
  switch (entry.kind) {
    case 'user':
      return <UserMessage key={entry.key} text={entry.text} source={entry.source} />;
    case 'assistant':
      return <AssistantMessage key={entry.key} text={entry.text} streaming={entry.streaming} />;
    case 'thinking':
      return <ThinkingBlock key={entry.key} text={entry.text} />;
    case 'tool':
      return <ToolCard key={entry.key} entry={entry} />;
    case 'todo':
      return <TodoPanel key={entry.key} items={entry.items} activeIndex={entry.activeIndex} />;
    case 'notice':
      return <NoticeRow key={entry.key} tone={entry.tone} title={entry.title} detail={entry.detail} />;
    case 'review':
      return <ReviewRow key={entry.key} model={entry.model} text={entry.text} />;
    case 'result':
      return (
        <ResultRow
          key={entry.key}
          isError={entry.isError}
          stopReason={entry.stopReason}
          durationMs={entry.durationMs}
          usage={entry.usage}
          cost={entry.cost}
        />
      );
    default:
      return null;
  }
}

function EmptyHints({ running }: { running: boolean }) {
  if (running) return null;
  return (
    <div style={{ textAlign: 'center', padding: '48px 0 24px', color: 'var(--ink-3)', fontSize: 13 }}>
      Ask anything about the files in this folder - the agent can read, search, edit and run them.
    </div>
  );
}

function ContextDivider() {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        margin: '18px 0 10px',
        color: 'var(--ink-3)',
        fontSize: 11.5,
        letterSpacing: '0.05em',
      }}
    >
      <span style={{ flex: 1, height: 1, background: 'var(--line-strong)' }} />
      CONTEXT CLEARED - the model starts fresh; history stays for you
      <span style={{ flex: 1, height: 1, background: 'var(--line-strong)' }} />
    </div>
  );
}

function WorkingLine({ label }: { label: string }) {
  return (
    <div className="row-in" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 2px' }}>
      <span style={{ display: 'inline-flex', gap: 4 }}>
        <span className="dot" />
        <span className="dot" />
        <span className="dot" />
      </span>
      <span style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>{label}</span>
    </div>
  );
}

function lastIsSettled(entries: TranscriptEntry[]): boolean {
  const last = entries[entries.length - 1];
  if (!last) return true;
  if (last.kind === 'assistant') return !last.streaming;
  return true;
}
