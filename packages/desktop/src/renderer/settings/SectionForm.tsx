/**
 * A card of settings that are saved together: fields from a `SectionSpec`, a "Modified"
 * marker, and Save / Revert. Saving a dangerous switch OFF asks first.
 */

import { useMemo, useState } from 'react';
import { useT } from '../i18n/index.js';
import { displayValue, type FieldSpec, type SectionSpec } from '../lib/settings-fields.js';
import { Dialog } from '../ui/overlay.js';
import { Badge, Button } from '../ui/primitives.js';
import { FieldRow } from './FieldRow.js';
import { useSectionForm, type SaveState } from './use-section-form.js';

function SaveStatus({ state, pendingAdjust }: { state: SaveState; pendingAdjust: boolean }) {
  const t = useT();
  return (
    <span className="set-status" role="status">
      {state.kind === 'saved' ? t('settings.saved') : null}
      {state.kind === 'saved' && state.adjusted.length > 0 ? ` ${t('settings.savedAdjusted')}` : null}
      {state.kind === 'failed' ? t('settings.error.save', { code: state.code }) : null}
      {pendingAdjust && state.kind === 'idle' ? t('settings.willAdjust') : null}
    </span>
  );
}

export function SectionForm(props: { section: SectionSpec; disabled?: boolean }) {
  const t = useT();
  const { section } = props;
  const form = useSectionForm(section);
  const [confirming, setConfirming] = useState(false);
  const fields = useMemo<FieldSpec[]>(
    () => section.fields.filter((field) => (field.showIf ? field.showIf(form.view) : true)),
    [section, form.view],
  );
  const merged = useMemo(() => ({ ...form.base, ...form.resolution.effective }), [form.base, form.resolution.effective]);
  const adjustedByKey = new Map(form.resolution.adjusted.map((item) => [item.key, item.saved]));
  const pendingAdjust = form.resolution.adjusted.length > 0;
  const disabled = props.disabled || form.view === null;

  const requestSave = (): void => {
    if (form.dangers.length > 0) setConfirming(true);
    else void form.save();
  };

  return (
    <section className="set-card" aria-labelledby={`sec-${section.id}`} data-modified={form.resolution.modified}>
      <header className="set-card-head">
        <h3 id={`sec-${section.id}`}>{t(section.titleKey)}</h3>
        {form.resolution.modified ? <Badge tone="warning">{t('settings.modified')}</Badge> : null}
      </header>
      {section.descKey ? <p className="set-desc">{t(section.descKey)}</p> : null}
      <div className="set-rows">
        {fields.map((field) => {
          const edited = form.edits[field.key];
          const current = edited ?? (field.kind === 'bool'
            ? form.base[field.key] === true : displayValue(field, form.base[field.key]));
          return (
            <FieldRow key={field.key} section={section} field={field} view={form.view} current={current}
              merged={merged} error={form.resolution.errors[field.key]} disabled={disabled}
              savedAs={adjustedByKey.get(field.key)}
              onChange={(raw) => form.setField(field.key, raw)} />
          );
        })}
      </div>
      <footer className="set-card-foot">
        <SaveStatus state={form.saveState} pendingAdjust={pendingAdjust} />
        <Button variant="ghost" size="sm" onClick={form.revert} disabled={!form.resolution.modified}>{t('settings.revert')}</Button>
        <Button variant="primary" size="sm" onClick={requestSave} disabled={!form.canSave || disabled}>
          {form.saveState.kind === 'saving' ? t('common.loading') : t('common.save')}
        </Button>
      </footer>
      <Dialog open={confirming} onOpenChange={setConfirming} title={t('settings.danger.title')}
        description={t('settings.danger.body')}
        actions={<>
          <Button variant="primary" autoFocus onClick={() => setConfirming(false)}>{t('common.cancel')}</Button>
          <Button variant="danger" onClick={() => { setConfirming(false); void form.save(); }}>{t('settings.danger.confirm')}</Button>
        </>}>
        <ul className="set-danger-list">
          {form.dangers.map((field) => <li key={field.key}>{t(field.labelKey)}</li>)}
        </ul>
      </Dialog>
    </section>
  );
}
