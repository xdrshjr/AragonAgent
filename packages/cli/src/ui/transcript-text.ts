/**
 * Plain-text session rendering (spec §4.4). Pure, colorless, ANSI-free, so the
 * exit replay can be piped, diffed, or pasted into an issue.
 *
 * Used only by the full-screen exit replay: inline mode already left the real
 * transcript in the terminal's native scrollback, and replaying there would
 * simply print everything twice.
 */

import type { Entry, UsageTotal } from '../agent/reducer.js';
import { formatCost, formatDuration, formatTokens } from '../agent/usage.js';
import type { Glyphs } from './glyphs.js';

export interface TranscriptTextOptions {
  /**
   * Glyph set for the terminal being replayed into. The exit replay lands in
   * the SAME terminal the TUI just left, so it degrades by the same rule; it
   * used to spell 11 Unicode literals of its own and wrote mojibake straight
   * into the user's normal buffer on a legacy console.
   */
  glyphs: Glyphs;
  usageTotal: UsageTotal;
  model: string;
  provider: string;
  elapsedMs: number;
  /** Entries beyond this count collapse into a single "… N omitted" line. */
  maxEntries?: number;
}

const DEFAULT_MAX_ENTRIES = 200;
const CONTINUATION_INDENT = '  ';
const TOOL_INDENT = '  ';
const MAX_ARG_CHARS = 60;

/** Prefix the first line with `marker`, indent the rest to line up under it. */
function block(marker: string, text: string): string[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const head = `${marker} ${lines[0] ?? ''}`.trimEnd();
  const rest = lines.slice(1).map((l) => `${CONTINUATION_INDENT}${l}`.trimEnd());
  return [head, ...rest];
}

/** A short, single-line rendering of the tool's arguments. */
function argSummary(entry: Extract<Entry, { kind: 'tool' }>, glyphs: Glyphs): string {
  const source = entry.args ?? safeParse(entry.argsRaw);
  if (!source) return '';
  const parts: string[] = [];
  for (const value of Object.values(source)) {
    if (typeof value === 'string') parts.push(value);
    else if (typeof value === 'number' || typeof value === 'boolean') parts.push(String(value));
    if (parts.length >= 2) break;
  }
  const joined = parts.join(' ').replace(/\s+/g, ' ').trim();
  if (joined.length === 0) return '';
  return joined.length > MAX_ARG_CHARS
    ? `${joined.slice(0, MAX_ARG_CHARS - 1)}${glyphs.ellipsis}`
    : joined;
}

function safeParse(raw: string): Record<string, unknown> | null {
  if (!raw || raw.trim().length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function renderEntry(entry: Entry, glyphs: Glyphs): string[] {
  switch (entry.kind) {
    case 'user':
      return block(glyphs.user, entry.text);
    case 'assistant': {
      const suffix = entry.aborted ? ' (aborted)' : '';
      return block(glyphs.assistant, `${entry.text}${suffix}`);
    }
    case 'tool': {
      const glyph = entry.isError || entry.status === 'error' ? glyphs.toolError : glyphs.toolDone;
      const args = argSummary(entry, glyphs);
      const duration = entry.durationMs === undefined ? '' : ` (${entry.durationMs}ms)`;
      return [`${TOOL_INDENT}${glyph} ${entry.label || entry.name}${args ? ` ${args}` : ''}${duration}`];
    }
    case 'notice': {
      const glyph =
        entry.level === 'error'
          ? glyphs.error
          : entry.level === 'warn'
          ? glyphs.warn
          : glyphs.info;
      return block(`${TOOL_INDENT}${glyph}`, entry.text);
    }
    default:
      return [];
  }
}

/** Render the whole session (summary line + entries) as plain text. */
export function renderTranscriptText(entries: Entry[], opts: TranscriptTextOptions): string {
  const turns = entries.filter((e) => e.kind === 'user').length;
  const g = opts.glyphs;
  const tokens = `${formatTokens(opts.usageTotal.inputTokens)}${g.arrowUp} ${formatTokens(
    opts.usageTotal.outputTokens,
  )}${g.arrowDown}`;
  const summary = [
    'argon',
    `${opts.provider}:${opts.model}`,
    `${turns} ${turns === 1 ? 'turn' : 'turns'}`,
    tokens,
    formatCost(opts.usageTotal.costUsd),
    formatDuration(Math.max(0, opts.elapsedMs)),
  ].join(` ${g.midDot} `);

  const max = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const lines: string[] = [summary];

  if (entries.length > max && max > 1) {
    const head = Math.ceil(max / 2);
    const tail = max - head;
    const omitted = entries.length - max;
    for (const entry of entries.slice(0, head)) lines.push(...renderEntry(entry, g));
    lines.push(`${g.ellipsis} ${omitted} entries omitted ${g.midDot} use /save before exiting`);
    for (const entry of entries.slice(entries.length - tail)) {
      lines.push(...renderEntry(entry, g));
    }
  } else {
    for (const entry of entries) lines.push(...renderEntry(entry, g));
  }

  return `${lines.join('\n')}\n`;
}
