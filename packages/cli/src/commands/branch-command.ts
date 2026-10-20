/**
 * `/branch` - open a new terminal on this session (tui-branch-terminal-shortcut
 * 3.5 / D-1 / D-2 / D-12 / D-13 / D-21 / D-22).
 *
 * ASCII ONLY - `src/commands/**` is inside `glyphs.test.ts::inScope`, which also
 * means every sentence in `BRANCH_COPY` is plain ASCII (no em dashes, no arrows).
 *
 * WHY A COMMAND AND NOT A KEY HANDLER: `Ctrl+L` dispatches `/branch` exactly the
 * way `Ctrl+I` dispatches `/skill:project-indexer` (`App.tsx` is a documented
 * oversize file, so new logic goes into a module and the key handler keeps doing
 * only guard + dispatch). The side benefit is that `/branch` becomes typeable,
 * testable, listed by `/help`, and inherits `executeSlashInput`'s try/catch - a
 * throwing command becomes one `Command failed: ...` line instead of an unhandled
 * rejection. The cost is ONE transcript line per press (D-21), which `Ctrl+I`
 * already pays today.
 *
 * THIS BODY NEVER TOUCHES SESSION DATA (I-5): no draft read, no queue change, no
 * message edit, no id change, no write to the parent file. It calls `identity()`
 * and `open()` and reports what came back.
 */

import type { CommandContext } from './registry.js';
import type { BranchOpenResult, BranchRequest } from '../session/branch-launch.js';

/** What `/branch` can do. The one seam a test needs. */
export interface BranchCommandPort {
  open(request: BranchRequest): Promise<BranchOpenResult>;
}

/**
 * Every sentence `/branch` can print, verbatim.
 *
 * ONE SOURCE, THREE CHANNELS (D-12): success goes to the toast (plus a notice while
 * the agent runs, D-22), failures go to `notify` because a user has to READ a full
 * sentence and possibly copy a command out of it, and cooldown goes to the toast
 * because it is not a failure - it is "you already did this", which expires in two
 * seconds and would be permanent noise in the transcript.
 *
 * `noIdentity` REUSES `/session`'s SENTENCE (R-10). The same state must not read
 * two different ways depending on which key the user pressed; only the consequence
 * clause ("so there is nothing to branch from" / "") differs.
 *
 * There is deliberately NO `stopped` entry (R-9): nothing ever called it.
 */
export const BRANCH_COPY = {
  noIdentity:
    'This session has no id (session recording is off for this build), ' +
    'so there is nothing to branch from.',
  unavailable: 'Branching into a new terminal is not available in this build.',
  cooldown: (ms: number) => `A branch was just opened - try again in ${ms} ms.`,
  opened: (id: string) => `New terminal opened - it resumes ${id} as a new branch.`,
  checkpointFailed: (reason: string) =>
    `Could not checkpoint this session (${reason}), so a new branch would start from ` +
    'stale context. Nothing was opened.',
  noLauncher: (manual: string) =>
    `No terminal window could be opened here. Run this in another terminal:\n${manual}`,
  spawnFailed: (reason: string, manual: string) =>
    `Could not start the terminal (${reason}). Run this in another terminal:\n${manual}`,
  lateError: (reason: string) => `The new terminal reported an error after opening: ${reason}`,
} as const;

/**
 * Run `/branch`.
 *
 * ASYNC BY NECESSITY, NOT BY STYLE: "the window opened" and "`wt.exe` does not
 * exist" are distinguishable only after the child emits `'spawn'` or `'error'`,
 * and ENOENT is reported asynchronously. `SlashCommand.run` already allows
 * `Promise<void>`, and `App` calls this as `void executeSlashInput('/branch')`, so
 * the UI never waits.
 */
export async function runBranchCommand(ctx: CommandContext): Promise<void> {
  // 1. No identity, no branch (D-13). Without an id there is nothing for the new
  //    window to resume, and a silent no-op reads as a bug.
  const identity = ctx.session?.identity();
  if (!identity) {
    ctx.notify('warn', BRANCH_COPY.noIdentity);
    return;
  }
  // 2. A build without the port says so rather than pretending.
  const port = ctx.branch;
  if (!port) {
    ctx.notify('warn', BRANCH_COPY.unavailable);
    return;
  }
  // 3. The cwd is the CONTROLLER's (`/cwd` can change it), never `process.cwd()`,
  //    and `--resume` does not restore a cwd - so this value is the only chance
  //    the new window has to land in the right directory (D-16).
  const result = await port.open({
    id: identity.id,
    cwd: ctx.controller.getCwd(),
    onLateError: (message: string) => ctx.notify('warn', message),
  });
  if (result.ok) {
    reportOpened(ctx, identity.id);
    return;
  }
  reportFailure(ctx, result);
}

/**
 * Success: the toast confirms the action; while the agent runs it ALSO gets one
 * notice line (D-22 / R-5).
 *
 * THE SECOND CHANNEL IS NOT REDUNDANCY. The status bar's feedback slot shows the
 * activity phrase during a run, so a toast at that moment is invisible; a user who
 * sees nothing presses again, gets caught by the cooldown, and sees nothing again.
 * The notice is also where "the child inherited the last settled turn, not the one
 * being generated" becomes visible after the fact.
 */
function reportOpened(ctx: CommandContext, id: string): void {
  const text = BRANCH_COPY.opened(id);
  ctx.toast('info', text);
  if (ctx.controller.isRunning()) ctx.notify('info', text);
}

/**
 * Failure: one notice, one sentence, and a command the user can paste (I-4).
 *
 * `cooldown` is the exception that goes to the toast (D-12): it is a time hint
 * about something that just succeeded, not a defect. `checkpoint-failed` and the
 * two spawn failures already carry their COMPLETE sentence - the launcher composes
 * it from `BRANCH_COPY` because only the launcher knows whether the checkpoint
 * failed because the history was unsendable or because this frame has no id yet
 * (R-19), and a body that re-wrapped the text would print an internal reason code.
 */
function reportFailure(
  ctx: CommandContext,
  result: Extract<BranchOpenResult, { ok: false }>,
): void {
  if (result.reason === 'cooldown') {
    ctx.toast('info', result.message);
    return;
  }
  ctx.notify('warn', result.message);
}
