/** Facts, never translated toast text, determine action ownership and feedback. */
export interface StatusFeedback {
  kind: 'confirm' | 'stopping' | 'force-stop' | 'exit' | 'clear-input' | 'copying'
    | 'copied' | 'copy-sent' | 'copy-cleanup' | 'copy-error' | 'notice';
  text: string;
  level: 'info' | 'warn' | 'error';
}
export type EscapeAction = 'menu' | 'cancel-start' | 'confirm-stop' | 'force-stop';
export interface StatusFeedbackInput {
  interactionPhase: 'idle' | 'starting' | 'running';
  interruptPhase?: 'ready' | 'armed' | 'stopping';
  completion?: 'none' | 'slash' | 'file';
  overlay?: string | null;
  copyState?: { busy: boolean; cleanupPending: boolean };
  copyResult?: { status: 'confirmed' | 'sent' | 'error'; text: string };
  ctrlCArmed?: boolean;
  /** Draft present: the armed feedback names the clear rung, not exit. */
  hasDraft?: boolean;
  selectionPending?: boolean;
  liveServices?: number;
  toast?: { text: string; level: 'info' | 'warn' | 'error' };
}
export interface StatusFeedbackProjection { feedback?: StatusFeedback; escapeAction?: EscapeAction }
export function projectStatusFeedback(input: StatusFeedbackInput): StatusFeedbackProjection {
  const escapeAction: EscapeAction | undefined = input.overlay ? undefined
    : input.completion && input.completion !== 'none' ? 'menu'
    : input.interactionPhase === 'starting' ? 'cancel-start'
    : input.interactionPhase !== 'running' ? undefined
    : input.interruptPhase === 'stopping' ? 'force-stop' : 'confirm-stop';
  let feedback: StatusFeedback | undefined;
  if (input.ctrlCArmed && !input.copyState?.busy && !input.copyState?.cleanupPending
    && !input.selectionPending && !input.liveServices) {
    feedback = input.hasDraft
      ? { kind: 'clear-input', text: 'Press Ctrl+C again to clear input', level: 'warn' }
      : { kind: 'exit', text: 'Press Ctrl+C again to exit', level: 'warn' };
  } else if (input.copyState?.cleanupPending) {
    feedback = { kind: 'copy-cleanup', text: 'Copy failed; cleaning up', level: 'error' };
  } else if (input.copyResult?.status === 'error') {
    feedback = { kind: 'copy-error', text: input.copyResult.text, level: 'error' };
  } else if (input.copyState?.busy) {
    feedback = { kind: 'copying', text: 'Copying', level: 'info' };
  } else if (input.copyResult) {
    feedback = { kind: input.copyResult.status === 'confirmed' ? 'copied' : 'copy-sent',
      text: input.copyResult.text, level: 'info' };
  } else if (input.interruptPhase === 'stopping' && escapeAction === 'force-stop') {
    feedback = { kind: 'force-stop', text: 'Esc again to force-stop', level: 'warn' };
  } else if (input.interruptPhase === 'armed' && escapeAction && escapeAction !== 'menu') {
    feedback = { kind: 'stopping', text: input.interactionPhase === 'starting'
      ? 'Esc again to cancel start' : 'Esc again to stop', level: 'warn' };
  } else if (input.toast) {
    feedback = { kind: 'notice', ...input.toast };
  }
  return { feedback, escapeAction };
}
