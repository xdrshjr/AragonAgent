/**
 * Preferences only the desktop app has: language, the Enter key, and how many session hosts
 * stay alive. They live in `desktop-state.json` and are saved the moment they change - they
 * are NEVER written into `config.json` (the terminal would not understand them, and the file
 * is shared). Numbers are clamped with the same limits the main process re-applies.
 */

import { useCallback, useEffect, useState } from 'react';
import { ipc } from '../api.js';
import { resolveLanguage, setLanguage, useT } from '../i18n/index.js';
import { clampNumber, LIMITS, type DesktopState, type LanguageSetting } from '../../shared/desktop-state.js';
import { useUi } from '../store/ui-store.js';
import { Input, Select, Switch } from '../ui/primitives.js';

function NumberPref(props: {
  id: string; label: string; hint: string; value: number; range: { min: number; max: number; fallback: number };
  onCommit(value: number): void;
}) {
  const t = useT();
  const [text, setText] = useState(String(props.value));
  const [adjusted, setAdjusted] = useState<number | null>(null);
  useEffect(() => { setText(String(props.value)); }, [props.value]);

  const commit = (): void => {
    const typed = Number(text.trim());
    const next = clampNumber(text.trim() === '' ? Number.NaN : typed, props.range);
    setAdjusted(Number.isFinite(typed) && next !== Math.round(typed) ? next : null);
    setText(String(next));
    if (next !== props.value) props.onCommit(next);
  };

  return (
    <div className="set-row">
      <div className="set-row-label">
        <label htmlFor={props.id}>{props.label}</label>
        <div className="set-hint">{props.hint} {t('settings.range.between', { min: props.range.min, max: props.range.max })}</div>
        {adjusted !== null ? <div className="set-adjusted" role="status">{t('settings.adjusted', { value: adjusted })}</div> : null}
      </div>
      <div className="set-row-control">
        <Input id={props.id} inputMode="numeric" value={text} onChange={(event) => { setText(event.target.value); setAdjusted(null); }}
          onBlur={commit} onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) commit(); }} />
      </div>
    </div>
  );
}

export function DesktopPrefs() {
  const t = useT();
  const [state, setState] = useState<DesktopState | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void ipc('desktop-state:get').then((response) => {
      if (cancelled) return;
      if (response.ok) setState(response.value);
      else setFailed(true);
    });
    return () => { cancelled = true; };
  }, []);

  const patch = useCallback(async (change: Partial<Omit<DesktopState, 'extras' | 'schema'>>) => {
    const response = await ipc('desktop-state:patch', change);
    if (response.ok) { setState(response.value); setFailed(false); } else setFailed(true);
  }, []);

  const changeLanguage = (value: LanguageSetting): void => {
    setLanguage(resolveLanguage(value, navigator.language));
    void patch({ language: value });
  };

  if (!state) {
    return failed ? <p className="set-error" role="alert">{t('settings.desktop.loadFailed')}</p> : null;
  }
  return (
    <section className="set-card" aria-labelledby="desk-title">
      <header className="set-card-head"><h3 id="desk-title">{t('settings.section.desktop')}</h3></header>
      <p className="set-desc">{t('settings.desktop.note')}</p>
      <div className="set-rows">
        <div className="set-row">
          <div className="set-row-label"><label htmlFor="desk-lang">{t('settings.field.language')}</label></div>
          <div className="set-row-control">
            <Select id="desk-lang" value={state.language} onChange={(event) => changeLanguage(event.target.value as LanguageSetting)}>
              <option value="auto">{t('settings.opt.language.auto')}</option>
              <option value="en">English</option>
              <option value="zh-CN">{'简体中文'}</option>
            </Select>
          </div>
        </div>
        <div className="set-row">
          <div className="set-row-label">
            <label htmlFor="desk-enter">{t('settings.field.enterToSend')}</label>
            <div className="set-hint">{t('settings.hint.enterToSend')}</div>
          </div>
          <div className="set-row-control">
            <Switch id="desk-enter" label={t('settings.field.enterToSend')} checked={state.enterToSend}
              onCheckedChange={(checked) => void patch({ enterToSend: checked })} />
          </div>
        </div>
        <div className="set-row">
          <div className="set-row-label">
            <label htmlFor="desk-group">{t('settings.field.groupToolRuns')}</label>
            <div className="set-hint">{t('settings.hint.groupToolRuns')}</div>
          </div>
          <div className="set-row-control">
            <Switch id="desk-group" label={t('settings.field.groupToolRuns')} checked={state.groupToolRuns}
              onCheckedChange={(checked) => { useUi.getState().setGroupToolRuns(checked); void patch({ groupToolRuns: checked }); }} />
          </div>
        </div>
        <NumberPref id="desk-hosts" label={t('settings.field.maxLiveHosts')} hint={t('settings.hint.maxLiveHosts')}
          value={state.maxLiveHosts} range={LIMITS.maxLiveHosts} onCommit={(value) => void patch({ maxLiveHosts: value })} />
        <NumberPref id="desk-park" label={t('settings.field.parkAfterIdle')} hint={t('settings.hint.parkAfterIdle')}
          value={state.parkAfterIdleMinutes} range={LIMITS.parkAfterIdleMinutes}
          onCommit={(value) => void patch({ parkAfterIdleMinutes: value })} />
      </div>
      {failed ? <p className="set-error" role="alert">{t('settings.desktop.saveFailed')}</p> : null}
    </section>
  );
}
