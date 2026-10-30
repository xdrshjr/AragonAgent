/**
 * The tool card family. One shell (header button, status, duration) and a body chosen by the
 * tool's family: bash gets a command block with ANSI output, edit/write get a diff, the rest
 * a collapsed summary with arguments and output on expand. Expansion lives in the session's
 * view state (`expandedToolIds`), so it survives a resync or window reload.
 */

import {
  AlertCircle, Check, ChevronRight, FilePen, FilePlus, FileText, FolderOpen, Hourglass, Search,
  Terminal, Wrench,
} from 'lucide-react';
import { memo, useEffect, useState, type ReactNode } from 'react';
import type { Entry } from '@aragon-agent/tui/model/agent/reducer';
import type { FilePatch } from '@aragon-agent/tui/model/tools/patch';
import { pickActivityArgs } from '@aragon-agent/tui/model/team/activity';
import { hash32 } from '@aragon-agent/tui/ui/persona-names';
import type { VoiceMode } from '@aragon-agent/tui/ui/tool-voice';
import { getLanguage, useT } from '../../i18n/index.js';
import { makeVoice, useReducedMotion } from '../../lib/voice.js';
import { voicePhrase, voiceTitle } from '../../lib/tool-voice-i18n.js';
import { parseExternalToolName, serverLabel } from '../../lib/external-tool-name.js';
import {
  clip, formatSeconds, patchCounts, summarizeToolArgs, toolFamily, type ToolFamily,
} from '../../lib/chat-format.js';
import { sessionStore } from '../../store/session-store.js';
import { useConfig } from '../../store/config-store.js';
import { Spinner } from '../../ui/primitives.js';
import { AnsiOutput } from './AnsiOutput.js';
import { DiffView } from './DiffView.js';
import { WaitCard } from './WaitCard.js';

type ToolEntry = Extract<Entry, { kind: 'tool' }>;

const LIVE_TAIL_ROWS = 8;
const ARGS_PREVIEW_CHARS = 8000;

const ICONS: Record<ToolFamily, typeof Terminal> = {
  bash: Terminal, edit: FilePen, write: FilePlus, read: FileText, search: Search, list: FolderOpen,
  job: Hourglass, generic: Wrench,
};

function isPatch(value: unknown): value is FilePatch {
  return typeof value === 'object' && value !== null && Array.isArray((value as FilePatch).hunks);
}

/** The diff for an edit/write card: carried on the entry, or fetched once from the host on expand. */
function usePatch(sessionId: string, entry: ToolEntry, wanted: boolean): FilePatch | null {
  const [fetched, setFetched] = useState<FilePatch | null>(null);
  const needsFetch = wanted && !entry.patch && entry.status === 'done' && !entry.isError;
  useEffect(() => {
    if (!needsFetch || fetched) return undefined;
    let cancelled = false;
    void sessionStore.command(sessionId, { c: 'file-patch.get', toolCallId: entry.toolCallId }).then((result) => {
      if (!cancelled && result.ok && isPatch(result.value)) setFetched(result.value);
    });
    return () => { cancelled = true; };
  }, [needsFetch, fetched, sessionId, entry.toolCallId]);
  return entry.patch ?? fetched;
}

function StatusMark({ status, isError }: { status: ToolEntry['status']; isError?: boolean | undefined }) {
  const t = useT();
  if (status === 'pending' || status === 'running') {
    return <span className="tool-status"><Spinner label={t(`chat.tool.status.${status}` as const)} /></span>;
  }
  const failed = status === 'error' || isError;
  const label = t(failed ? 'chat.tool.status.error' : 'chat.tool.status.done');
  return (
    <span className="tool-status" data-failed={failed ? 'true' : undefined} role="img" aria-label={label} title={label}>
      {failed ? <AlertCircle size={14} strokeWidth={1.5} /> : <Check size={14} strokeWidth={1.5} />}
    </span>
  );
}

function countResultLines(preview: string | undefined): { count: number; more: boolean } {
  if (!preview) return { count: 0, more: false };
  const rows = preview.split('\n').filter((row) => row.trim() !== '');
  const more = rows[rows.length - 1] === '...';
  return { count: more ? rows.length - 1 : rows.length, more };
}

function formatArgs(entry: ToolEntry): string {
  const text = entry.args ? JSON.stringify(entry.args, null, 2) : entry.argsRaw;
  return clip(text, ARGS_PREVIEW_CHARS);
}

/** Screen-reader name for the header in the friendly voice: outcome first, never the identifier. */
function friendlyLabel(entry: ToolEntry, toolName: string, t: ReturnType<typeof useT>): string {
  const state = entry.status === 'pending' || entry.status === 'running'
    ? t('chat.tool.status.running')
    : t(entry.status === 'error' || entry.isError ? 'chat.tool.status.error' : 'chat.tool.status.done');
  const detail = summarizeToolArgs(entry);
  return `${state}: ${toolName}${detail ? ` ${detail}` : ''}`;
}

