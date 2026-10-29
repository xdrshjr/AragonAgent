/**
 * The whole conversation pane for one hydrated session: session bar, transcript (with an
 * inline approval card at its tail), the sticky approval reminder, the one-line plan, toasts,
 * and the composer. It fills its flex parent as a column.
 */

import { useCallback, useRef, useState } from 'react';
import {
  ApprovalBar, ApprovalInline, HumanRequestDialog, useForeground,
} from '../approvals/ApprovalHost.js';
import { Composer } from '../composer/Composer.js';
import { useSession } from '../store/session-store.js';
import { useUi } from '../store/ui-store.js';
import { ExportDialog } from './ExportDialog.js';
import { FindBar } from './FindBar.js';
import { MiniPlan } from './MiniPlan.js';
import { SessionBar } from './SessionBar.js';
import { ToastStack } from './ToastStack.js';
import { Transcript, type TranscriptHandle } from './Transcript.js';
import './chat.css';

export function SessionView({ sessionId }: { sessionId: string }) {
  const transcript = useRef<TranscriptHandle | null>(null);
  const foreground = useForeground(sessionId);
  const cwd = useSession(sessionId, (mirror) => mirror?.meta?.cwd) ?? null;
  const [cardVisible, setCardVisible] = useState(true);
  const resumeFollow = useCallback((): void => transcript.current?.resumeFollow(), []);
  const findOpen = useUi((state) => state.findSessionId === sessionId);
  const toolApproval = foreground?.request.req.k === 'tool-approval';

  return (
    <div className="session-view">
      <SessionBar sessionId={sessionId} />
      {findOpen ? <FindBar sessionId={sessionId} transcript={transcript} /> : null}
      <Transcript ref={transcript} sessionId={sessionId}
        tail={<ApprovalInline sessionId={sessionId} foreground={foreground} cwd={cwd} onVisibilityChange={setCardVisible} />} />
      <ToastStack sessionId={sessionId} />
      {foreground && toolApproval && !cardVisible ? <ApprovalBar foreground={foreground} onReview={resumeFollow} /> : null}
      <MiniPlan sessionId={sessionId} />
      <Composer sessionId={sessionId} onSent={resumeFollow} />
      <HumanRequestDialog sessionId={sessionId} foreground={foreground} />
      <ExportDialog sessionId={sessionId} />
    </div>
  );
}
