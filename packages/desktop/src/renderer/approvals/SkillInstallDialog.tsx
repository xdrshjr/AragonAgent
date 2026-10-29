/** Approval to install a skill: where it comes from, where it will be written, what it contains. */

import { useT } from '../i18n/index.js';
import { sessionStore } from '../store/session-store.js';
import { Button } from '../ui/primitives.js';
import { Dialog } from '../ui/overlay.js';
import { useArmed } from './ApprovalCard.js';
import type { RequestOf } from './request-types.js';
import { useEscape } from './use-escape.js';
import './approvals.css';

type SkillRequest = RequestOf<'skill-install'>;

export function SkillInstallDialog({ sessionId, request }: { sessionId: string; request: SkillRequest }) {
  const t = useT();
  const { source, targetPath, summary } = request.req;
  const armed = useArmed();
  const answer = (approved: boolean): void => {
    sessionStore.answer(sessionId, request.id, { k: 'skill-install', approved });
  };
  useEscape(() => answer(false));

  return (
    <Dialog open onOpenChange={(open) => { if (!open) answer(false); }} dismissible={false}
      title={t('chat.skill.title')} description={t('chat.skill.description')}
      actions={(
        <>
          <Button variant="danger" onClick={() => answer(false)}>{t('chat.skill.deny')}</Button>
          <Button variant="primary" aria-disabled={!armed} onClick={() => { if (armed) answer(true); }}>
            {t('chat.skill.approve')}
          </Button>
        </>
      )}>
      <dl className="skill-facts">
        <dt>{t('chat.skill.source')}</dt>
        <dd className="selectable"><code>{source}</code></dd>
        <dt>{t('chat.skill.target')}</dt>
        <dd className="selectable"><code>{targetPath}</code></dd>
      </dl>
      <pre className="approval-summary selectable" tabIndex={0} aria-label={t('chat.skill.summary')}>{summary}</pre>
    </Dialog>
  );
}
