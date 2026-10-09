import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';
import type { UsageTotal } from '../../agent/reducer.js';
import type { ContextUsageSnapshot } from '../../compaction/types.js';
import { formatDuration } from '../../agent/usage.js';
import { interactionCopy as copy } from '../interaction-copy.js';
import type { EscapeAction, StatusFeedback } from '../status-feedback.js';

export type RunPhase = 'idle' | 'starting' | 'waiting' | 'thinking' | 'generating' | 'preparing-tool' | 'tool';
export interface StatusLayoutInput {
  columns: number; phase: RunPhase; pendingCount: number;
  context: ContextUsageSnapshot; usageTotal: UsageTotal;
  thinkingLevel: string; elapsedMs: number; tokPerSec: number;
  activeTool?: { name: string; toolCallId: string } | null;
  runOutcome?: 'none' | 'ended' | 'interrupted' | 'failed';
  spinner?: string; waitingForConfirmation?: boolean; stopping?: boolean;
  compacting?: boolean; retryActive?: { attempt: number; max: number; secondsLeft: number };
  mode?: string; pendingMode?: string | null; servicesActive?: { live: number };
  teamActive?: { running: number; total: number }; todoActive?: { done: number; total: number };
  ecoRung?: number; fastActive?: { inFlight: boolean }; scrolledLines?: number;
}
export interface StatusPrimaryInput extends StatusLayoutInput {
  feedback?: StatusFeedback; escapeAction?: EscapeAction; speedKnown: boolean;
  interruptPhase?: 'ready' | 'armed' | 'stopping';
}
export interface StatusField {
  id: string; text: string; cells: number; tone: 'normal' | 'muted' | 'warning' | 'error';
}
export interface StatusLinePlan {
  fields: readonly StatusField[]; separator: string; separatorCells: number; cells: number;
}
export function cleanStatusText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return stripAnsi(text).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ' ').trim();
}
export function statusField(id: string, text: string, tone: StatusField['tone'] = 'muted'): StatusField {
  const clean = cleanStatusText(text);
  return { id, text: clean, cells: stringWidth(clean), tone };
}
export function statusLinePlan(fields: readonly StatusField[], separator = ' | '): StatusLinePlan {
  const separatorCells = stringWidth(separator);
  return { fields, separator, separatorCells,
    cells: fields.reduce((sum, item) => sum + item.cells, 0) + Math.max(0, fields.length - 1) * separatorCells };
}
export function phaseLabels(input: Pick<StatusLayoutInput, 'phase' | 'activeTool' | 'runOutcome' |
  'waitingForConfirmation' | 'stopping' | 'compacting' | 'retryActive'>): readonly [string, string] {
  if (input.waitingForConfirmation) return copy.confirming;
  if (input.stopping) return copy.stopping;
  if (input.compacting) return copy.compacting;
  if (input.retryActive) return copy.retrying;
  if (input.activeTool) return [copy.tool[0], copy.tool[1] + ' ' + cleanStatusText(input.activeTool.name)];
  if (input.phase === 'idle' && input.runOutcome && input.runOutcome !== 'none') return copy[input.runOutcome];
  if (input.phase === 'preparing-tool') return copy.preparingTool;
  return copy[input.phase];
}
export function validContext(context: ContextUsageSnapshot): boolean {
  return context.windowKnown && context.window > 0 &&
    [context.occupied, context.window, context.pct, context.deltaTokens].every(n => Number.isFinite(n) && n >= 0);
}
function contextPercent(context: ContextUsageSnapshot): string {
  if (!validContext(context)) return '?';
  const mark = context.source === 'estimate' || context.deltaTokens > 0 ? '~' : '';
  return mark + (context.pct > 999 ? '>999' : Math.round(context.pct)) + '%';
}
export function shortDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return seconds + 's';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm' + String(seconds % 60).padStart(2, '0') + 's';
  if (seconds < 86400) return Math.floor(seconds / 3600) + 'h' + String(Math.floor(seconds / 60) % 60).padStart(2, '0') + 'm';
  const days = Math.floor(seconds / 86400);
  return days > 999 ? '>999d' : days + 'd';
}
function speedNumber(input: StatusPrimaryInput): string {
  if (!input.speedKnown || input.phase === 'idle' || input.elapsedMs <= 500
    || !Number.isFinite(input.tokPerSec) || input.tokPerSec < 0) return '--';
  const value = input.tokPerSec;
  if (value > 99e6) return '>99M';
  if (value >= 999950) return (value / 1e6).toFixed(1) + 'M';
  if (value > 999) return (value / 1000).toFixed(1) + 'k';
  return String(Math.round(value));
}
function feedbackLabel(input: StatusPrimaryInput, form: 'full' | 'short' | 'tiny'): string | undefined {
  const feedback = input.feedback;
  if (!feedback) return undefined;
  const error = feedback.kind === 'copy-error' || feedback.kind === 'copy-cleanup';
  if (error && input.escapeAction === 'force-stop') {
    return form === 'full' ? 'Copy err / Esc force' : form === 'tiny' ? 'E/F' : 'Err/EscF';
  }
  if (error && input.escapeAction === 'confirm-stop' && input.interruptPhase === 'armed') {
    return form === 'full' ? 'Copy err / Esc stop' : form === 'tiny' ? 'E/S' : 'Err/EscS';
  }
  const labels: Record<StatusFeedback['kind'], readonly [string, string, string]> = {
    confirm: ['Awaiting confirmation', 'Ask', 'Ask'], stopping: ['Esc stop', 'EscS', 'EscS'],
    'force-stop': ['Esc force', 'EscF', 'EscF'], exit: ['^C exit', '^Cexit', '^C'],
    copying: ['Copying', 'Copy', 'Copy'], copied: ['Copied', 'Copied', 'Copy'],
    'copy-sent': ['Copy sent', 'Sent', 'Sent'], 'copy-cleanup': ['Copy cleanup', 'Err', 'Err'],
    'copy-error': ['Copy err', 'Err', 'Err'], notice: ['Notice', 'Notice', 'Note'],
  };
  return labels[feedback.kind][form === 'full' ? 0 : form === 'short' ? 1 : 2];
}
const thinkingCodes: Record<string, string> = { off: 'O', minimal: 'N', low: 'L', medium: 'M', high: 'H', xhigh: 'X' };

