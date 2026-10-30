/**
 * The tool-approval card (spec 3.7). Safety properties, each deliberate:
 *   - it shows the COMPLETE summary (scrollable, never clipped to hide a difference);
 *   - dangerous patterns are highlighted, never auto-denied;
 *   - the buttons ignore presses for 400 ms after the card appears (Enter/Space inertia), and
 *     keyboard focus starts on Deny. The buttons use `aria-disabled`, not `disabled`, because a
 *     disabled button cannot receive the initial focus;
 *   - Esc, or any other way of dismissing it, is a DENY.
 */

import { AlertTriangle, ShieldAlert } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { getLanguage, useT } from '../i18n/index.js';
import { voiceTitle } from '../lib/tool-voice-i18n.js';
import { useUi } from '../store/ui-store.js';
import { dangerKinds, detectDanger, segmentSummary, type DangerMatch } from '../lib/chat-danger.js';
import { sessionStore } from '../store/session-store.js';
import { ANSWER_LIMITS } from '../../shared/port-protocol.js';
import type { RequestOf } from './request-types.js';
import { Badge, Button, Input } from '../ui/primitives.js';
import './approvals.css';

/** Presses are ignored for this long after the card first appears. */
export const APPROVAL_GUARD_MS = 400;

export type ToolApprovalRequest = RequestOf<'tool-approval'>;

/**
 * False for the first 400 ms after the component MOUNTS - not after the request arrived. A
 * request queued behind another one becomes visible only when the one in front is answered, and
 * the click that answered it must not be able to land on the card that replaced it.
 */
export function useArmed(): boolean {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setArmed(true), APPROVAL_GUARD_MS);
    return () => clearTimeout(timer);
  }, []);
  return armed;
}

/** Reports whether the card is on screen, so the sticky reminder shows only when it is not. */
function useVisibility(
  rootRef: RefObject<HTMLElement | null>, requestId: string, onChange: ((visible: boolean) => void) | undefined,
): void {
  useEffect(() => {
    const element = rootRef.current;
    if (!element || !onChange || typeof IntersectionObserver === 'undefined') return undefined;
    const watcher = new IntersectionObserver((records) => {
      const last = records[records.length - 1];
      if (last) onChange(last.isIntersecting);
    }, { threshold: 0.2 });
    watcher.observe(element);
    return () => { watcher.disconnect(); onChange(true); };
  }, [rootRef, onChange, requestId]);
}

/** The full command text, with dangerous spans highlighted. Never clipped. */
function SummaryBox(props: { id: string; summary: string; matches: DangerMatch[] }) {
  const t = useT();
  const segments = useMemo(() => segmentSummary(props.summary, props.matches), [props.summary, props.matches]);
  return (
    <pre id={props.id} className="approval-summary selectable" tabIndex={0} aria-label={t('chat.approval.summary')}>
      {segments.map((segment, index) => (
        segment.danger
          ? <mark key={index} className="danger" data-kind={segment.danger}>{segment.text}</mark>
          : segment.text
      ))}
    </pre>
  );
}

export function ApprovalCard(props: {
  sessionId: string;
  request: ToolApprovalRequest;
  /** How many further requests are waiting behind this one. */
  waiting: number;
  cwd: string | null;
  onVisibilityChange?(visible: boolean): void;
}) {
  const t = useT();
  const { request, sessionId } = props;
  const { tool, summary } = request.req;
  const developer = useUi((state) => state.developerMode);
  // The badge names the action in plain words; the summary below it (the exact command, path or
  // diff header) is the safety-relevant text and is NEVER rephrased; "always allow" names the
  // exact tool it grants, so it keeps the identifier.
  const toolLabel = developer ? tool : voiceTitle(tool, 'friendly', getLanguage());
  const armed = useArmed();
  const [reason, setReason] = useState('');
  const denyRef = useRef<HTMLButtonElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const matches = useMemo(() => detectDanger(summary, props.cwd), [summary, props.cwd]);

  useEffect(() => { denyRef.current?.focus(); }, [request.id]);

  useVisibility(rootRef, request.id, props.onVisibilityChange);

  const answer = (decision: 'allow' | 'allow-session' | 'deny'): void => {
    if (!armed) return; // the inertia guard covers all three buttons; Esc (a deny) is not guarded
    const text = reason.trim().slice(0, ANSWER_LIMITS.denyReason);
    sessionStore.answer(sessionId, request.id, {
      k: 'tool-approval', decision, ...(decision === 'deny' && text ? { reason: text } : {}),
    });
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    sessionStore.answer(sessionId, request.id, { k: 'tool-approval', decision: 'deny' });
  };

  return (
    <div ref={rootRef} className="approval" role="alertdialog" aria-labelledby={`approval-title-${request.id}`}
      aria-describedby={`approval-summary-${request.id}`} onKeyDown={onKeyDown} data-armed={armed ? 'true' : 'false'}>
      <div className="approval-head">
        <ShieldAlert size={16} strokeWidth={1.5} aria-hidden="true" />
        <strong id={`approval-title-${request.id}`}>{t('chat.approval.title')}</strong>
        <Badge>{toolLabel}</Badge>
        {props.waiting > 0 ? <span className="approval-queue">{t('chat.approval.waiting', { n: props.waiting })}</span> : null}
      </div>
      {matches.length > 0 ? (
        <div className="approval-warning" role="note">
          <AlertTriangle size={14} strokeWidth={1.5} aria-hidden="true" />
          <span>{dangerKinds(matches).map((kind) => t(`chat.approval.danger.${kind}` as const)).join(' · ')}</span>
        </div>
      ) : null}
      <SummaryBox id={`approval-summary-${request.id}`} summary={summary} matches={matches} />
      <label className="approval-reason">
        <span>{t('chat.approval.reason')}</span>
        <Input value={reason} maxLength={ANSWER_LIMITS.denyReason} onChange={(event) => setReason(event.target.value)} />
      </label>
      <div className="approval-actions">
        <Button ref={denyRef} variant="danger" aria-disabled={!armed} onClick={() => answer('deny')}>
          {t('chat.approval.deny')}
        </Button>
        <Button aria-disabled={!armed} onClick={() => answer('allow-session')}>
          {t('chat.approval.allowSession', { tool })}
        </Button>
        <Button variant="primary" aria-disabled={!armed} onClick={() => answer('allow')}>
          {t('chat.approval.allow')}
        </Button>
      </div>
    </div>
  );
}
