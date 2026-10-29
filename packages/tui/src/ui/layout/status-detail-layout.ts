import { formatCost, formatTokens, promptTokensOf } from '../../model/agent/usage.js';
import { actionCandidates, clipStatusText, escapeClause, type ActionHintInput } from '../interaction-hints.js';
import { isGovernedModeValue, modeWord } from '../governance-status.js';
import { statusField, statusLinePlan, validContext, type StatusField, type StatusLinePlan, type StatusPrimaryInput } from './status-layout.js';

/**
 * Uppercase mode word for the details row, mirroring the primary row's field:
 * same vocabulary (`MODE_LABEL`), same `CUR>PENDING` deferred-switch shape.
 */
function detailModeText(
  mode: string | undefined,
  pendingMode: string | null | undefined,
): string {
  const word = (value: string): string => modeWord(value, true) ?? value.toUpperCase();
  if (pendingMode) return `${word(mode || 'build')}>${word(pendingMode)}`;
  return word(mode || 'build');
}

export interface StatusDetailInput {
  status: StatusPrimaryInput; hints: ActionHintInput; model: string; provider: string;
}
export function planStatusDetail(input: StatusDetailInput): StatusLinePlan {
  const { status, hints } = input;
  const budget = Math.max(0, Math.floor(status.columns) - 1);
  const escape = escapeClause({ ...hints, escapeAction: status.escapeAction });
  const reserved = [...(escape ? [statusField('escape', escape, 'warning')] : []),
    // THE TOGGLE HINT NAMES A TWO-KEY PATH NOW (tui-shortcut-drawer-and-task-summary
    // D-6). This row said `^G less` because `Ctrl+G` collapsed it directly; the key
    // opens the drawer instead, and `d` inside the drawer is what collapses this row.
    // Saying `^G less` would be a hint that does nothing.
    statusField('toggle', hints.overlay ? 'Details on' : '^G then d')];
  const fields: StatusField[] = [];
  const add = (candidate: StatusField): void => {
    if (statusLinePlan([...fields, candidate, ...reserved]).cells <= budget) fields.push(candidate);
  };
  if (status.feedback) {
    const remaining = budget - statusLinePlan(reserved).cells - (reserved.length ? 3 : 0);
    const text = clipStatusText(status.feedback.text, Math.max(0, remaining));
    if (text) add(statusField('feedback', text, status.feedback.level === 'error' ? 'error'
      : status.feedback.level === 'warn' ? 'warning' : 'normal'));
  }
  for (const [index, action] of actionCandidates(hints).entries()) add(statusField('action-' + index, action));
  if (status.pendingCount > 0) add(statusField('queue', 'Q' + status.pendingCount));
  if (status.servicesActive?.live) add(statusField('services', 'Svc' + status.servicesActive.live));
  if (status.mode || status.pendingMode) add(statusField('mode', detailModeText(
    status.mode, status.pendingMode),
  isGovernedModeValue(status.mode) || isGovernedModeValue(status.pendingMode) ? 'govern' : 'accent'));
  if (validContext(status.context)) {
    const approximate = status.context.source === 'estimate' || status.context.deltaTokens > 0 ? '~' : '';
    add(statusField('context', 'Context ' + approximate + formatTokens(status.context.occupied)
      + '/' + formatTokens(status.context.window) + ' tokens'));
  } else add(statusField('context', 'Context ? /context'));
  if (status.speedKnown) add(statusField('average', 'Avg: main output / run time'));
  add(statusField('usage', 'Session input ' + formatTokens(promptTokensOf(status.usageTotal))
    + ' output ' + formatTokens(status.usageTotal.outputTokens)));
  if (Number.isFinite(status.usageTotal.costUsd)) add(statusField('cost', 'Cost ' + formatCost(status.usageTotal.costUsd) + ' est'));
  if (status.teamActive) add(statusField('team', 'Team ' + status.teamActive.running + '/' + status.teamActive.total));
  if (status.todoActive) add(statusField('todo', 'Todo ' + status.todoActive.done + '/' + status.todoActive.total));
  // AFTER `todo`, AND THE ORDER IS THE PRIORITY (D-12): `add()` only appends while
  // the whole row still fits, so a later field is dropped FIRST. `Todo 3/7` is the
  // more important of the two numbers, so it goes first and survives the narrower
  // terminal; `Accept 2/5` degrades before it.
  if (status.acceptanceActive) {
    const acceptance = status.acceptanceActive;
    add(statusField(
      'acceptance',
      'Accept ' + acceptance.checked + '/' + acceptance.total
        + (acceptance.failed > 0 ? ' !' + acceptance.failed : ''),
      acceptance.failed > 0 ? 'error' : 'normal',
    ));
  }
  add(statusField('model', input.provider + ':' + input.model));
  if (status.fastActive) add(statusField('fast', 'Fast' + (status.fastActive.inFlight ? ' active' : '')));
  if (status.ecoRung) add(statusField('eco', 'Eco'));
  if (hints.updateAvailable) add(statusField('update', '/update'));
  return statusLinePlan([...fields, ...reserved]);
}
