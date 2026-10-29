/**
 * One labelled setting. Presentational: the form owns the state, this renders the control and
 * every line of feedback under it (allowed range, "0 means ...", "will be saved as ...", a
 * parse error). Feedback is text, never colour alone.
 */

import { useId } from 'react';
import { useT, type Translate } from '../i18n/index.js';
import { fieldBounds, type FieldError, type FieldSpec, type SectionSpec } from '../lib/settings-fields.js';
import type { ConfigViewDto } from '../../shared/config-view.js';
import { formatDuration } from '../lib/time.js';
import { Input, Select, Switch } from '../ui/primitives.js';

export interface FieldRowProps {
  section: SectionSpec;
  field: FieldSpec;
  view: ConfigViewDto | null;
  /** What the control currently holds: the typed text/boolean, or the stored value. */
  current: boolean | string;
  /** The engine's merged values, used to probe dependent ranges. */
  merged: Record<string, unknown>;
  error: FieldError | undefined;
  /** The value the file will hold, when it differs from what was typed. */
  savedAs: unknown;
  disabled?: boolean;
  onChange(raw: boolean | string): void;
}

function rangeText(t: Translate, min: number | undefined, max: number | undefined): string | null {
  if (min !== undefined && max !== undefined) return t('settings.range.between', { min, max });
  if (min !== undefined) return t('settings.range.atLeast', { min });
  if (max !== undefined) return t('settings.range.atMost', { max });
  return null;
}

function ProfileSelect(props: {
  id: string; view: ConfigViewDto | null; value: string; describedBy: string; disabled?: boolean;
  onChange(value: string): void;
}) {
  const t = useT();
  const entries = props.view?.modelProfiles?.entries ?? [];
  return (
    <Select id={props.id} value={props.value} disabled={props.disabled} aria-describedby={props.describedBy}
      onChange={(event) => props.onChange(event.target.value)}>
      <option value="">{t('settings.profile.none')}</option>
      {entries.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
    </Select>
  );
}

function Control(props: FieldRowProps & { id: string; describedBy: string }) {
  const t = useT();
  const { field, current, id } = props;
  if (field.kind === 'bool') {
    return <Switch id={id} label={t(field.labelKey)} checked={current === true} disabled={props.disabled} onCheckedChange={props.onChange} />;
  }
  if (field.kind === 'enum') {
    const known = field.options.some((option) => option.value === current);
    return (
      <Select id={id} value={String(current)} disabled={props.disabled} aria-describedby={props.describedBy}
        onChange={(event) => props.onChange(event.target.value)}>
        {known ? null : <option value={String(current)}>{String(current)}</option>}
        {field.options.map((option) => <option key={option.value} value={option.value}>{t(option.labelKey)}</option>)}
      </Select>
    );
  }
  if (field.kind === 'profile') {
    return <ProfileSelect id={id} view={props.view} value={String(current)} describedBy={props.describedBy}
      disabled={props.disabled} onChange={props.onChange} />;
  }
  const mode = field.kind === 'text' ? 'text' : field.kind === 'number' ? 'decimal' : 'numeric';
  return (
    <Input id={id} value={String(current)} disabled={props.disabled} aria-describedby={props.describedBy}
      aria-invalid={props.error ? true : undefined} inputMode={mode} autoComplete="off" spellCheck={false}
      onChange={(event) => props.onChange(event.target.value)} />
  );
}

export function FieldRow(props: FieldRowProps) {
  const t = useT();
  const id = `f-${useId()}`;
  const describedBy = `${id}-hint`;
  const { field } = props;
  const numeric = field.kind === 'int' || field.kind === 'number' || field.kind === 'autoInt';
  const bounds = numeric ? fieldBounds(props.section, field, props.merged) : { min: undefined, max: undefined };
  const range = numeric ? rangeText(t, bounds.min, bounds.max) : null;
  const unit = field.kind === 'int' || field.kind === 'number' ? field.unit : undefined;
  const zeroKey = field.kind === 'int' ? field.zeroKey : undefined;
  const typedMs = unit === 'ms' && !props.error ? Number(props.current) : Number.NaN;
  const hasAdjusted = props.savedAs !== undefined && !props.error;

  return (
    <div className="set-row" data-kind={field.kind}>
      <div className="set-row-label">
        <label htmlFor={id}>{t(field.labelKey)}</label>
        <div id={describedBy} className="set-hint">
          {field.hintKey ? <span>{t(field.hintKey)} </span> : null}
          {range ? <span>{range} </span> : null}
          {zeroKey ? <span>{t('settings.zero.means', { meaning: t(zeroKey) })} </span> : null}
          {Number.isFinite(typedMs) && typedMs >= 1000 ? <span>{`≈ ${formatDuration(typedMs)}`}</span> : null}
        </div>
        {props.error ? <div className="set-error" role="alert">{t(`settings.error.${props.error}` as const)}</div> : null}
        {hasAdjusted ? (
          <div className="set-adjusted" role="status">
            {t('settings.adjusted', { value: props.savedAs === null ? t('settings.value.auto') : String(props.savedAs) })}
          </div>
        ) : null}
      </div>
      <div className="set-row-control">
        <Control {...props} id={id} describedBy={describedBy} />
        {unit ? <span className="set-unit">{unit}</span> : null}
      </div>
    </div>
  );
}
