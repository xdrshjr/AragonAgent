/** One transcript row: picks the renderer for an entry kind. Memoised on primitive props. */

import { memo } from 'react';
import type { Entry } from '@aragon-agent/tui/model/agent/reducer';
import type { ErrorAction } from '../lib/chat-errors.js';
import { AssistantMessage } from './AssistantMessage.js';
import { CompactionRow } from './CompactionRow.js';
import { NoticeRow } from './NoticeRow.js';
import { RetryRow } from './RetryRow.js';
import { ServiceRow } from './ServiceRow.js';
import { GovernanceRow, TeamRow } from './TeamRow.js';
import { FastRow, TodoCard } from './TodoCard.js';
import { ToolCard } from './tools/ToolCard.js';
import { UserMessage } from './UserMessage.js';

export interface RowProps {
  sessionId: string;
  entry: Entry;
  expanded: boolean;
  thinkingVisible: boolean;
  running: boolean;
  queueNumber: number;
  canRetry: boolean;
  onErrorAction(action: ErrorAction): void;
}

export const TranscriptItem = memo(function TranscriptItem(props: RowProps) {
  const { entry, sessionId } = props;
  switch (entry.kind) {
    case 'user':
    case 'queued':
      return <UserMessage sessionId={sessionId} entry={entry} queueNumber={props.queueNumber} />;
    case 'assistant':
      return <AssistantMessage sessionId={sessionId} entry={entry} thinkingVisible={props.thinkingVisible} running={props.running} />;
    case 'tool':
      return <ToolCard sessionId={sessionId} entry={entry} expanded={props.expanded} />;
    case 'notice':
      return <NoticeRow entry={entry} canRetry={props.canRetry} onAction={props.onErrorAction} />;
    case 'team':
      return <TeamRow entry={entry} />;
    case 'governance':
      return <GovernanceRow entry={entry} />;
    case 'todo':
      return <TodoCard entry={entry} />;
    case 'retry':
      return <RetryRow entry={entry} />;
    case 'fast':
      return <FastRow entry={entry} />;
    case 'compaction':
      return <CompactionRow entry={entry} />;
    case 'service':
      return <ServiceRow sessionId={sessionId} entry={entry} />;
  }
});
