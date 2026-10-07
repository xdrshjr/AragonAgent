import type { Entry, UsageTotal } from '../agent/reducer.js';
import { formatCost, formatDuration, formatTokens, promptTokensOf } from '../agent/usage.js';
import { formatRetryLine } from '../agent/retry-view.js';
import type { Glyphs } from './glyphs.js';
// TYPE-ONLY: this module stays free of React, ink and the supervisor itself.
import type { ServiceStatus } from '../proc/types.js';

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
  /**
   * Entries the retain ring already removed from `ViewState`
   * (tui-render-performance L1 / K-6).
   *
   * A DIFFERENT LOSS FROM `maxEntries`, and both have to be reported: that one
   * omits the middle of a transcript this replay still holds in full, while this
   * one names entries the process no longer has. A replay that silently starts
   * mid-session is exactly the failure the retain ring would otherwise
   * introduce.
   */
  droppedEntries?: number;
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

/**
 * The replay's glyph for a service, MIRRORING `ServiceCard::serviceGlyph`.
 *
 * The two ladders have to agree, and the cheap-looking shortcut here — "ready or
 * running is a tick, everything else is an error" — disagrees on the two states
 * a user reaches ON PURPOSE: a service they stopped with `Ctrl+C`, and one that
 * exited cleanly. Marking either as a failure in the record the user is left
 * with after the alternate screen is torn down is a lie about their own action.
 *
 * Duplicated rather than imported, as every other case in this file duplicates
 * its card's ladder: this module is deliberately free of React and ink, and
 * `serviceGlyph` lives in a `.tsx`.
 */
function serviceTextGlyph(
  status: ServiceStatus,
  exitCode: number | null,
  glyphs: Glyphs,
): string {
  switch (status) {
    case 'ready':
      return glyphs.toolDone;
    case 'running':
      return glyphs.toolRunning;
    case 'starting':
    case 'stopped':
      return glyphs.toolPending;
    case 'exited':
      return exitCode === 0 ? glyphs.toolDone : glyphs.toolError;
    default:
      return glyphs.toolError;
  }
}

