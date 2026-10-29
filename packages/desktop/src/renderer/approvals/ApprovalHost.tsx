/**
 * Which pending request is in front, and how each kind is presented.
 *
 * One request is foreground at a time and the rest queue in arrival order, so a user never
 * answers the wrong request by clicking a button that moved. Tool approvals are INLINE (at the
 * tail of the transcript) with a sticky bar when scrolled out of view; the three other kinds
 * are modal dialogs.
 */

import { ShieldAlert } from 'lucide-react';
import { useT } from '../i18n/index.js';
import { useSession, type PendingRequest } from '../store/session-store.js';
import { Button } from '../ui/primitives.js';
import { ApprovalCard } from './ApprovalCard.js';
import { AskUserWizard } from './AskUserWizard.js';
import { PlanReview } from './PlanReview.js';
import { isRequestOf } from './request-types.js';
import { SkillInstallDialog } from './SkillInstallDialog.js';
import './approvals.css';

export interface Foreground {
  request: PendingRequest;
  /** Requests queued behind the foreground one. */
  waiting: number;
}

/** The oldest unanswered request, or `null`. The selector returns an existing reference. */
export function useForeground(sessionId: string): Foreground | null {
  const requests = useSession(sessionId, (mirror) => mirror?.requests);
  const first = requests?.[0];
  return first && requests ? { request: first, waiting: requests.length - 1 } : null;
}

/** The inline tool-approval card (rendered inside the transcript). */
export function ApprovalInline(props: {
  sessionId: string; foreground: Foreground | null; cwd: string | null; onVisibilityChange(visible: boolean): void;
}) {
  const { foreground } = props;
  if (!foreground || !isRequestOf(foreground.request, 'tool-approval')) return null;
  return (
    <ApprovalCard key={foreground.request.id} sessionId={props.sessionId} request={foreground.request}
      waiting={foreground.waiting} cwd={props.cwd} onVisibilityChange={props.onVisibilityChange} />
  );
}

/** The sticky reminder above the composer, shown only while the inline card is off-screen. */
export function ApprovalBar(props: { foreground: Foreground; onReview(): void }) {
  const t = useT();
  const { request } = props.foreground;
  const tool = request.req.k === 'tool-approval' ? request.req.tool : '';
  return (
    <div className="approval-bar" role="status">
      <ShieldAlert size={14} strokeWidth={1.5} aria-hidden="true" />
      <span>{t('chat.approval.bar', { tool })}</span>
      <Button size="sm" variant="primary" onClick={props.onReview}>{t('chat.approval.review')}</Button>
    </div>
  );
}

/** The modal kinds: skill install, ask-user, plan review. */
export function HumanRequestDialog({ sessionId, foreground }: { sessionId: string; foreground: Foreground | null }) {
  if (!foreground) return null;
  const { request } = foreground;
  if (isRequestOf(request, 'ask-user')) return <AskUserWizard key={request.id} sessionId={sessionId} request={request} />;
  if (isRequestOf(request, 'plan-review')) return <PlanReview key={request.id} sessionId={sessionId} request={request} />;
  if (isRequestOf(request, 'skill-install')) return <SkillInstallDialog key={request.id} sessionId={sessionId} request={request} />;
  return null;
}
