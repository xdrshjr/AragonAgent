/**
 * Onboarding step 3: pick a folder to start in (a recent one, a new one, or "later") and, as a
 * preview of what to ask, the first three prompts of the library.
 */

import { useEffect, useState } from 'react';
import { ipc } from '../api.js';
import { useT } from '../i18n/index.js';
import { Button } from '../ui/primitives.js';
import type { OnboardingDraft } from './draft.js';

export function WorkspaceStep(props: { draft: OnboardingDraft; onChange(patch: Partial<OnboardingDraft>): void }) {
  const t = useT();
  const [recent, setRecent] = useState<string[]>([]);
  const [examples, setExamples] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    void ipc('workspace:recent').then((response) => { if (!cancelled && response.ok) setRecent(response.value.slice(0, 5)); });
    void ipc('prompts:list').then((response) => {
      if (!cancelled && response.ok) setExamples(response.value.slice(0, 3).map((prompt) => prompt.title));
    });
    return () => { cancelled = true; };
  }, []);

  const pick = async (): Promise<void> => {
    const response = await ipc('workspace:pick');
    if (response.ok && response.value.path) props.onChange({ workspace: response.value.path });
  };
  const { workspace } = props.draft;

  return (
    <div>
      <fieldset className="onb-choices">
        <legend className="sr-only">{t('workspace.onboarding.title.workspace')}</legend>
        {recent.map((path) => (
          <label key={path} className="onb-choice" data-selected={workspace === path}>
            <input type="radio" name="workspace" checked={workspace === path} onChange={() => props.onChange({ workspace: path })} />
            <span className="onb-choice-name selectable">{path}</span>
          </label>
        ))}
        {workspace && !recent.includes(workspace) ? (
          <label className="onb-choice" data-selected="true">
            <input type="radio" name="workspace" checked readOnly />
            <span className="onb-choice-name selectable">{workspace}</span>
          </label>
        ) : null}
        <label className="onb-choice" data-selected={workspace === null}>
          <input type="radio" name="workspace" checked={workspace === null} onChange={() => props.onChange({ workspace: null })} />
          <span className="onb-choice-name">{t('workspace.onboarding.later')}</span>
          <span className="onb-choice-desc">{t('workspace.onboarding.laterDesc')}</span>
        </label>
      </fieldset>
      <Button onClick={() => void pick()}>{t('workspace.onboarding.chooseFolder')}</Button>
      {examples.length > 0 ? (
        <div className="onb-examples">
          <p className="hint">{t('workspace.onboarding.examples')}</p>
          <ul>{examples.map((title) => <li key={title} className="selectable">{title}</li>)}</ul>
        </div>
      ) : null}
    </div>
  );
}