/** All five fields survive each width rung; only the redraw carrier is outside this plan. */
export function planPrimaryStatusFields(input: StatusPrimaryInput): StatusLinePlan {
  const budget = Math.max(0, (Number.isFinite(input.columns) ? Math.floor(input.columns) : 80) - 1);
  const labels = phaseLabels(input);
  const glyphText = cleanStatusText(input.spinner ?? '-');
  const glyph = stringWidth(glyphText) === 1 ? glyphText : '-';
  const code = thinkingCodes[input.thinkingLevel] ?? '?';
  const pct = contextPercent(input.context);
  const speed = speedNumber(input);
  const tone: StatusField['tone'] = input.feedback?.level === 'error' || input.runOutcome === 'failed'
    ? 'error' : input.feedback?.level === 'warn' || input.waitingForConfirmation || input.stopping ? 'warning' : 'normal';
  const build = (rung: number): StatusLinePlan => {
    const full = rung === 0;
    const label = feedbackLabel(input, full ? 'full' : rung >= 4 ? 'tiny' : 'short')
      ?? (full ? labels[1] : rung >= 4 ? labels[0].slice(0, 4) : labels[0]);
    return statusLinePlan([
      statusField('phase', glyph + (rung >= 5 ? '' : ' ') + label, tone),
      statusField('context', (full ? 'Context ' : 'C') + pct),
      statusField('thinking', full ? 'Think ' + (thinkingCodes[input.thinkingLevel] ? input.thinkingLevel : '?')
        : (rung >= 2 ? '' : 'Th:') + code),
      statusField('speed', speed + (full ? ' tok/s' : rung >= 3 ? '/s' : 't/s')),
      statusField('elapsed', full && Number.isFinite(input.elapsedMs) && input.elapsedMs > 0
        ? formatDuration(input.elapsedMs) : shortDuration(input.elapsedMs)),
    ], full ? ' | ' : ' ');
  };
  let plan = build(0);
  for (let rung = 1; plan.cells > budget && rung <= 5; rung++) plan = build(rung);
  return plan;
}
