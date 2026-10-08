'use client';

/**
 * The composer: auto-growing multiline input, Enter to send / Shift+Enter for
 * newline, Stop while a turn runs, queued-message awareness, fatal error surfacing.
 */

import { useEffect, useRef } from 'react';
import type { SessionPhase } from '@shared/protocol';
import { SendIcon, StopIcon } from './Icons';

export interface ComposerProps {
  disabled: boolean;
  running: boolean;
  draft: string;
  phase: SessionPhase;
  fatal: string | null;
  onDraft: (text: string) => void;
  onSend: (text: string) => void;
  onInterrupt: () => void;
}

const MAX_HEIGHT = 200;

export default function Composer({ disabled, running, draft, fatal, onDraft, onSend, onInterrupt }: ComposerProps) {
  const areaRef = useRef<HTMLTextAreaElement>(null);
  void disabled;

  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [draft]);

  const submit = () => {
    const text = draft.trim();
    if (text.length === 0) return;
    onSend(text);
    onDraft('');
  };

  return (
    <div style={{ padding: '10px 20px 16px', background: 'var(--bg)' }}>
      <div style={{ maxWidth: 780, margin: '0 auto' }}>
        {fatal ? (
          <div
            style={{
              marginBottom: 8,
              padding: '7px 12px',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--danger-soft)',
              color: '#8c3830',
              fontSize: 12.5,
            }}
          >
            {fatal}
          </div>
        ) : null}
        <div
          style={{
            background: 'var(--surface)',
            border: '1px solid var(--line-strong)',
            borderRadius: 'var(--radius-lg)',
            boxShadow: 'var(--shadow-1)',
            padding: '10px 12px 8px',
            transition: 'border-color var(--speed) var(--ease), box-shadow var(--speed) var(--ease)',
          }}
          className="composer-shell"
        >
          <textarea
            ref={areaRef}
            value={draft}
            onChange={(event) => onDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
            placeholder={'Ask the agent to read, search, edit or run anything...'}
            rows={1}
            style={{
              width: '100%',
              border: 'none',
              outline: 'none',
              resize: 'none',
              background: 'transparent',
              fontFamily: 'var(--font-sans)',
              fontSize: 14.5,
              lineHeight: 1.6,
              color: 'var(--ink)',
              maxHeight: MAX_HEIGHT,
              overflowY: 'auto',
            }}
          />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 }}>
            <span style={{ fontSize: 11.5, color: 'var(--ink-faint)' }}>
              {running ? 'Enter queues a follow-up - Shift+Enter for a new line' : 'Enter to send - Shift+Enter for a new line'}
            </span>
            {running ? (
              <button
                className="btn btn-secondary"
                style={{ padding: '6px 14px', fontSize: 13 }}
                onClick={onInterrupt}
                title="Interrupt the running turn"
              >
                <StopIcon size={12} /> Stop
              </button>
            ) : (
              <button
                className="btn btn-primary"
                style={{ padding: '6px 16px', fontSize: 13 }}
                disabled={draft.trim().length === 0}
                onClick={submit}
              >
                <SendIcon size={13} /> Send
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
