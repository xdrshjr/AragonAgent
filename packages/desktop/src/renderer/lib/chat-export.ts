/**
 * Transcript -> Markdown (pure; the save dialog and secret scrubbing happen in the main process).
 *
 * Default output is what a person wants to share: what they said, what the assistant answered, and
 * one line per tool call. Tool OUTPUT is opt-in (and truncated) because that is where credentials
 * and private file contents turn up. An entry kind this file does not know renders as an explicit
 * "unsupported" line instead of vanishing, and `KIND_RENDERERS` is typed against `Entry['kind']`, so
 * a new kind in the engine is a compile error here rather than a silently shorter export.
 */

import type { Entry } from '@aragon-agent/tui/model/agent/reducer';
import type { AttachmentMeta } from '@aragon-agent/tui/model/agent/attachment-meta';
import { formatBytes } from '../../shared/attachments.js';

export interface ExportOptions {
  includeToolOutput: boolean;
  includeThinking: boolean;
}

export interface ExportMeta {
  title: string | null;
  appVersion: string;
  /** ISO timestamp. */
  exportedAt: string;
  sessionId: string;
  cwdName: string;
}

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = { includeToolOutput: false, includeThinking: false };
export const TOOL_OUTPUT_LIMIT = 2048;
const ARG_SUMMARY_LIMIT = 120;

/** A fence longer than any backtick run inside `text`, so the content cannot close it early. */
export function fenceFor(text: string): string {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return '`'.repeat(Math.max(3, longest + 1));
}

function fenced(text: string): string {
  const fence = fenceFor(text);
  return `${fence}\n${text}\n${fence}`;
}

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/** The first argument worth showing: a command, a path, a pattern - not the whole JSON. */
export function summarizeArgs(entry: Extract<Entry, { kind: 'tool' }>): string {
  const first = entry.args ? Object.values(entry.args).find((value) => typeof value === 'string' && value !== '') : undefined;
  const text = typeof first === 'string' ? first : entry.argsRaw;
  return clip(oneLine(text ?? ''), ARG_SUMMARY_LIMIT).replace(/`/g, "'");
}

function truncateOutput(text: string): { text: string; truncated: boolean } {
  return text.length <= TOOL_OUTPUT_LIMIT
    ? { text, truncated: false }
    : { text: text.slice(0, TOOL_OUTPUT_LIMIT), truncated: true };
}

/**
 * One quoted line per attachment: its reference, display name, kind and size. Never the bytes and
 * never a path on the exporter's machine (an export is meant to be shared).
 */
export function attachmentLines(attachments: readonly AttachmentMeta[] | undefined): string {
  if (!attachments || attachments.length === 0) return '';
  const lines = attachments.map((a) => {
    const size = a.kind === 'folder' ? '' : `, ${formatBytes(a.size)}`;
    return `> 📎 ${a.ref} — ${oneLine(a.name)} (${a.kind}${size})`;
  });
  return `\n\n${lines.join('\n')}`;
}

type Render = (entry: never, options: ExportOptions) => string | null;

const KIND_RENDERERS: { [K in Entry['kind']]: (entry: Extract<Entry, { kind: K }>, options: ExportOptions) => string | null } = {
  user: (entry) => `## You\n\n${entry.text}${attachmentLines(entry.attachments)}`,
  queued: (entry) => `## You *(queued)*\n\n${entry.text}${attachmentLines(entry.attachments)}`,
  assistant: (entry, options) => {
    const parts = ['## Assistant', ''];
    if (options.includeThinking && entry.thinking) parts.push('<details><summary>Thinking</summary>', '', entry.thinking, '', '</details>', '');
    parts.push(entry.aborted ? `${entry.text}\n\n*(stopped)*` : entry.text);
    return parts.join('\n');
  },
  tool: (entry, options) => {
    const status = entry.isError ? 'failed' : entry.status;
    const line = `*Tool · ${entry.name}${summarizeArgs(entry) ? ` · \`${summarizeArgs(entry)}\`` : ''} — ${status}*`;
    if (!options.includeToolOutput) return line;
    const output = entry.preview ?? entry.live?.join('\n') ?? '';
    if (output === '') return line;
    const { text, truncated } = truncateOutput(output);
    return `${line}\n\n${fenced(text)}${truncated ? '\n\n*(output truncated)*' : ''}`;
  },
  notice: (entry) => `*${oneLine(entry.text)}*`,
  governance: () => '*(governance event)*',
  team: () => '*(team activity)*',
  todo: () => '*(plan updated)*',
  retry: (entry) => `*Retry · ${oneLine(entry.message)}*`,
  fast: (entry) => (entry.text ? `*Fast model · ${oneLine(entry.text)}*` : `*Fast model · ${entry.status}*`),
  compaction: () => '*(earlier conversation compacted)*',
  service: () => '*(background service)*',
};

export function transcriptToMarkdown(entries: readonly Entry[], meta: ExportMeta, options: ExportOptions): string {
  const lines: string[] = [
    `# ${oneLine(meta.title ?? '') || 'Untitled session'}`,
    '',
    `> Exported from AragonAgent Desktop ${meta.appVersion} · ${meta.exportedAt} · session ${meta.sessionId.slice(0, 8)}${meta.cwdName ? ` · ${meta.cwdName}` : ''}`,
    '',
  ];
  for (const entry of entries) {
    const render = KIND_RENDERERS[entry.kind] as Render | undefined;
    const block = render ? render(entry as never, options) : `*(unsupported entry: ${String((entry as { kind: unknown }).kind)})*`;
    if (block !== null) lines.push(block, '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
