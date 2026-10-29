/**
 * The `{{variable}}` step of the prompt picker: one field per variable, a live preview of the
 * text that will be inserted, and Enter (outside an IME composition) to insert it.
 */

import { useMemo, useState } from 'react';
import { useT } from '../i18n/index.js';
import { blockEnterWhileComposing } from '../lib/settings-ime.js';
import { Button, Input } from '../ui/primitives.js';
import { extractVariables, fillVariables } from './prompt-vars.js';

export function PromptFillForm(props: { title: string; content: string; onSubmit(text: string): void; onBack(): void }) {
  const t = useT();
  const names = useMemo(() => extractVariables(props.content), [props.content]);
  const [values, setValues] = useState<Record<string, string>>({});
  const text = useMemo(() => fillVariables(props.content, values), [props.content, values]);

  return (
    <form className="pp-fill" onSubmit={(event) => { event.preventDefault(); props.onSubmit(text); }}>
      <h3 className="pp-fill-title selectable">{props.title}</h3>
      <p className="hint">{t('workspace.prompts.fillHint')}</p>
      {names.map((name, index) => (
        <div key={name} className="pe-field">
          <label className="label" htmlFor={`pp-var-${index}`}>{name}</label>
          <Input id={`pp-var-${index}`} value={values[name] ?? ''} autoFocus={index === 0} autoComplete="off"
            onChange={(event) => setValues((held) => ({ ...held, [name]: event.target.value }))}
            onKeyDown={blockEnterWhileComposing} />
        </div>
      ))}
      <details className="pp-preview">
        <summary>{t('workspace.prompts.preview')}</summary>
        <pre className="selectable">{text}</pre>
      </details>
      <div className="dialog-actions">
        <Button variant="ghost" onClick={props.onBack}>{t('common.back')}</Button>
        <Button variant="primary" type="submit">{t('workspace.prompts.insert')}</Button>
      </div>
    </form>
  );
}
