/**
 * Plain-text fallback rows for the native-scroll live region
 * (tui-native-terminal-scroll §4.6, tui-full-height-live-region RV-P2-7).
 *
 * THE REAL TAIL IS `LiveTail`, NOT THIS. Native mode draws the region's tail with the
 * actual entry components, so these rows are only the fallback for a frame that mounts
 * no component there (and the floor of the measurement path). They are kept rather than
 * deleted because the render tests use them to assert exactly that frame, and because
 * `<= 24 wrapToRows` calls per frame is far below the cost of the components it stands
 * in for.
 *
 * The input is the TAIL WINDOW (`selectTailWindow`), settled entries included: at
 * `H = rows - 1` the region shows the last K entries of the conversation, so a
 * projection built only from the unfinished ones would disagree with the screen.
 * The field keeps its historical name `unsettled` because it is still "the entries the
 * region is showing", and renaming it would touch the preview tests for no behaviour.
 *
 * PURE: no Ink, no theme, no I/O. Every returned row fits `cols` display columns.
 */

import type { Entry } from '../../model/agent/reducer.js';
import { clampLiveText } from '../live-clamp.js';
import { wrapToRows } from '../layout/wrap-rows.js';
import { isExcluded } from './settled-boundary.js';
import { isLiveTeamCard, outcomePhrase, rosterCounts } from '../team-status.js';
import { clipLine } from './writer-shapes.js';
import { formatWaitClock } from '../layout/wait-bar.js';
import { toolTitle, type VoiceMode } from '../tool-voice.js';

export interface LivePreviewInput {
  /**
   * The entries to project, oldest first - the tail window in native mode. May include
   * excluded entries; they are skipped.
   */
  unsettled: readonly Entry[];
  /** Content width (`cols - 1`). */
  cols: number;
  /** Rows granted by the budget. */
  rows: number;
  thinkingVisible: boolean;
  /** Tool-name wording; absent = developer (identifiers as-is). */
  voiceMode?: VoiceMode;
}

const MAX_TEAM_RUN_ROWS = 3;
const TOOL_LIVE_ROWS = 6;

function firstLine(text: string): string {
  const line = text.split('\n').find((candidate) => candidate.trim().length > 0);
  return (line ?? '').trim();
}

function fit(text: string, cols: number): string {
  return clipLine(text, Math.max(1, cols)).text;
}

function assistantRows(
  entry: Extract<Entry, { kind: 'assistant' }>,
  cols: number,
  rows: number,
  thinkingVisible: boolean,
): string[] {
  const out: string[] = [];
  const thinking = (entry.thinking ?? '').trim();
  if (entry.text.trim().length === 0) {
    if (thinking.length > 0 && thinkingVisible) {
      const last = thinking.split('\n').filter((line) => line.trim().length > 0).pop() ?? '';
      out.push(fit(`thinking: ${last.trim()}`, cols));
    } else if (entry.streaming) {
      out.push('thinking...');
    }
    return out;
  }
  const clamped = clampLiveText(entry.text, rows * 2);
  out.push(...wrapToRows(clamped.text, cols).map((row) => fit(row, cols)));
  return out;
}

function toolRows(
  entry: Extract<Entry, { kind: 'tool' }>,
  cols: number,
  voiceMode: VoiceMode,
): string[] {
  // A RUNNING WAIT IS ONE LINE HERE, not a miniature of the five-row card
  // (extended-job-wait RV-3). `job_wait` never streams, so `live` is empty and the
  // generic row would say only `> job_wait`; the clock comes from the view's own
  // epoch stamps (`beatAt` is the view's last beat), keeping this function pure.
  if (entry.name === 'job_wait' && entry.status === 'running' && entry.wait) {
    const { wait } = entry;
    const waited = Math.max(0, wait.beatAt - wait.waitStartedAt);
    return [
      fit(
        `> Waiting for ${wait.jobLabel}  ${formatWaitClock(waited)} of ${formatWaitClock(wait.upToMs)}`,
        cols,
      ),
    ];
  }
  // The reducer defaults `label` to the tool's own id, so a label equal to the name is NOT
  // a display label: it is the raw identifier and takes the voice like any other.
  const hasDisplayLabel = entry.label && entry.label.length > 0 && entry.label !== entry.name;
  const head = hasDisplayLabel ? entry.label : toolTitle(entry.name, voiceMode);
  const out = [fit(`${entry.status === 'running' ? '>' : '.'} ${head}`, cols)];
  const live = (entry.live ?? []).slice(-TOOL_LIVE_ROWS);
  for (const row of live) out.push(fit(`  ${row}`, cols));
  return out;
}

function teamRows(entry: Extract<Entry, { kind: 'team' }>, cols: number): string[] {
  // ONLY A SETTLED CARD REACHES HERE (the live one projects nothing, below), so the
  // outcome phrase - `team-status.ts`'s own sentence - replaces an always-zero fraction.
  const counts = rosterCounts(entry.runs);
  const out = [fit(`Team: ${outcomePhrase(counts)}`, cols)];
  for (const run of entry.runs.slice(0, MAX_TEAM_RUN_ROWS)) {
    out.push(fit(`  ${run.label} ${run.phase}`, cols));
  }
  return out;
}

function entryRows(entry: Entry, input: LivePreviewInput): string[] {
  const { cols, rows, thinkingVisible } = input;
  switch (entry.kind) {
    case 'assistant':
      return assistantRows(entry, cols, rows, thinkingVisible);
    case 'tool':
      return toolRows(entry, cols, input.voiceMode ?? 'developer');
    case 'team':
      // THE LIVE DISPATCH HAS ONE SURFACE (tui-subagent-double-roster A-2): this
      // projection is the text fallback for the same slot `LiveTail` fills, so a
      // `Team: n/m running` line here would be the second live block again, one level
      // down. A settled card still projects normally.
      return isLiveTeamCard(entry) ? [] : teamRows(entry, cols);
    case 'todo':
      return [fit(`Todo: ${entry.doneCount}/${entry.total}`, cols)];
    case 'compaction':
      return [fit(`Compacting context...`, cols)];
    case 'retry':
      return [fit(`Retrying (${entry.attempt}/${entry.maxRetries})...`, cols)];
    case 'fast':
      return [fit(`Fast review ${entry.reviewIndex}...`, cols)];
    case 'queued':
      return [fit(`Queued: ${firstLine(entry.text)}`, cols)];
    case 'user':
      return [fit(`> ${firstLine(entry.text)}`, cols)];
    case 'notice':
      return [fit(firstLine(entry.text), cols)];
    case 'service':
      return [];
    case 'governance':
      return [fit(`Governance: ${entry.card.title}`, cols)];
    default: {
      const exhaustive: never = entry;
      return exhaustive;
    }
  }
}

/** The last `rows` preview rows, oldest first. `[]` when `rows <= 0`. */
export function buildLivePreview(input: LivePreviewInput): string[] {
  const rows = Math.floor(input.rows);
  if (rows <= 0) return [];
  const all: string[] = [];
  for (const entry of input.unsettled) {
    if (isExcluded(entry)) continue;
    all.push(...entryRows(entry, input));
  }
  return all.slice(-rows);
}
