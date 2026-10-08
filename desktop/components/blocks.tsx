'use client';

/**
 * Transcript building blocks: user and assistant messages, thinking blocks,
 * notices (retry/compaction/team/errors), fast-review rows, per-turn result
 * footers, the TODO panel, and optimistic pending-user echoes.
 */

import { useState } from 'react';
import { formatCost, formatDuration, formatTokens } from '@lib/format';
import { Markdown } from './Markdown';
import { AlertIcon, BrainIcon, CheckIcon, ChevronIcon, SparkIcon } from './Icons';

export function UserMessage({ text, source }: { text: string; source: string }) {
  return (
    <div className="row-in" style={{ margin: '18px 0 6px' }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--ink-3)', letterSpacing: '0.06em', marginBottom: 5 }}>
        {source === 'todo_continue' ? 'YOU (auto-continue)' : 'YOU'}
      </div>
      <div
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--line)',
          borderRadius: '4px 14px 14px 14px',
          padding: '10px 14px',
          whiteSpace: 'pre-wrap',
          fontSize: 14.5,
          lineHeight: 1.6,
        }}
      >
        {text}
      </div>
    </div>
  );
}

export function PendingUser({ text }: { text: string }) {
  return (
    <div className="row-in" style={{ margin: '18px 0 6px', opacity: 0.55 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--ink-3)', letterSpacing: '0.06em', marginBottom: 5 }}>
        YOU - QUEUED
      </div>
      <div
        style={{
          border: '1px dashed var(--line-strong)',
          borderRadius: '4px 14px 14px 14px',
          padding: '10px 14px',
          whiteSpace: 'pre-wrap',
          fontSize: 14.5,
          lineHeight: 1.6,
          color: 'var(--ink-2)',
        }}
      >
        {text}
      </div>
    </div>
  );
}

export function AssistantMessage({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <div className="row-in" style={{ margin: '14px 0' }}>
      <div style={{ display: 'flex', gap: 12 }}>
        <div
          style={{
            width: 26,
            height: 26,
            borderRadius: 9,
            background: 'var(--accent-soft)',
            color: 'var(--accent-ink)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            marginTop: 2,
          }}
        >
          <SparkIcon size={14} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Markdown text={streaming ? `${text}` : text} />
          {streaming ? <span className="caret" style={{ display: 'block', height: 4 }} /> : null}
        </div>
      </div>
    </div>
  );
}

export function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const words = text.trim().split(/\s+/).length;
  return (
    <div className="row-in" style={{ margin: '10px 0' }}>
      <button
        className="btn btn-ghost"
        style={{ padding: '5px 10px', fontSize: 12.5, color: 'var(--ink-3)', borderRadius: 'var(--radius-sm)' }}
        onClick={() => setOpen((value) => !value)}
      >
        <BrainIcon size={13} />
        {open ? 'Hide' : 'Thought'} process ({words} words)
        <ChevronIcon size={12} style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform var(--speed) var(--ease)' }} />
      </button>
      {open ? (
        <div
          style={{
            marginTop: 6,
            padding: '10px 14px',
            borderLeft: '3px solid var(--accent-soft)',
            color: 'var(--ink-2)',
            fontSize: 13,
            lineHeight: 1.6,
            whiteSpace: 'pre-wrap',
            maxHeight: 320,
            overflowY: 'auto',
          }}
        >
          {text}
        </div>
      ) : null}
    </div>
  );
}

export function NoticeRow({ tone, title, detail }: { tone: 'info' | 'warn' | 'error'; title: string; detail: string }) {
  const palette =
    tone === 'error'
      ? { bg: 'var(--danger-soft)', fg: '#8c3830' }
      : tone === 'warn'
        ? { bg: 'var(--warn-soft)', fg: '#6b5320' }
        : { bg: 'var(--info-soft)', fg: 'var(--ink-2)' };
  return (
    <div
      className="row-in"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        margin: '8px 0',
        padding: '6px 12px',
        borderRadius: 'var(--radius-sm)',
        background: palette.bg,
        color: palette.fg,
        fontSize: 12.5,
      }}
    >
      {tone === 'error' ? <AlertIcon size={13} /> : null}
      <span style={{ fontWeight: 500 }}>{title}</span>
      {detail ? <span style={{ opacity: 0.75 }}>- {detail}</span> : null}
    </div>
  );
}

