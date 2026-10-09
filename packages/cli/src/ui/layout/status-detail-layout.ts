import { formatCost, formatTokens, promptTokensOf } from '../../agent/usage.js';
import { actionCandidates, clipStatusText, escapeClause, type ActionHintInput } from '../interaction-hints.js';
import { statusField, statusLinePlan, validContext, type StatusField, type StatusLinePlan, type StatusPrimaryInput } from './status-layout.js';

export interface StatusDetailInput {
  status: StatusPrimaryInput; hints: ActionHintInput; model: string; provider: string;
}
export function planStatusDetail(input: StatusDetailInput): StatusLinePlan {
  const { status, hints } = input;
  const budget = Math.max(0, Math.floor(status.columns) - 1);
  const escape = escapeClause({ ...hints, escapeAction: status.escapeAction });
  const reserved = [...(escape ? [statusField('escape', escape, 'warning')] : []),
    statusField('toggle', hints.overlay ? 'Details on' : '^G less')];
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
  if (status.mode || status.pendingMode) add(statusField('mode', status.pendingMode
    ? (status.mode ?? 'build') + '>' + status.pendingMode : status.mode!));
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
  add(statusField('model', input.provider + ':' + input.model));
  if (status.fastActive) add(statusField('fast', 'Fast' + (status.fastActive.inFlight ? ' active' : '')));
  if (status.ecoRung) add(statusField('eco', 'Eco'));
  if (hints.updateAvailable) add(statusField('update', '/update'));
  return statusLinePlan([...fields, ...reserved]);
}
