/** The one-line plan summary above the composer: "3/7 - working on: <step>". */

import { ListChecks } from 'lucide-react';
import { useT } from '../i18n/index.js';
import { useSession } from '../store/session-store.js';
import { useUi } from '../store/ui-store.js';

export function MiniPlan({ sessionId }: { sessionId: string }) {
  const t = useT();
  const done = useSession(sessionId, (mirror) => mirror?.view?.todos?.doneCount);
  const total = useSession(sessionId, (mirror) => mirror?.view?.todos?.total);
  const active = useSession(sessionId, (mirror) => {
    const todos = mirror?.view?.todos;
    return todos && todos.activeIndex >= 0 ? todos.items[todos.activeIndex]?.activeForm : undefined;
  });
  if (!total) return null;
  return (
    <button type="button" className="mini-plan" onClick={() => useUi.getState().setInspectorTab('plan')}>
      <ListChecks size={14} strokeWidth={1.5} aria-hidden="true" />
      <span className="mini-count">{done ?? 0}/{total}</span>
      <span className="mini-text">{active ? t('chat.plan.working', { step: active }) : t('chat.plan.allDone')}</span>
    </button>
  );
}