export function ReviewRow({ model, text }: { model: string; text: string }) {
  return (
    <div
      className="row-in"
      style={{
        margin: '8px 0',
        padding: '8px 14px',
        borderRadius: 'var(--radius-sm)',
        border: '1px dashed var(--line-strong)',
        fontSize: 12.5,
        color: 'var(--ink-2)',
      }}
    >
      <span style={{ fontWeight: 600, color: 'var(--ink-3)', letterSpacing: '0.04em' }}>FAST REVIEW</span>
      <span style={{ color: 'var(--ink-faint)', margin: '0 6px' }}>|</span>
      {model}
      <div style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>{text}</div>
    </div>
  );
}

export function ResultRow({
  isError,
  stopReason,
  durationMs,
  usage,
  cost,
}: {
  isError: boolean;
  stopReason: string;
  durationMs: number;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  cost: { amount: number; known: boolean };
}) {
  if (isError) {
    return (
      <div
        className="row-in"
        style={{
          margin: '10px 0',
          padding: '7px 12px',
          borderRadius: 'var(--radius-sm)',
          background: 'var(--danger-soft)',
          color: '#8c3830',
          fontSize: 12.5,
          display: 'flex',
          gap: 8,
          alignItems: 'center',
        }}
      >
        <AlertIcon size={13} /> Turn failed ({stopReason})
      </div>
    );
  }
  const costText = formatCost(cost.amount, cost.known);
  return (
    <div
      className="row-in"
      style={{
        margin: '10px 0 4px',
        display: 'flex',
        gap: 14,
        color: 'var(--ink-3)',
        fontSize: 11.5,
        borderTop: '1px solid var(--line)',
        paddingTop: 7,
      }}
    >
      <span title="Input / output tokens">
        {formatTokens(usage.inputTokens)} in - {formatTokens(usage.outputTokens)} out
      </span>
      <span>{formatDuration(durationMs)}</span>
      {costText ? <span>{costText}</span> : null}
      {stopReason !== 'end_turn' ? <span style={{ color: 'var(--warn)' }}>({stopReason})</span> : null}
    </div>
  );
}

export function TodoPanel({
  items,
  activeIndex,
}: {
  items: { content: string; status: string }[];
  activeIndex: number;
}) {
  const done = items.filter((item) => item.status === 'completed').length;
  return (
    <div
      className="row-in"
      style={{
        margin: '12px 0',
        border: '1px solid var(--line)',
        borderRadius: 'var(--radius-md)',
        background: 'var(--surface)',
        overflow: 'hidden',
        boxShadow: 'var(--shadow-1)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 14px',
          borderBottom: '1px solid var(--line)',
          fontSize: 12,
          fontWeight: 600,
          color: 'var(--ink-2)',
          letterSpacing: '0.04em',
        }}
      >
        PLAN
        <span style={{ color: 'var(--ink-3)', fontWeight: 500 }}>
          {done}/{items.length}
        </span>
      </div>
      <div style={{ padding: '6px 8px' }}>
        {items.map((item, index) => (
          <div
            key={`${index}-${item.content.slice(0, 16)}`}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
              padding: '4px 8px',
              borderRadius: 6,
              background: index === activeIndex ? 'var(--accent-soft)' : 'transparent',
              fontSize: 13,
              color: item.status === 'completed' ? 'var(--ink-3)' : 'var(--ink)',
            }}
          >
            <span
              style={{
                width: 16,
                height: 16,
                borderRadius: 5,
                border:
                  item.status === 'completed'
                    ? 'none'
                    : index === activeIndex
                      ? '1.5px solid var(--accent)'
                      : '1.5px solid var(--line-strong)',
                background: item.status === 'completed' ? 'var(--ok)' : 'transparent',
                color: '#fff',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                marginTop: 2,
              }}
            >
              {item.status === 'completed' ? <CheckIcon size={10} /> : null}
            </span>
            <span style={{ textDecoration: item.status === 'completed' ? 'line-through' : 'none' }}>
              {item.content}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
