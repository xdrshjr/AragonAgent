/** Explicit TUI task boundary; omission retains legacy programmatic behavior. */
export interface PromptOptions {
  todoPolicy?: 'new-task' | 'continue';
}

/** History recording is independent of whether this message continues a plan. */
export interface SubmitMessageOptions extends PromptOptions {
  userInitiated?: boolean;
}

/** Startup outcome only; engine events still describe the result of the run. */
export type PromptOutcome =
  | { status: 'finished' }
  | { status: 'not-started'; reason: 'cancelled' | 'failed' };
