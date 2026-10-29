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
  /**
   * The session is in a governed posture (governance-mode 10.6): the idle row teaches
   * what the first message does, and the running row says an interrupt is resumable.
   * ABSENT = every clause below is byte-identical to the pre-governance build.
   */
  governed?: boolean;
  /**
   * A `/gov pause` is waiting for the running stage to finish (governance-mode-v1-1 6.4):
   * the row says so and how to undo it. Absent keeps every clause byte-identical.
   */
  govPausePending?: boolean;
  /**
   * The word after the toggle key, from `postureHintWord(nextPosture(...))`. Absent keeps
   * the classic `switch mode`; only the wiring that knows the live posture cycle can say
   * which posture is next, so this layer never guesses.
   */
  nextPostureWord?: string;
}
export function escapeClause(input: ActionHintInput): string {
  if (input.overlay) return copy.close;
  if (input.completion && input.completion !== 'none' || input.escapeAction === 'menu') return copy.closeCompletion;
  if (input.escapeAction === 'force-stop' || input.interruptPhase === 'stopping') return copy.forceStop;
  if (input.interactionPhase === 'starting') return input.interruptPhase === 'armed' ? copy.cancelStartAgain : copy.cancelStart;
  if (input.interactionPhase !== 'running') return '';
  if (input.governed) {
    return input.interruptPhase === 'armed' ? copy.governInterruptAgain : copy.governInterrupt;
  }
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
    // THE DRAWER SELECTS, IT DOES NOT SCROLL (tui-shortcut-drawer-and-task-summary
    // §5). It is a list with a cursor, so the generic `copy.scroll` fallback would
    // describe the wrong interaction - and the drawer's own footer already names
    // every key, so one clause is the whole line.
    if (input.overlay === 'shortcuts') return [copy.select];
    const selects = ['question', 'model', 'session', 'settings'].includes(input.overlay);
    return [selects ? copy.select : copy.scroll,
      ...(selects ? [input.overlay === 'settings' ? copy.saveSettings : copy.confirm] : [])];
  }
  const actions: string[] = [];
  if (input.governed && input.govPausePending && input.interactionPhase === 'running') {
    actions.push(copy.governPausePending);
  }
  if (input.selectionPending) actions.push(copy.copy);
  else if (input.services) actions.push(copy.stopServicesShort);
  if (input.completion && input.completion !== 'none') {
    actions.push(...(input.completion === 'slash' ? [copy.executeCommand] : []), copy.complete, copy.select);
    return actions;
  }
  // THE GOVERNED IDLE SENTENCE REPLACES `Enter send` / `newline` rather than joining them:
  // at 120 columns it is 53 of the row's 119 cells, and the clause that would be crowded
  // out is `Shift+Tab <next>`, the one the posture cycle most needs taught.
  if (input.hintsEnabled !== false && input.governed && input.interactionPhase === 'idle') {
    actions.push(copy.governIdle);
  } else if (input.hintsEnabled !== false && input.interactionPhase !== 'starting') actions.push(
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
    add((input.modeToggleKey ?? 'Shift+Tab') + ' ' + (input.nextPostureWord ?? copy.modeLabel));
    add(copy.help);
  }
  return result;
}
