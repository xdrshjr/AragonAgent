/**
 * The voice a surface speaks in: friendly (human wording, a little play while work is running)
 * or developer (the raw identifiers, byte-for-byte what the app showed before this feature).
 *
 * Components take `voiceMode` as a REQUIRED prop and receive it from here at the top of the tree,
 * so forgetting to pass it is a compile error rather than a silent fallback to one voice.
 */

import { useEffect, useState } from 'react';
import type { VoiceContext, VoiceMode } from '@aragon-agent/tui/ui/tool-voice';
import { getLanguage, useT, type Language } from '../i18n/index.js';
import { useConfig } from '../store/config-store.js';
import { useUi } from '../store/ui-store.js';

function readReducedMotion(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** The OS preference, kept live. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(readReducedMotion);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return undefined;
    const query = matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (): void => setReduced(query.matches);
    query.addEventListener?.('change', onChange);
    return () => query.removeEventListener?.('change', onChange);
  }, []);
  return reduced;
}

export interface VoiceState {
  voiceMode: VoiceMode;
  voice: VoiceContext;
  lang: Language;
  reducedMotion: boolean;
}

export function makeVoice(mode: VoiceMode, reducedMotion: boolean): VoiceContext {
  // Persona names are out of scope for the desktop (spec section 11): `nameOf` is always empty.
  return { mode, reducedMotion, nameOf: () => '' };
}

/** The OS preference OR the app's own "reduce motion" setting. */
export function useReducedMotion(): boolean {
  const system = usePrefersReducedMotion();
  const configured = useConfig((state) => state.result?.view?.reducedMotion) === true;
  return system || configured;
}

export function useVoice(): VoiceState {
  useT(); // re-render when the language changes
  const developer = useUi((state) => state.developerMode);
  const reducedMotion = useReducedMotion();
  const voiceMode: VoiceMode = developer ? 'developer' : 'friendly';
  return { voiceMode, voice: makeVoice(voiceMode, reducedMotion), lang: getLanguage(), reducedMotion };
}
