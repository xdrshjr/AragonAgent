/** `assistant` entries: the thinking marker/block, markdown body, and the streaming caret. */

import { Brain, Check, ChevronRight, Copy } from 'lucide-react';
import { memo } from 'react';
import type { Entry } from '@aragon-agent/tui/model/agent/reducer';
import { useT } from '../i18n/index.js';
import { formatSeconds } from '../lib/chat-format.js';
import { sessionStore } from '../store/session-store.js';
import { IconButton } from '../ui/primitives.js';
import { useCopy } from './hooks.js';
import { Markdown } from './Markdown.js';

type AssistantEntry = Extract<Entry, { kind: 'assistant' }>;

function ThinkingBlock(props: { sessionId: string; entry: AssistantEntry; visible: boolean }) {
  const t = useT();
  const { entry, visible } = props;
  if (!entry.thinking && entry.thinkingMs === undefined && entry.thinkingStartedAt === undefined) return null;
  const sealed = entry.thinkingMs !== undefined;
  const label = sealed
    ? t('chat.thinking.done', { time: formatSeconds(entry.thinkingMs ?? 0) })
    : t('chat.thinking.live');
  return (
    <div className="thinking" data-open={visible ? 'true' : undefined}>
      <button type="button" className="thinking-toggle" aria-expanded={visible}
        onClick={() => sessionStore.dispatchLocal(props.sessionId, { type: 'toggleThinking' })}>
        <ChevronRight size={14} strokeWidth={1.5} className="chev" aria-hidden="true" />
        <Brain size={14} strokeWidth={1.5} aria-hidden="true" />
        <span>{label}</span>
      </button>
      {visible && entry.thinking ? <div className="thinking-body selectable">{entry.thinking}</div> : null}
    </div>
  );
}

export const AssistantMessage = memo(function AssistantMessage(props: {
  sessionId: string; entry: AssistantEntry; thinkingVisible: boolean; running: boolean;
}) {
  const t = useT();
  const { entry } = props;
  const { copied, copy } = useCopy();
  // The caret is the "still writing" cue: only while the run is live AND this is the open message.
  const showCaret = entry.streaming && props.running;
  return (
    <div className="msg msg-assistant">
      <ThinkingBlock sessionId={props.sessionId} entry={entry} visible={props.thinkingVisible} />
      {entry.text ? (
        // aria-busy keeps screen readers quiet until the message completes (no per-token chatter).
        <div className="assistant-body" aria-busy={entry.streaming}>
          <Markdown text={entry.text} sessionId={props.sessionId} />
          {showCaret ? <span className="caret" aria-hidden="true" /> : null}
        </div>
      ) : null}
      {entry.aborted ? <div className="msg-note">{t('chat.assistant.stopped')}</div> : null}
      {!entry.streaming && entry.text ? (
        <div className="msg-actions">
          <IconButton size="sm" label={copied ? t('common.copied') : t('chat.message.copy')} onClick={() => copy(entry.text)}>
            {copied ? <Check size={14} strokeWidth={1.5} /> : <Copy size={14} strokeWidth={1.5} />}
          </IconButton>
        </div>
      ) : null}
    </div>
  );
});
