/** `todo` entries (the plan card) and `fast` entries (the fast-tier review line). */

import { Check, Circle, CircleDot, X } from 'lucide-react';
import { memo } from 'react';
import type { Entry } from '@aragon-agent/tui/model/agent/reducer';
import { useT } from '../i18n/index.js';
import { useUi } from '../store/ui-store.js';

type TodoEntry = Extract<Entry, { kind: 'todo' }>;
type FastEntry = Extract<Entry, { kind: 'fast' }>;

const MAX_ITEMS = 12;

const STEP_ICON = { pending: Circle, in_progress: CircleDot, completed: Check } as const;
const CRITERION_ICON = { pending: Circle, in_progress: CircleDot, passed: Check, failed: X } as const;

export const TodoCard = memo(function TodoCard({ entry }: { entry: TodoEntry }) {
  const t = useT();
  const percent = entry.total === 0 ? 0 : Math.round((entry.doneCount / entry.total) * 100);
  const hidden = Math.max(0, entry.items.length - MAX_ITEMS);
  const acceptance = entry.acceptance;
  return (
    <div className="todo-card" data-live={entry.live ? 'true' : undefined}>
      <button type="button" className="todo-head" onClick={() => useUi.getState().setInspectorTab('plan')}>
        <strong>{t('chat.todo.title')}</strong>
        <span>{t('chat.todo.progress', { done: entry.doneCount, total: entry.total })}</span>
        {entry.interrupted ? <span className="todo-flag">{t('chat.todo.interrupted')}</span> : null}
      </button>
      <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}
        aria-label={t('chat.todo.title')}>
        <div className="progress-fill" style={{ width: `${percent}%` }} />
      </div>
      <ul className="todo-items">
        {entry.items.slice(0, MAX_ITEMS).map((item, index) => {
          const Icon = STEP_ICON[item.status];
          return (
            <li key={index} data-status={item.status}>
              <Icon size={14} strokeWidth={1.5} aria-hidden="true" />
              <span className="sr-only">{t(`chat.todo.status.${item.status}` as const)}: </span>
              <span>{item.status === 'in_progress' ? item.activeForm : item.content}</span>
            </li>
          );
        })}
        {hidden > 0 ? <li className="todo-more">{t('chat.todo.more', { n: hidden })}</li> : null}
      </ul>
      {acceptance && acceptance.total > 0 ? (
        <>
          <div className="todo-sub">
            {t('chat.todo.acceptance', { passed: acceptance.passedCount, failed: acceptance.failedCount, total: acceptance.total })}
          </div>
          <ul className="todo-items">
            {acceptance.items.slice(0, MAX_ITEMS).map((item, index) => {
              const Icon = CRITERION_ICON[item.status];
              return (
                <li key={index} data-status={item.status}>
                  <Icon size={14} strokeWidth={1.5} aria-hidden="true" />
                  <span className="sr-only">{t(`chat.todo.criterion.${item.status}` as const)}: </span>
                  <span>{item.content}</span>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
    </div>
  );
});

export const FastRow = memo(function FastRow({ entry }: { entry: FastEntry }) {
  const t = useT();
  const body = entry.status === 'advice' ? entry.text : entry.status === 'failed' || entry.status === 'dropped' ? entry.detail : null;
  return (
    <div className="fast" data-status={entry.status}>
      <span className="fast-label">{t('chat.fast.label', { n: entry.reviewIndex })}</span>
      <span className="fast-status">{t(`chat.fast.status.${entry.status}` as const)}</span>
      {body ? <span className="fast-text selectable">{body}</span> : null}
    </div>
  );
});
