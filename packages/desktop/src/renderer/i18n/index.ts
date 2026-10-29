/**
 * Typed message catalogue. English is the canonical key language and the fallback; every other
 * language must provide exactly the same keys (a type error otherwise).
 *
 * Each feature area owns ONE file under `dicts/` and registers it below, so two people editing
 * different areas never touch the same file. Text sent to the MODEL never goes through here:
 * prompts are English, supplied by the engine.
 */
import { useSyncExternalStore } from 'react';
import type { Dict } from './define.js';
import { chat } from './dicts/chat.js';
import { common } from './dicts/common.js';
import { engine } from './dicts/engine.js';
import { settings } from './dicts/settings.js';
import { slash } from './dicts/slash.js';
import { shell } from './dicts/shell.js';
import { workspace } from './dicts/workspace.js';

export type Language = 'en' | 'zh-CN';

export { defineDict, type Dict } from './define.js';

const areas = [common, shell, chat, settings, slash, engine, workspace];
type Keys<T> = T extends Dict<infer K> ? K : never;
export type MessageKey = Keys<(typeof areas)[number]>;

const catalogue: Record<Language, Record<string, string>> = { en: {}, 'zh-CN': {} };
for (const area of areas) {
  Object.assign(catalogue.en, area.en);
  Object.assign(catalogue['zh-CN'], area['zh-CN']);
}

let current: Language = 'en';
const listeners = new Set<() => void>();

export function resolveLanguage(setting: 'auto' | Language, systemLocale: string): Language {
  if (setting !== 'auto') return setting;
  return systemLocale.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

export function setLanguage(language: Language): void {
  if (language === current) return;
  current = language;
  document.documentElement.lang = language;
  for (const listener of listeners) listener();
}

export function getLanguage(): Language {
  return current;
}

/** Look up a message, interpolating `{name}` placeholders. A missing key shows the key itself. */
export function translate(key: MessageKey, params?: Record<string, string | number>): string {
  const template = catalogue[current][key] ?? catalogue.en[key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => String(params[name] ?? `{${name}}`));
}

/**
 * The message for a key that is only known at run time (for example `slash.<command>`), or
 * `null` when no language has it - so the caller can pick its own fallback instead of showing
 * the raw key.
 */
export function lookupMessage(key: string): string | null {
  return catalogue[current][key] ?? catalogue.en[key] ?? null;
}

export type Translate = typeof translate;

/** Re-renders the component when the language changes. */
export function useT(): Translate {
  useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => current,
    () => current,
  );
  return translate;
}

/** For tests: every language has every key (the type system already enforces it per area). */
export function catalogueKeys(language: Language): string[] {
  return Object.keys(catalogue[language]);
}
