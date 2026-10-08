'use client';

/**
 * Tool call card: icon + name + one-line summary, expandable to full input
 * parameters and (clipped) output. Mirrors what the model actually saw.
 */

import { useState } from 'react';
import type { ToolEntry } from '@shared/fold';
import { formatBytes, formatDuration } from '@lib/format';
import { CheckIcon, ChevronIcon } from './Icons';
import { ToolGlyph } from './ToolGlyph';

const OUTPUT_CLIP = 8000;

export default function ToolCard({ entry }: { entry: ToolEntry }) {
  const [open, setOpen] = useState(false);
  const done = entry.status === 'done';
  const summary = summarizeTool(entry.name, entry.input);
  const output = entry.output ?? '';

  return (
    <div
      className="row-in"
      style={{
        margin: '7px 0',
        border: '1px solid var(--line)',
        borderRadius: 'var(--radius-md)',
        background: 'var(--surface)',
        overflow: 'hidden',
        transition: 'border-color var(--speed) var(--ease)',
      }}
    >
      <button
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          padding: '8px 12px',
          textAlign: 'left',
        }}
        onClick={() => setOpen((value) => !value)}
      >
        <ToolGlyph name={entry.name} done={done} error={entry.isError} />
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, fontWeight: 600, color: 'var(--ink)' }}>
          {entry.name}
        </span>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 12.5,
            color: 'var(--ink-3)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {summary}
        </span>
        {done && entry.durationMs !== null ? (
          <span style={{ fontSize: 11, color: 'var(--ink-faint)', flexShrink: 0 }}>
            {formatDuration(entry.durationMs)}
          </span>
        ) : (
          <span style={{ display: 'inline-flex', gap: 3, flexShrink: 0 }}>
            <span className="dot" style={{ width: 4, height: 4 }} />
            <span className="dot" style={{ width: 4, height: 4 }} />
            <span className="dot" style={{ width: 4, height: 4 }} />
          </span>
        )}
        <ChevronIcon
          size={13}
          style={{
            flexShrink: 0,
            color: 'var(--ink-3)',
            transform: open ? 'rotate(90deg)' : 'none',
            transition: 'transform var(--speed) var(--ease)',
          }}
        />
      </button>
      {open ? (
        <div style={{ borderTop: '1px solid var(--line)', padding: '10px 12px', display: 'grid', gap: 10 }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--ink-3)', letterSpacing: '0.05em', marginBottom: 4 }}>
              INPUT
            </div>
            <pre
              style={{
                margin: 0,
                fontFamily: 'var(--font-mono)',
                fontSize: 12,
                lineHeight: 1.55,
                color: 'var(--ink-2)',
                background: 'var(--surface-sunken)',
                borderRadius: 'var(--radius-sm)',
                padding: '8px 10px',
                overflowX: 'auto',
                maxHeight: 260,
                overflowY: 'auto',
                whiteSpace: 'pre-wrap',
              }}
            >
              {JSON.stringify(entry.input, null, 2)}
            </pre>
          </div>
          {output ? (
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--ink-3)', letterSpacing: '0.05em', marginBottom: 4 }}>
                OUTPUT {entry.isError ? '- ERROR' : ''} ({formatBytes(output.length)}
                {output.length > OUTPUT_CLIP ? ', clipped' : ''})
              </div>
              <pre
                style={{
                  margin: 0,
                  fontFamily: 'var(--font-mono)',
                  fontSize: 12,
                  lineHeight: 1.55,
                  color: entry.isError ? 'var(--danger)' : 'var(--ink-2)',
                  background: 'var(--surface-sunken)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '8px 10px',
                  maxHeight: 320,
                  overflow: 'auto',
                  whiteSpace: 'pre-wrap',
                }}
              >
                {output.length > OUTPUT_CLIP ? `${output.slice(0, OUTPUT_CLIP)}\n...` : output}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** One-line human summary of a tool call for the collapsed card. */
function summarizeTool(name: string, input: Record<string, unknown>): string {
  const pick = (...keys: string[]): string => {
    for (const key of keys) {
      const value = input[key];
      if (typeof value === 'string' && value.length > 0) return value;
    }
    return '';
  };
  switch (name) {
    case 'read_file':
      return pick('path');
    case 'write_file':
      return pick('path');
    case 'edit_file':
      return pick('path');
    case 'list_dir':
      return pick('path', 'default');
    case 'glob':
      return pick('pattern');
    case 'grep':
      return pick('pattern');
    case 'bash': {
      const command = pick('command');
      return command.length > 90 ? `${command.slice(0, 89)}...` : command;
    }
    case 'skill':
      return pick('name');
    case 'todo_write':
      return 'update plan';
    case 'task':
      return pick('description');
    default:
      return pick('path', 'name', 'description', 'pattern', 'text', 'command');
  }
}
