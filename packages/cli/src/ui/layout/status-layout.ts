import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';
import type { UsageTotal } from '../../agent/reducer.js';
import type { ContextUsageSnapshot } from '../../compaction/types.js';
import { formatCost, formatDuration, formatTokens, promptTokensOf } from '../../agent/usage.js';
import { interactionCopy as copy } from '../interaction-copy.js';

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
export interface StatusField {
  id: string; text: string; cells: number; tone: 'normal' | 'muted' | 'warning' | 'error';
}

export function cleanStatusText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return stripAnsi(text).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ' ').trim();
}

export function phaseLabels(input: Pick<StatusLayoutInput, 'phase' | 'activeTool' | 'runOutcome' |
  'waitingForConfirmation' | 'stopping' | 'compacting' | 'retryActive'>): readonly [string, string] {
  if (input.waitingForConfirmation) return copy.confirming;
  if (input.stopping) return copy.stopping;
  if (input.compacting) return copy.compacting;
  if (input.retryActive) return [copy.retrying[0], `${copy.retrying[1]} ${Math.max(0, Math.ceil(input.retryActive.secondsLeft))}s`];
  if (input.activeTool) {
    const name = input.activeTool.name;
    if (name === 'read_file') return copy.readFile;
    if (name === 'write_file' || name === 'edit_file') return copy.writeFile;
    if (name === 'bash') return copy.command;
    return [copy.tool[0], `${copy.tool[1]} ${cleanStatusText(name)}`];
  }
  if (input.phase === 'idle' && input.runOutcome && input.runOutcome !== 'none') return copy[input.runOutcome];
  if (input.phase === 'preparing-tool') return copy.preparingTool;
  return copy[input.phase];
}

const field = (id: string, text: string, tone: StatusField['tone'] = 'muted'): StatusField =>
  ({ id, text, cells: stringWidth(text), tone });
const width = (fields: readonly StatusField[]): number =>
  fields.reduce((sum, item) => sum + item.cells, 0) + Math.max(0, fields.length - 1) * 3;
const scientific = (value: number): string => value.toExponential(1).replace(/\.0e/, 'e').replace('e+', 'e');
const compactNumber = (value: number): string => value >= 1e9 ? scientific(value) : formatTokens(value).replace(/\.0([kM])$/, '$1');

function contextText(context: ContextUsageSnapshot, detail = false, exponent = false): string {
  if (![context.occupied, context.window, context.deltaTokens, context.pct].every(Number.isFinite)
    || context.occupied < 0 || context.window <= 0) return copy.contextUnknown;
  const number = exponent ? scientific : detail ? formatTokens : compactNumber;
  const approximate = context.source === 'estimate' || context.deltaTokens > 0 ? '~' : '';
  return `${copy.context} ${approximate}${number(context.occupied)}/${number(context.window)}${context.windowKnown ? '' : '?'} ${detail ? 'tokens' : 'tok'}`;
}

function secondaryFields(input: StatusLayoutInput): StatusField[] {
  const list: StatusField[] = [];
  if ((input.mode && input.mode !== 'build') || input.pendingMode) list.push(field('mode',
    input.pendingMode ? `${input.mode ?? 'build'}>${input.pendingMode}` : input.mode!, 'normal'));
  if (input.servicesActive?.live) list.push(field('services', `${copy.services} ${input.servicesActive.live}`, 'warning'));
  if (Number.isFinite(input.usageTotal.costUsd)) list.push(field('cost', `${copy.estimatedCost} ${formatCost(input.usageTotal.costUsd).slice(1)}`));
  if (input.phase !== 'idle') {
    if (input.tokPerSec > 0 && Number.isFinite(input.tokPerSec)) list.push(field('speed', `${copy.speed} ${input.tokPerSec} tok/s`));
    if (Number.isFinite(input.elapsedMs)) list.push(field('elapsed', `${copy.elapsed} ${formatDuration(input.elapsedMs)}`));
  }
  if (input.thinkingLevel !== 'off') list.push(field('thinking', `think:${cleanStatusText(input.thinkingLevel)}`));
  list.push(field('usage', `${copy.sessionInput} ${compactNumber(promptTokensOf(input.usageTotal))} ${copy.output} ${compactNumber(input.usageTotal.outputTokens)} tok`));
  if (Number.isFinite(input.context.pct)) list.push(field('percentage',
    `${input.context.source === 'estimate' || input.context.deltaTokens > 0 || !input.context.windowKnown ? '~' : ''}${Math.round(input.context.pct)}%`));
  if (input.ecoRung) list.push(field('eco', 'eco'));
  if (input.fastActive) list.push(field('fast', `fast${input.fastActive.inFlight ? '*' : ''}`));
  if (input.teamActive) list.push(field('team', `agents ${input.teamActive.running}/${input.teamActive.total}`));
  if (input.todoActive) list.push(field('todo', `todo ${input.todoActive.done}/${input.todoActive.total}`));
  if (input.scrolledLines) list.push(field('scroll', `^${input.scrolledLines}`, 'warning'));
  return list;
}

/** Allocate complete fields before rendering; only the redraw carrier lives outside this budget. */
export function planStatusFields(input: StatusLayoutInput): readonly StatusField[] {
  const budget = Math.max(0, Math.floor(input.columns) - 1);
  const [short, long] = phaseLabels(input);
  const prefix = input.spinner ? `${input.spinner} ` : '';
  const phaseTone = input.runOutcome === 'failed' ? 'error' : 'normal';
  const fields = [field('phase', prefix + short, phaseTone)];
  if (input.pendingCount > 0) fields.push(field('queue', `${copy.queue} ${input.pendingCount}`, 'warning'));
  fields.push(field('context', contextText(input.context)));
  const contextIndex = fields.length - 1;
  if (width(fields) > budget) fields[contextIndex] = field('context', contextText(input.context, false, true));
  if (width(fields) > budget) fields[contextIndex] = field('context', '/context');
  if (width(fields) > budget && input.pendingCount > 0) fields[1] = field('queue', '/queue', 'warning');
  if (width(fields) > budget) return fields.filter((_f, index) => width(fields.slice(0, index + 1)) <= budget);
  for (const candidate of secondaryFields(input)) {
    if (width([...fields, candidate]) <= budget) fields.push(candidate);
  }
  const upgrades = [field('phase', prefix + long, phaseTone),
    field('queue', `${copy.pending} ${input.pendingCount}`, 'warning'),
    field('context', contextText(input.context, true))];
  for (const upgrade of upgrades) {
    const index = fields.findIndex((f) => f.id === upgrade.id);
    if (index >= 0 && width(fields) - fields[index]!.cells + upgrade.cells <= budget) fields[index] = upgrade;
  }
  return fields;
}
