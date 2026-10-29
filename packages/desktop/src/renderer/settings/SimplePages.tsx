/**
 * The settings pages that are just one or more schema-driven forms. Everything they show comes
 * from `lib/settings-sections.ts`; the only page-specific code is the framing around the forms.
 */

import { useT } from '../i18n/index.js';
import { SECTIONS } from '../lib/settings-sections.js';
import { useConfig } from '../store/config-store.js';
import { useUi } from '../store/ui-store.js';
import { Button } from '../ui/primitives.js';
import { DesktopPrefs } from './DesktopPrefs.js';
import { ForcedFanout } from './ForcedFanout.js';
import { SectionForm } from './SectionForm.js';

export function GeneralPage() {
  return (
    <div className="set-page">
      <SectionForm section={SECTIONS.general} />
      <DesktopPrefs />
    </div>
  );
}

export function AgentPage() {
  return (
    <div className="set-page">
      <SectionForm section={SECTIONS.agent} />
      <SectionForm section={SECTIONS.bash} />
      <SectionForm section={SECTIONS.jobs} />
    </div>
  );
}

export function TeamPage() {
  return (
    <div className="set-page">
      <SectionForm section={SECTIONS.team} />
      <ForcedFanout />
    </div>
  );
}

export function TodoPage() {
  return <div className="set-page"><SectionForm section={SECTIONS.todo} /></div>;
}

export function ContextPage() {
  return <div className="set-page"><SectionForm section={SECTIONS.compaction} /></div>;
}

export function RetryPage() {
  return <div className="set-page"><SectionForm section={SECTIONS.retry} /></div>;
}

export function FastPage() {
  const t = useT();
  const profiles = useConfig((state) => state.result?.view?.modelProfiles ?? null);
  const openSettings = useUi((state) => state.openSettings);
  const fast = profiles?.fastId ? profiles.entries.find((entry) => entry.id === profiles.fastId) : undefined;
  return (
    <div className="set-page">
      {fast ? (
        <section className="set-card" aria-label={t('settings.fast.sourceTitle')}>
          <p className="set-desc selectable">{t('settings.fast.fromProfile', { name: fast.name, model: `${fast.provider}:${fast.model}` })}</p>
          <div className="set-card-foot">
            <Button size="sm" onClick={() => openSettings('models')}>{t('settings.fast.openModels')}</Button>
          </div>
        </section>
      ) : null}
      <SectionForm section={SECTIONS.fast} />
      <SectionForm section={SECTIONS.taskSummary} />
    </div>
  );
}

export function GovernancePage() {
  const t = useT();
  const setInspectorTab = useUi((state) => state.setInspectorTab);
  const closeSettings = useUi((state) => state.closeSettings);
  const showInspector = (): void => { closeSettings(); setInspectorTab('governance'); };
  return (
    <div className="set-page">
      <SectionForm section={SECTIONS.governance} />
      <section className="set-card" aria-label={t('settings.gov.runsTitle')}>
        <p className="set-desc">{t('settings.gov.runsBody')}</p>
        <div className="set-card-foot">
          <Button size="sm" onClick={showInspector}>{t('settings.gov.openInspector')}</Button>
        </div>
      </section>
    </div>
  );
}
