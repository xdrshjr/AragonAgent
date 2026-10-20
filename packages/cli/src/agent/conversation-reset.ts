/**
 * The single authority on the ORDER of a conversation reset
 * (clear-command-context-reset §3.4 / D-9).
 *
 * ASCII ONLY: `src/agent/**` is inside `glyphs.test.ts::inScope`, and this module
 * contributes transcript text (the "could not stop" message) through the command
 * layer.
 *
 * WHY A PORT RATHER THAN A METHOD ON `AgentController`: the order - interrupt,
 * bounded wait, archive, clear queues, clear history - is the thing that has a
 * correctness proof attached to it (a clear that lands before the engine unwinds
 * pollutes the new conversation, or produces a `tool_use` with no `tool_result`).
 * Written as a method, that order can only be tested by constructing a controller
 * and everything it wires. Written against a port, the order itself is the thing
 * under test, and every failure branch is reachable from a six-line fake.
 *
 * `interruptRun` IS NOT CALLED `abort`, ON PURPOSE (P0-2). It maps to
 * `controller.forceStop()`, which does three things `abort()` does not: it
 * hard-kills foreground `bash` children (the only thing that unblocks a tool that
 * ignores the abort signal), and it bumps `runGen` - the generation fence `App`
 * compares every engine event against. A method named `abort` that quietly does
 * more than the existing `abort()` would be the exact kind of misleading name
 * this feature exists to remove.
 */

import type { Entry } from './reducer.js';

/** The minimal host surface a reset needs. Supplied by `AgentController` alone. */
export interface ConversationResetPort {
  /** Whether a run is in flight right now. */
  isRunning(): boolean;
  /**
   * Interrupt the current run: `controller.forceStop()` (P0-2).
   *
   * = `abort()` (stops team / fast / compaction) + `killForeground('force')`
   * + `runGen += 1`. Background services are deliberately untouched.
   */
  interruptRun(): void;
  /** Bounded wait for the engine to unwind; `true` means it settled. */
  awaitEngineIdle(): Promise<boolean>;
  /**
   * Best-effort archive of the old conversation; an absolute path, or `null`.
   *
   * `readTranscript` is supplied by the caller because the screen transcript lives
   * in `ViewState`, which the controller does not and must not know about (P0-1).
   * Implementations never throw.
   */
  archive(readTranscript: () => Entry[]): string | null;
  /** Drop Core's two queues plus the CLI's pending steering list. */
  clearQueues(): void;
  /** Clear the history (the six-part boundary) and return the message count. */
  clearHistory(): number;
}

export interface ConversationResetOptions {
  /** Interrupt a running engine (default `true`). `false` refuses instead. */
  interrupt?: boolean;
  /** Read the screen transcript for the archive. Absent = history-only archive. */
  readTranscript?: () => Entry[];
}

export type ConversationResetResult =
  | { ok: true; interrupted: boolean; archivedPath: string | null; messagesCleared: number }
  | { ok: false; reason: 'still-running'; message: string };

/**
 * The one message a failed reset shows. It names the NEXT ACTION rather than the
 * failure, because `forceStop()` already ran: what is left to try is the human's
 * own hand.
 */
export const CLEAR_STILL_RUNNING_MESSAGE =
  'Could not stop the current run. Press Esc twice to force-stop, then /clear.';

/**
 * Reset the conversation, in the only order that is safe.
 *
 * THE ORDER IS THE DESIGN (D-9). Each step exists because of what happens if it
 * moves:
 *  1. interrupt - a clear that does not stop the loop first is overwritten by the
 *     loop's next `tool_result` append;
 *  2. bounded wait - the interrupt is a request; `agent.abort()` resolves nothing
 *     by itself, so clearing now still races the unwind;
 *  3. archive - BEFORE the clear, because after it there is nothing left to save;
 *  4. clear queues - before the history, so a drain cannot re-feed the old queue;
 *  5. clear history - the six-part boundary plus `startupSequence`.
 *
 * A FAILED WAIT CLEARS NOTHING (I-4). Half a reset - queues emptied, history
 * still there - is worse than no reset at all, because the view and the engine
 * then disagree with no visible cause.
 */
export async function resetConversationWith(
  port: ConversationResetPort,
  opts: ConversationResetOptions = {},
): Promise<ConversationResetResult> {
  const interrupt = opts.interrupt ?? true;
  const running = port.isRunning();
  if (running && !interrupt) {
    return { ok: false, reason: 'still-running', message: CLEAR_STILL_RUNNING_MESSAGE };
  }
  if (running) {
    port.interruptRun();
    const settled = await port.awaitEngineIdle();
    if (!settled) {
      return { ok: false, reason: 'still-running', message: CLEAR_STILL_RUNNING_MESSAGE };
    }
  }
  const readTranscript = opts.readTranscript ?? ((): Entry[] => []);
  const archivedPath = port.archive(readTranscript);
  port.clearQueues();
  const messagesCleared = port.clearHistory();
  return { ok: true, interrupted: running, archivedPath, messagesCleared };
}
