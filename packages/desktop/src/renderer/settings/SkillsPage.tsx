/**
 * Settings > Skills: the skill policy form, plus the installed skills with a per-skill on/off
 * switch backed by `skills.disabled`.
 *
 * The listing comes from `skills:list` (a throwaway engine process in the main process), so it
 * works with no session open. A name that is switched off in the config but no longer installed
 * stays in the list - marked "not found" - so it can always be switched back on. Toggles are
 * saved immediately, as one compare-and-swap patch.
 */

import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SkillInfoDto } from '../../shared/port-protocol.js';
import { ipc } from '../api.js';
import { useT } from '../i18n/index.js';
import { SECTIONS } from '../lib/settings-sections.js';
import { useConfig } from '../store/config-store.js';
import { Badge, IconButton, Switch } from '../ui/primitives.js';
import { SectionForm } from './SectionForm.js';

const NO_NAMES: readonly string[] = [];

const SOURCE_KEYS = {
  project: 'settings.skills.source.project',
  user: 'settings.skills.source.user',
  env: 'settings.skills.source.env',
  bundled: 'settings.skills.source.bundled',
} as const satisfies Record<SkillInfoDto['source'], string>;

type Listing =
  | { state: 'loading' }
  | { state: 'ready'; skills: SkillInfoDto[] }
  | { state: 'error'; message: string };

interface Row { name: string; info: SkillInfoDto | null }

export function SkillsPage() {
  const t = useT();
  const disabled = useConfig((state) => state.result?.view?.skills.disabled) ?? NO_NAMES;
  const ready = useConfig((state) => state.result?.view !== null && state.result?.view !== undefined);
  const [listing, setListing] = useState<Listing>({ state: 'loading' });
  const [failed, setFailed] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setListing({ state: 'loading' });
    const result = await ipc('skills:list');
    setListing(result.ok ? { state: 'ready', skills: result.value.skills } : { state: 'error', message: result.message });
  }, []);
  useEffect(() => { void load(); }, [load]);

  const rows = useMemo<Row[]>(() => {
    const installed = listing.state === 'ready' ? listing.skills : [];
    const known = new Set(installed.map((skill) => skill.name));
    const orphans = disabled.filter((name) => !known.has(name));
    return [
      ...installed.map((info): Row => ({ name: info.name, info })),
      ...orphans.map((name): Row => ({ name, info: null })),
    ];
  }, [listing, disabled]);

  const save = async (next: string[]): Promise<void> => {
    const outcome = await useConfig.getState().patch({ skills: { disabled: next } });
    setFailed(outcome.ok || outcome.code === 'conflict' ? null : outcome.code);
    if (outcome.ok) void load();
  };
  const toggle = (skill: string, enabled: boolean): Promise<void> =>
    save(enabled ? disabled.filter((item) => item !== skill) : [...disabled, skill]);

  return (
    <div className="set-page">
      <SectionForm section={SECTIONS.skills} />
      <section className="set-card" aria-labelledby="skills-list">
        <header className="set-card-head">
          <h3 id="skills-list">{t('settings.skills.listTitle')}</h3>
          <IconButton size="sm" label={t('settings.skills.refresh')} onClick={() => void load()}>
            <RefreshCw size={14} strokeWidth={1.5} />
          </IconButton>
        </header>
        <p className="set-desc">{t('settings.skills.hint')}</p>
        {listing.state === 'loading' ? <p className="set-empty" role="status">{t('settings.skills.loading')}</p> : null}
        {listing.state === 'error' ? (
          <p className="set-error" role="alert">{t('settings.skills.error', { message: listing.message })}</p>
        ) : null}
        {listing.state !== 'loading' && rows.length === 0 && listing.state !== 'error'
          ? <p className="set-empty">{t('settings.skills.empty')}</p> : null}
        {rows.length > 0 ? (
          <ul className="mp-list">
            {rows.map(({ name, info }) => {
              const off = disabled.includes(name);
              return (
                <li key={name} className="mp-row">
                  <div className="mp-main">
                    <strong className="mp-name selectable">{name}</strong>
                    {info ? <Badge>{t(SOURCE_KEYS[info.source])}</Badge>
                      : <Badge tone="warning">{t('settings.skills.missing')}</Badge>}
                    {info?.invalid ? <Badge tone="warning">{t('settings.skills.invalid')}</Badge> : null}
                    {info?.description ? <span className="mp-sub selectable">{info.description}</span> : null}
                  </div>
                  <div className="mp-actions">
                    <span className="set-status">{off ? t('settings.skills.off') : t('settings.skills.on')}</span>
                    <Switch label={t('settings.skills.toggle', { name })} checked={!off}
                      disabled={!ready} onCheckedChange={(enabled) => void toggle(name, enabled)} />
                  </div>
                </li>
              );
            })}
          </ul>
        ) : null}
        {failed ? <p className="set-error" role="alert">{t('settings.error.save', { code: failed })}</p> : null}
      </section>
    </div>
  );
}
