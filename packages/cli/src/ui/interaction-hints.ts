import stringWidth from 'string-width';
import { interactionCopy as copy } from './interaction-copy.js';
import { cleanStatusText } from './layout/status-layout.js';
import { graphemes } from './editor-navigation.js';
import type { StatusFeedback, EscapeAction } from './status-feedback.js';

export interface ActionHintInput {
  cols: number; interactionPhase: 'idle' | 'starting' | 'running';
  interruptHint?: string; interruptPhase?: 'ready' | 'armed' | 'stopping';
  escapeAction?: EscapeAction; feedback?: StatusFeedback;
  selectionPending?: boolean; copyInFlight?: boolean; copyCleanupPending?: boolean;
  completion?: 'none' | 'slash' | 'file'; services?: number; overlay?: string | null;
  hintsEnabled?: boolean; toast?: string; updateAvailable?: boolean; exitHint?: string; modeToggleKey?: string;
  /** Draft present: the exit clause becomes the clear-then-exit ladder. */
  hasDraft?: boolean;
}
export function escapeClause(input: ActionHintInput): string {
  if (input.overlay) return copy.close;
  if (input.completion && input.completion !== 'none' || input.escapeAction === 'menu') return copy.closeCompletion;
  if (input.escapeAction === 'force-stop' || input.interruptPhase === 'stopping') return copy.forceStop;
  if (input.interactionPhase === 'starting') return input.interruptPhase === 'armed' ? copy.cancelStartAgain : copy.cancelStart;
  if (input.interactionPhase !== 'running') return '';
  return input.interruptPhase === 'armed' ? copy.interruptAgain : copy.interrupt;
}
export function clipStatusText(text: string, cells: number): string {
  let clipped = '';
  for (const part of graphemes(cleanStatusText(text))) {
    if (stringWidth(clipped + part.text) > cells) break;
    clipped += part.text;
  }
  return clipped;
}
/** Ordered actions before width allocation. No interpretation of translated feedback text. */
export function actionCandidates(input: ActionHintInput): string[] {
  if (input.overlay) {
    if (input.overlay === 'confirm') return [copy.approveTool, copy.rejectTool];
    const selects = ['question', 'model', 'session', 'settings'].includes(input.overlay);
    return [selects ? copy.select : copy.scroll,
      ...(selects ? [input.overlay === 'settings' ? copy.saveSettings : copy.confirm] : [])];
  }
  const actions: string[] = [];
  if (input.selectionPending) actions.push(copy.copy);
  else if (input.services) actions.push(copy.stopServicesShort);
  if (input.completion && input.completion !== 'none') {
    actions.push(...(input.completion === 'slash' ? [copy.executeCommand] : []), copy.complete, copy.select);
    return actions;
  }
  if (input.hintsEnabled !== false && input.interactionPhase !== 'starting') actions.push(
    input.interactionPhase === 'running' ? copy.enqueue : copy.send,
    input.cols < 72 ? copy.newline : copy.newlineLong);
  return actions;
}
export function buildActionClauses(input: ActionHintInput): readonly string[] {
  const budget = Math.max(0, Math.floor(input.cols) - 1);
  const escape = escapeClause(input);
  const result: string[] = [];
  const feedback = input.feedback?.text || input.exitHint || (input.copyCleanupPending ? copy.copyCleanup
    : input.copyInFlight ? copy.copying : input.toast) || '';
  const reserve = escape ? stringWidth(escape) + 3 : 0;
  if (feedback) {
    const text = clipStatusText(feedback, Math.max(0, budget - reserve));
    if (text) result.push(text);
  }
  const add = (text: string, remaining = budget): void => {
    if (stringWidth([...result, text].join(' | ')) <= remaining) result.push(cleanStatusText(text));
  };
  if (!feedback) {
    for (const action of actionCandidates(input)) add(action, budget - reserve);
  }
  if (escape) add(escape);
  if (!feedback && input.hintsEnabled !== false && !input.overlay) {
    if (input.updateAvailable) add(copy.update);
    add(input.hasDraft ? copy.exitDraft : copy.exit);
    add((input.modeToggleKey ?? 'Shift+Tab') + ' ' + copy.modeLabel);
    add(copy.help);
  }
  return result;
}
