/**
 * Inspector > Plan: the live todo list and, when the session uses it, the acceptance criteria
 * with their verdicts. Status is a word and a glyph, never colour alone. The list only exists
 * while the agent keeps one; without it the panel says so instead of rendering an empty box.
 */

import { Check, CircleDashed, LoaderCircle, X, type LucideIcon } from 'lucide-react';
import { useT } from '../i18n/index.js';
import { useSession } from '../store/session-store.js';
import { Button } from '../ui/primitives.js';
import { PanelBlock, PanelEmpty, PanelError, usePanelCommand } from './PanelBits.js';

const TODO_ICON = { pending: CircleDashed, in_progress: LoaderCircle, completed: Check } as const;
const ACCEPT_ICON = { pending: CircleDashed, in_progress: LoaderCircle, passed: Check, failed: X } as const;

function StatusGlyph(props: { Icon: LucideIcon; status: string }) {
  return <props.Icon size={14} aria-hidden="true" className="plan-glyph" data-status={props.status} />;
}

export function PlanPanel({ sessionId }: { sessionId: string }) {
  const t = useT();
  const todos = useSession(sessionId, (mirror) => mirror?.view?.todos ?? null);
  const command = usePanelCommand(sessionId);
  if (!todos) return <PanelEmpty title={t('workspace.plan.emptyTitle')} body={t('workspace.plan.emptyBody')} />;
  const acceptance = todos.acceptance;

  return (
    <div className="panel">
      <PanelBlock title={t('workspace.plan.todos')} aside={t('workspace.plan.progress', { done: todos.doneCount, total: todos.total })}>
        <ol className="plan-list">
          {todos.items.map((item, index) => (
            <li key={`${index}-${item.content}`} className="plan-item" data-status={item.status}>
              <StatusGlyph Icon={TODO_ICON[item.status]} status={item.status} />
              <span className="plan-text selectable">{item.status === 'in_progress' ? item.activeForm : item.content}</span>
              <span className="plan-state">{t(`workspace.plan.status.${item.status}` as const)}</span>
            </li>
          ))}
        </ol>
      </PanelBlock>

      {acceptance ? (
        <PanelBlock title={t('workspace.plan.acceptance')}
          aside={t('workspace.plan.acceptanceProgress', { passed: acceptance.passedCount, failed: acceptance.failedCount, total: acceptance.total })}>
          <ul className="plan-list">
            {acceptance.items.map((item, index) => (
              <li key={`${index}-${item.content}`} className="plan-item plan-accept" data-status={item.status}>
                <StatusGlyph Icon={ACCEPT_ICON[item.status]} status={item.status} />
                <div className="plan-text selectable">
                  <div>{item.content}</div>
                  <div className="plan-check">{item.check}</div>
                  {item.evidence ? (
                    <details><summary>{t('workspace.plan.evidence')}</summary><p className="plan-evidence">{item.evidence}</p></details>
                  ) : null}
                </div>
                <span className="plan-state">{t(`workspace.plan.accept.${item.status}` as const)}</span>
              </li>
            ))}
          </ul>
          <div className="panel-actions">
            <Button size="sm" disabled={command.busy} onClick={() => void command.run({ c: 'todo.reopen-acceptance' })}>
              {t('workspace.plan.reopen')}
            </Button>
          </div>
        </PanelBlock>
      ) : null}
      <PanelError message={command.error} />
    </div>
  );
}
