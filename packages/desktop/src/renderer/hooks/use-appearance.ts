/**
 * Applies the user's appearance settings to the document root.
 *
 * `theme` is READ FROM the terminal's own `config.json` key (so switching it here changes it
 * there too); `auto` follows the operating system live. Density and reduced-motion are the
 * terminal's keys as well. This hook only translates them into `data-*` attributes that the
 * token stylesheet reads; it owns no state of its own.
 */

import { useEffect, useRef, useState } from 'react';
import { ipc } from '../api.js';

export type ThemeSetting = 'auto' | 'warm' | 'cool' | 'light';
export type ResolvedTheme = 'dark' | 'light' | 'warm';

export function resolveTheme(setting: ThemeSetting, systemDark: boolean): ResolvedTheme {
  if (setting === 'light') return 'light';
  if (setting === 'warm') return 'warm';
  if (setting === 'cool') return 'dark';
  return systemDark ? 'dark' : 'light';
}

function useSystemDark(): boolean {
  const query = '(prefers-color-scheme: dark)';
  const [dark, setDark] = useState(() => window.matchMedia?.(query).matches ?? true);
  useEffect(() => {
    const media = window.matchMedia?.(query);
    if (!media) return undefined;
    const onChange = (event: MediaQueryListEvent): void => setDark(event.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
  return dark;
}

export function useAppearance(input: {
  theme: ThemeSetting | undefined;
  density: string | undefined;
  reducedMotion: boolean | undefined;
  /**
   * Tell the main process which theme is showing, so the native caption buttons match it. Only true
   * once the config has loaded: before that `theme` is undefined, which resolves to `auto` (the OS),
   * and sending THAT would overwrite the persisted choice with the OS's for the first moments.
   */
  enabled?: boolean;
}): ResolvedTheme {
  const systemDark = useSystemDark();
  const theme = resolveTheme(input.theme ?? 'auto', systemDark);
  const reported = useRef<ResolvedTheme | null>(null);
  useEffect(() => {
    if (!input.enabled || reported.current === theme) return;
    reported.current = theme;
    void ipc('window:set-chrome', { theme }).then((result) => {
      // A failed call is retried by the next change; do not remember it as delivered.
      if (!result.ok && reported.current === theme) reported.current = null;
    });
  }, [input.enabled, theme]);
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.dataset.density = input.density === 'compact' ? 'compact' : 'comfortable';
    root.dataset.reducedMotion = input.reducedMotion ? 'true' : 'false';
  }, [theme, input.density, input.reducedMotion]);
  return theme;
}