function Body(props: { sessionId: string; entry: ToolEntry; family: ToolFamily }) {
  const t = useT();
  const { entry, family } = props;
  const patch = usePatch(props.sessionId, entry, family === 'edit' || family === 'write');
  if (patch) return <DiffView patch={patch} />;
  const command = family === 'bash' && typeof entry.args?.['command'] === 'string' ? entry.args['command'] : null;
  return (
    <div className="tool-body">
      {command !== null
        ? <pre className="tool-command selectable">{command}</pre>
        : <pre className="tool-args-full selectable">{formatArgs(entry)}</pre>}
      {entry.preview
        ? <AnsiOutput text={entry.preview} label={t('chat.tool.output')} />
        : entry.live && entry.live.length > 0
          ? <AnsiOutput rows={entry.live} label={t('chat.tool.live')} />
          : <div className="tool-empty">{entry.status === 'done' ? t('chat.tool.noOutput') : ''}</div>}
    </div>
  );
}

function headerSummary(entry: ToolEntry, family: ToolFamily, t: ReturnType<typeof useT>): ReactNode {
  const base = summarizeToolArgs(entry);
  if (family === 'search' && entry.status === 'done') {
    const { count, more } = countResultLines(entry.preview);
    return <>{base} <span className="tool-count">{t(more ? 'chat.tool.matchesMore' : 'chat.tool.matches', { n: count })}</span></>;
  }
  if ((family === 'edit' || family === 'write') && entry.patch) {
    return <>{base} <span className="tool-count">{patchCounts(entry.patch)}</span></>;
  }
  return base;
}

const PHRASE_BUDGET = 80;

/**
 * What the card's header calls the tool. Friendly: a playful phrase while the call is live
 * (chosen once per call from its id, so it never flickers) and the steady title afterwards.
 * Developer: the registry label, exactly as before this feature.
 */
function useToolName(entry: ToolEntry, voiceMode: VoiceMode): string {
  const reducedMotion = useReducedMotion();
  if (voiceMode === 'developer') return entry.label;
  const lang = getLanguage();
  if (entry.status === 'pending' || entry.status === 'running') {
    return voicePhrase(
      {
        tool: entry.name, args: pickActivityArgs(entry.args), wide: true,
        variantSeed: hash32(entry.toolCallId), budget: PHRASE_BUDGET,
      },
      makeVoice('friendly', reducedMotion), lang,
    );
  }
  // A tool from outside the app is titled by its own name (`browser_navigate`), not by the wrapper
  // around it; where it came from is shown beside the title (see `ToolCard`).
  return voiceTitle(parseExternalToolName(entry.name)?.tool ?? entry.name, 'friendly', lang);
}

export const ToolCard = memo(function ToolCard(props: {
  sessionId: string; entry: ToolEntry; expanded: boolean; voiceMode: VoiceMode;
}) {
  const t = useT();
  const { entry, expanded, sessionId, voiceMode } = props;
  const toolName = useToolName(entry, voiceMode);
  const origin = voiceMode === 'friendly' ? parseExternalToolName(entry.name) : null;
  const family = toolFamily(entry.name);
  const summary = headerSummary(entry, family, t);
  const Icon = ICONS[family];
  const liveOutput = useConfig((state) => state.result?.view?.liveToolOutput) !== false;
  const running = entry.status === 'running';
  const toggle = (): void => sessionStore.dispatchLocal(sessionId, { type: 'toggleExpand', id: entry.id });

  return (
    <div className="tool" data-status={entry.status} data-failed={entry.isError ? 'true' : undefined}>
      <button type="button" className="tool-head" aria-expanded={expanded} onClick={toggle}
        {...(voiceMode === 'friendly' ? { 'aria-label': friendlyLabel(entry, toolName, t) } : {})}>
        <ChevronRight size={14} strokeWidth={1.5} className="chev" aria-hidden="true" />
        <Icon size={14} strokeWidth={1.5} aria-hidden="true" />
        <span className="tool-name">{toolName}</span>
        {origin ? <span className="tool-origin">{t('chat.tool.from', { server: serverLabel(origin.server) })}</span> : null}
        <span className="tool-summary">{summary}</span>
        <StatusMark status={entry.status} isError={entry.isError} />
        {entry.durationMs !== undefined ? <span className="tool-time">{formatSeconds(entry.durationMs)}</span> : null}
      </button>
      {entry.wait && running ? <WaitCard view={entry.wait} /> : null}
      {!expanded && running && liveOutput && entry.live && entry.live.length > 0
        ? <AnsiOutput rows={entry.live} tail={LIVE_TAIL_ROWS} label={t('chat.tool.live')} />
        : null}
      {expanded && voiceMode === 'developer' ? <code className="tool-ident selectable">{entry.name}</code> : null}
      {expanded ? <Body sessionId={sessionId} entry={entry} family={family} /> : null}
    </div>
  );
});
