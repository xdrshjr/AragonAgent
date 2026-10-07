import stringWidth from 'string-width';
import { interactionCopy as copy } from './interaction-copy.js';
import { cleanStatusText } from './layout/status-layout.js';

export interface ActionHintInput {
  cols: number; interactionPhase: 'idle' | 'starting' | 'running';
  interruptHint?: string; selectionPending?: boolean; copyInFlight?: boolean;
  copyCleanupPending?: boolean; completion?: 'none' | 'slash' | 'file';
  services?: number; overlay?: string | null; hintsEnabled?: boolean;
  toast?: string; updateAvailable?: boolean; exitHint?: string;
  modeToggleKey?: string;
}

function escapeClause(input: ActionHintInput): string {
  if (input.overlay) return copy.close;
  if (input.completion && input.completion !== 'none') return copy.closeCompletion;
  if (input.interactionPhase === 'starting') return /again|confirm/i.test(input.interruptHint ?? '')
    ? copy.cancelStartAgain : copy.cancelStart;
  if (input.interactionPhase !== 'running') return '';
  if (/force|\u5f3a\u5236/i.test(input.interruptHint ?? '')) return copy.forceStop;
  if (/again|confirm|\u518d\u6309/i.test(input.interruptHint ?? '')) return copy.interruptAgain;
  return copy.interrupt;
}

function contextClauses(input: ActionHintInput, escape: string): string[] {
  if (input.overlay) {
    if (input.overlay === 'confirm') return [escape, copy.approveTool, copy.rejectTool];
    const selects = /question|model|session|settings/.test(input.overlay);
    return [escape, selects ? copy.select : copy.scroll,
      ...(selects ? [input.overlay === 'settings' ? copy.saveSettings : copy.confirm] : [])];
  }
  if (input.completion && input.completion !== 'none') {
    const candidates: string[] = input.completion === 'slash'
      ? [copy.executeCommand, escape, copy.complete, copy.select, copy.newline]
      : [copy.complete, escape, copy.select, copy.newline];
    if (input.completion === 'file' && input.interactionPhase !== 'starting') candidates.push(
      input.interactionPhase === 'running' ? copy.enqueue : copy.send);
    return candidates;
  }
  if (input.interactionPhase === 'starting') return [copy.startingHint, escape];
  const running = input.interactionPhase === 'running';
  const narrow = input.cols < 72;
  return [running ? (narrow ? copy.enqueue : copy.enqueueLong) : (narrow ? copy.send : copy.sendLong),
    narrow ? copy.newline : copy.newlineLong, ...(escape ? [escape] : [])];
}

function fitClauses(candidates: readonly string[], budget: number): string[] {
  const result: string[] = [];
  for (const text of candidates.filter(Boolean)) {
    if (stringWidth([...result, text].join(' | ')) <= budget) result.push(text);
  }
  return result;
}

/** Esc describes its actual owner, including while transient feedback has the row. */
export function buildActionClauses(input: ActionHintInput): readonly string[] {
  const budget = Math.max(0, Math.floor(input.cols) - 1);
  const escape = escapeClause(input);
  const copyFeedback = input.copyCleanupPending
    ? (input.toast?.includes(copy.copyFailed) ? input.toast : copy.copyCleanup)
    : input.copyInFlight ? copy.copying : '';
  const feedback = input.exitHint || copyFeedback || input.toast || '';
  if (feedback) {
    const reserved = escape ? [escape] : [];
    const remaining = budget - stringWidth(reserved.join(' | ')) - (reserved.length ? 3 : 0);
    let text = cleanStatusText(feedback);
    if (stringWidth(text) > remaining) {
      const minimum = text.includes(copy.copyFailed) ? copy.copyFailed : '';
      let clipped = '';
      for (const char of text) {
        if (stringWidth(clipped + char) > remaining) break;
        clipped += char;
      }
      text = minimum && stringWidth(minimum) <= remaining ? minimum : clipped;
    }
    return fitClauses([text, ...reserved], budget);
  }
  const clauses = contextClauses(input, escape);
  if (input.selectionPending) clauses.unshift(copy.copy);
  if (input.services && !input.selectionPending) clauses.unshift(input.cols < 72
    ? `${copy.stopServicesShort} ${input.services}` : `${copy.services} ${input.services} ${copy.stopServices}`);
  if (input.updateAvailable && input.interactionPhase === 'idle' && !input.overlay) clauses.unshift(copy.update);
  if (!input.selectionPending && !input.services) clauses.push(copy.exit);
  if (input.hintsEnabled !== false && !input.overlay) clauses.push(copy.shiftNewline,
    `${(input.modeToggleKey ?? 'shift+tab').split('+').map((key) =>
      key.length === 1 ? key.toUpperCase() : key[0]!.toUpperCase() + key.slice(1).toLowerCase()).join('+')} ${copy.modeLabel}`,
    copy.help, '/ commands', '@ files');
  // Reserve Esc before lower-priority clauses, but preserve the documented display order.
  if (!escape) return fitClauses(clauses, budget);
  const selected = fitClauses(clauses.filter((clause) => clause !== escape),
    budget - stringWidth(escape) - 3);
  return clauses.filter((clause) => clause === escape || selected.includes(clause));
}
