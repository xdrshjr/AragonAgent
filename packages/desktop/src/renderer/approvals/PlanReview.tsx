/**
 * Plan review (`submit_plan`): the plan rendered for a decision. Approve, Revise (with
 * feedback <= 2000 characters), or Dismiss. Closing the dialog is Dismiss, never Approve, and
 * Approve is the LAST button in tab order so the initial focus lands on the safe one.
 */

import { useState } from 'react';
import { useT } from '../i18n/index.js';
import { sessionStore } from '../store/session-store.js';
import { ANSWER_LIMITS } from '../../shared/port-protocol.js';
import { Button, Textarea } from '../ui/primitives.js';
import { Dialog } from '../ui/overlay.js';
import { useArmed } from './ApprovalCard.js';
import type { RequestOf } from './request-types.js';
import { useEscape } from './use-escape.js';
import './approvals.css';

type PlanRequest = RequestOf<'plan-review'>;

function Section(props: { title: string; items: string[] }) {
  if (props.items.length === 0) return null;
  return (
    <section className="plan-section">
      <h3>{props.title}</h3>
      <ul>{props.items.map((item, index) => <li key={index} className="selectable">{item}</li>)}</ul>
    </section>
  );
}

export function PlanReview({ sessionId, request }: { sessionId: string; request: PlanRequest }) {
  const t = useT();
  const { plan } = request.req;
  const armed = useArmed();
  const [revising, setRevising] = useState(false);
  const [feedback, setFeedback] = useState('');

  const decide = (decision: 'approved' | 'revise' | 'dismissed'): void => {
    const text = decision === 'revise' ? feedback.trim().slice(0, ANSWER_LIMITS.planFeedback) : '';
    sessionStore.answer(sessionId, request.id, { k: 'plan-review', decision, feedback: text });
  };
  useEscape(() => decide('dismissed'));

  return (
    <Dialog open onOpenChange={(open) => { if (!open) decide('dismissed'); }} dismissible={false} size="lg"
      title={plan.title || t('chat.plan.reviewTitle')} description={plan.summary}
      actions={revising ? (
        <>
          <Button variant="ghost" onClick={() => setRevising(false)}>{t('common.back')}</Button>
          <Button variant="primary" disabled={feedback.trim() === ''} onClick={() => decide('revise')}>
            {t('chat.plan.sendFeedback')}
          </Button>
        </>
      ) : (
        <>
          <Button variant="ghost" onClick={() => decide('dismissed')}>{t('chat.plan.dismiss')}</Button>
          <Button onClick={() => setRevising(true)}>{t('chat.plan.revise')}</Button>
          <Button variant="primary" aria-disabled={!armed} onClick={() => { if (armed) decide('approved'); }}>
            {t('chat.plan.approve')}
          </Button>
        </>
      )}>
      <div className="plan-body">
        <ol className="plan-steps">
          {plan.steps.map((step, index) => (
            <li key={index}>
              <strong className="selectable">{step.title}</strong>
              {step.detail ? <p className="selectable">{step.detail}</p> : null}
            </li>
          ))}
        </ol>
        <Section title={t('chat.plan.files')} items={plan.filesTouched} />
        <Section title={t('chat.plan.risks')} items={plan.risks} />
        <Section title={t('chat.plan.questions')} items={plan.openQuestions} />
        {revising ? (
          <label className="ask-explain">
            <span>{t('chat.plan.feedbackLabel')}</span>
            <Textarea rows={4} maxLength={ANSWER_LIMITS.planFeedback} value={feedback} autoFocus
              onChange={(event) => setFeedback(event.target.value)} />
          </label>
        ) : null}
      </div>
    </Dialog>
  );
}