function renderEntry(entry: Entry, glyphs: Glyphs): string[] {
  switch (entry.kind) {
    case 'queued':
      return block('Queued but never sent:', entry.text);
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
    case 'team': {
      // Same rows as `TeamCard`, without colour (team-subagents §6.3). A
      // dispatch is often the most expensive thing in a session, so leaving it
      // out of the plain-text replay would make the exported transcript
      // unaccountable for most of its own cost.
      const ok = entry.runs.filter((r) => r.phase === 'done' && !r.error).length;
      const failed = entry.runs.length - ok;
      const head =
        entry.active || (entry.aborted && entry.durationMs === undefined)
          ? 'interrupted'
          : `${entry.durationMs ?? 0}ms (${ok} ok, ${failed} failed)`;
      const lines = [
        `${TOOL_INDENT}team ${entry.runs.length} subagents ${head}`,
        ...entry.runs.map((run) => {
          const glyph = run.phase === 'done' && !run.error ? glyphs.toolDone : glyphs.toolError;
          const detail = run.error ? ` ${run.error}` : '';
          return `${TOOL_INDENT}${CONTINUATION_INDENT}${glyph} ${run.label} ${run.description}${detail}`;
        }),
      ];
      return lines;
    }
    case 'retry': {
      // A turn that spent three minutes retrying is exactly the kind of cost an
      // exported transcript is supposed to account for — the same argument the
      // `team` case above makes in its own words. This file's `default: return []`
      // means the addition is a CHOICE rather than a compile requirement, and it is
      // worth making: without it a replay of a session that lost two minutes to a
      // 529 shows a gap and no reason for it.
      const glyph = entry.phase === 'exhausted' ? glyphs.error : glyphs.retry;
      return [
        `${TOOL_INDENT}${glyph} ${formatRetryLine(entry, glyphs, Date.now())}`,
      ];
    }
    case 'fast': {
      // Reviews are real spend and real advice, and an exported transcript that
      // omitted them would be unaccountable for both — the argument the `team`
      // and `retry` cases above each make in their own words.
      const glyph = entry.status === 'failed' ? glyphs.toolError : glyphs.toolDone;
      const duration = entry.durationMs === undefined ? '' : ` (${entry.durationMs}ms)`;
      const head =
        `${TOOL_INDENT}${glyph} fast review #${entry.reviewIndex} ${entry.model} ` +
        `turn ${entry.turn}${duration}`;
      if (entry.status === 'advice' && entry.text) {
        return [head, ...entry.text.split('\n').map((l) => `${TOOL_INDENT}${CONTINUATION_INDENT}${l}`)];
      }
      const detail = entry.detail ? `: ${entry.detail}` : '';
      return [`${head} ${entry.status}${detail}`];
    }
    case 'compaction': {
      // A compaction is real spend AND a real, permanent loss of history, and an
      // exported transcript that omitted it would be unaccountable for both —
      // the argument the `team`, `retry` and `fast` cases above each make in
      // their own words. It matters most here: this is the one entry kind whose
      // presence explains why the messages the reader is looking for are gone.
      const glyph = entry.applied ? glyphs.compaction : glyphs.toolError;
      const duration = entry.durationMs === undefined ? '' : ` (${entry.durationMs}ms)`;
      if (!entry.applied) {
        const why = entry.reason ? `: ${entry.reason}` : '';
        return [`${TOOL_INDENT}${glyph} context not compacted #${entry.index}${why}`];
      }
      const head =
        `${TOOL_INDENT}${glyph} context compacted #${entry.index} ` +
        `${entry.messagesBefore} ${glyphs.arrowRight} ${entry.messagesAfter} messages, ` +
        `${entry.tokensBefore} ${glyphs.arrowRight} ${entry.tokensAfter} tokens ` +
        `[${entry.mode}] ${entry.model}${duration}`;
      if (!entry.summary) return [head];
      return [
        head,
        ...entry.summary.split('\n').map((l) => `${TOOL_INDENT}${CONTINUATION_INDENT}${l}`),
      ];
    }
    case 'service': {
      // A service the agent started is real work with a real outcome, and an
      // exported transcript that omitted it would be unaccountable for both —
      // the argument the `team`, `retry`, `fast` and `compaction` cases above
      // each make in their own words. It matters more here than for any of them:
      // this replay is the user's ONLY record once the alternate screen is torn
      // down (`cli.tsx`'s exit snapshot), and a service card dropped from it
      // takes the URL the agent reported with it. This file's
      // `default: return []` means the addition is a CHOICE rather than a
      // compile requirement, which is exactly why it is easy to leave out
      // (P0-3).
      const glyph = serviceTextGlyph(entry.status, entry.exitCode, glyphs);
      const where = entry.url ? ` ${entry.url}` : '';
      const code =
        entry.exitCode === null || entry.exitCode === undefined
          ? ''
          : ` (exit code ${entry.exitCode})`;
      return [
        `${TOOL_INDENT}${glyph} service ${entry.serviceId} ${entry.command} ` +
          `${entry.status}${where}${code}`.trimEnd(),
      ];
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
  // THE SAME PROMPT-SIDE TOTAL THE STATUS BAR SHOWS (context-usage-gauge-accuracy
  // §3.6). This line is what a user compares against the bar they were watching a
  // second earlier, so a different unit here would look like the exit summary
  // losing tokens.
  const tokens = `${formatTokens(promptTokensOf(opts.usageTotal))}${g.arrowUp} ${formatTokens(
    opts.usageTotal.outputTokens,
  )}${g.arrowDown}`;
  const summary = [
    'aragon',
    `${opts.provider}:${opts.model}`,
    `${turns} ${turns === 1 ? 'turn' : 'turns'}`,
    tokens,
    formatCost(opts.usageTotal.costUsd),
    formatDuration(Math.max(0, opts.elapsedMs)),
  ].join(` ${g.midDot} `);

  const max = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const lines: string[] = [summary];

  const dropped = opts.droppedEntries ?? 0;
  if (dropped > 0) {
    lines.push(
      `${g.ellipsis} ${dropped} earlier ${dropped === 1 ? 'entry' : 'entries'} dropped by ` +
        `transcriptRetain ${g.midDot} raise it or /save sooner`,
    );
  }

  const historyCount = entries.filter((entry) => entry.kind !== 'queued').length;
  const omitted = max > 1 ? Math.max(0, historyCount - max) : 0;
  const head = Math.ceil(max / 2);
  const tailStart = historyCount - (max - head);
  let historyIndex = 0;
  let reported = false;
  for (const entry of entries) {
    if (entry.kind === 'queued') {
      lines.push(...renderEntry(entry, g));
      continue;
    }
    const index = historyIndex++;
    if (omitted > 0 && index >= head && index < tailStart) {
      if (!reported) {
        lines.push(`${g.ellipsis} ${omitted} entries omitted ${g.midDot} use /save before exiting`);
        reported = true;
      }
      continue;
    }
    lines.push(...renderEntry(entry, g));
  }

  return `${lines.join('\n')}\n`;
}
