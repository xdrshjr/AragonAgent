/**
 * The live "what is it doing" line at the tail of the transcript: a spinner, a thinking word or
 * the running tool's phrase, and how long the run has been going.
 *
 * Friendly voice only. In developer mode there is no such line (the contract of that mode is
 * "looks as it did before this feature", and the running badge on the tool card already says it).
 * It is NOT a transcript entry and not part of the virtual list, so it costs the height cache
 * nothing. The rotating words are deliberately outside any `aria-live` region: reading a new
 * word aloud every four seconds would drown the conversation. Screen readers get the stable
 * label "Working" and the elapsed time instead.
 */

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { Entry } from '@aragon-agent/tui/model/agent/reducer';
import { pickActivityArgs } from '@aragon-agent/tui/model/team/activity';
import { hash32 } from '@aragon-agent/tui/ui/persona-names';
import type { VoiceMode } from '@aragon-agent/tui/ui/tool-voice';
import { getLanguage, useT } from '../i18n/index.js';
import { voicePhrase, voiceThinkingWord } from '../lib/tool-voice-i18n.js';
import { makeVoice, useReducedMotion } from '../lib/voice.js';
import { useSession } from '../store/session-store.js';
import { Spinner } from '../ui/primitives.js';

type ToolEntry = Extract<Entry, { kind: 'tool' }>;
const NO_ENTRIES: Entry[] = [];

function runningTools(entries: readonly Entry[]): ToolEntry[] {
  const out: ToolEntry[] = [];
  for (let index = entries.length - 1; index >= 0 && out.length < 8; index -= 1) {
    const entry = entries[index];
    if (entry?.kind === 'tool' && (entry.status === 'running' || entry.status === 'pending')) out.push(entry);
  }
  return out;
}

function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export const ActivityRow = memo(function ActivityRow({ sessionId, voiceMode }: {
  sessionId: string; voiceMode: VoiceMode;
}) {
  const t = useT();
  const running = useSession(sessionId, (mirror) => mirror?.view?.status === 'running');
  const entries = useSession(sessionId, (mirror) => mirror?.view?.entries) ?? NO_ENTRIES;
  const reducedMotion = useReducedMotion();
  const startedAt = useRef(Date.now());
  const [now, setNow] = useState(() => Date.now());
  const live = voiceMode === 'friendly' && running;

  useEffect(() => {
    if (!live) return undefined;
    startedAt.current = Date.now();
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);

  const tools = useMemo(() => runningTools(entries), [entries]);
  // Prose is already moving on screen: the answer itself says the model is working. (The empty
  // assistant entry opened at the start of a turn is not prose yet.)
  const tail = entries[entries.length - 1];
  const writing = tail?.kind === 'assistant' && tail.streaming === true && tail.text.length > 0;
  if (!live || writing) return null;

  const voice = makeVoice('friendly', reducedMotion);
  const lang = getLanguage();
  const lead = tools[0];
  const phrase = lead
    ? voicePhrase({
      tool: lead.name, args: pickActivityArgs(lead.args), wide: true,
      variantSeed: hash32(lead.toolCallId), budget: 80,
    }, voice, lang)
    : voiceThinkingWord(startedAt.current, now, voice, lang);
  const more = tools.length > 1 ? ` +${tools.length - 1}` : '';

  return (
    <div className="activity-row" role="status" aria-label={t('chat.voice.working')}>
      <Spinner />
      <span className="activity-text" aria-hidden="true">{phrase}{more}</span>
      <span className="activity-clock" aria-hidden="true">{formatClock(now - startedAt.current)}</span>
    </div>
  );
});
