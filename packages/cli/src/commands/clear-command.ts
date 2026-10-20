/**
 * `/clear` - start a new conversation - plus its `/reset` alias and the
 * `/clear screen` form that keeps the old "just wipe the screen" meaning
 * (clear-command-context-reset §3.5 / D-1 / D-2 / D-3).
 *
 * ASCII ONLY: `src/commands/**` is inside `glyphs.test.ts::inScope`. The one
 * localized string below is written with `\u` escapes for that reason, exactly
 * as the `/reset` body it replaces did.
 *
 * WHY THE BODY LIVES HERE AND THE REGISTRATION STAYS IN `builtins.ts`: the same
 * reason `/compact` and `/context` do (D-8). `builtins.ts` is 1511 lines against
 * `CLAUDE.md`'s 1000-line cap, and this command is no longer a two-line
 * projection reset - it interrupts a run, waits for it, archives a conversation
 * and then clears. A two-line edit belongs inline; this does not.
 *
 * THE COMMAND'S ONLY JOB IS SEQUENCING AND SPEAKING. Every state change happens
 * on the controller port (`AgentController.resetConversation`, which delegates
 * the ORDER to `agent/conversation-reset.ts`), and every word the user reads is
 * decided here, in one place, in the exact order they will read it.
 */

import { getLogger } from '../logging/logger.js';
import type { CommandContext } from './registry.js';

/** The toast a successful clear shows. Pinned verbatim by an existing test. */
const CLEARED_TOAST = 'Started a new conversation.';

/**
 * Run `/clear` or `/reset`. Both registry entries point HERE (D-2), which is
 * what stops the two from drifting back into "one clears the screen, one clears
 * the session" - the drift that produced the defect this feature fixes.
 */
export async function runClearCommand(ctx: CommandContext): Promise<void> {
  const verb = ctx.args.trim().toLowerCase();
  if (verb === 'screen') {
    // The old behaviour, byte for byte (I-3): silent, transcript plus the todo
    // panel, history untouched.
    clearScreenOnly(ctx);
    return;
  }
  if (verb !== '') {
    // Rejected rather than ignored. A command that silently accepts and
    // discards an argument is a surface that lies about what it understood.
    ctx.notify('warn', `Unknown argument "${ctx.args.trim()}" - use /clear [screen].`);
    return;
  }
  // READ BEFORE CLEARING (P1-2 / I-9). `clearAllQueues()` empties
  // `pendingUserSteering`, so a count taken afterwards is always zero - and a
  // notice that says "0 messages cancelled" is worse than no notice at all.
  const cancelled = ctx.state.pendingSteering.length;
  const result = await ctx.controller.resetConversation({
    interrupt: true,
    // A THUNK, NOT A VALUE (P0-1 / §3.3). `ctx.state` is the view as of command
    // entry, and the archive happens AFTER the interrupted engine unwinds - so
    // the last tool cards of the abandoned run are written to the transcript in
    // between. A value captured here would archive everything except the part
    // the user was looking at when they typed the command.
    readTranscript: () => ctx.transcriptEntries?.() ?? ctx.state.entries,
  });
  if (!result.ok) {
    // ZERO SIDE EFFECTS (I-4), and a trace (P1-5). The user gets one sentence
    // naming the next action; the log gets the reason, because "my /clear did
    // nothing" is otherwise unanswerable after the fact.
    getLogger().warn('agent', 'clear_still_running', { reason: result.reason });
    ctx.notify('warn', result.message);
    return;
  }
  // THE VIEW GOES LAST (B-5 / §3.3). `App`'s dispatch wrapper zeroes the run
  // metrics, the interaction phase and the scroll anchor on this action, so
  // dispatching it after the engine has settled is what makes "cleared" mean
  // "nothing is still writing into it".
  ctx.dispatch({ type: 'resetConversation' });
  // THE ONE CONSUMER OF `messagesCleared` (P2-1). It cannot join the toast:
  // `clear-command-todo.test.ts` pins that string verbatim, and a count nobody
  // asked for is noise in the one place the user reads confirmations.
  getLogger().info('agent', 'conversation_cleared', {
    messagesCleared: result.messagesCleared,
    interrupted: result.interrupted,
  });
  ctx.toast('info', CLEARED_TOAST);
  // REINSTATED FROM THE OLD `/reset` (P1-1 / C-3). Dropping it would silently
  // delete a user-visible acknowledgement that already existed and was already
  // pinned by test.
  if (cancelled) {
    ctx.notify('warn', `\u5df2\u53d6\u6d88 ${cancelled} \u6761\u672a\u63a5\u6536\u6d88\u606f`);
  }
  if (result.archivedPath) {
    // A PATH RATHER THAN A PROMISE: the user can copy it, and `/resume` accepts
    // an absolute path. "Archived" with no way to find the file is a reassurance,
    // not a recovery.
    ctx.notify('info',
      `Previous conversation archived: ${result.archivedPath} (/resume <path> to restore)`);
  }
}

/**
 * Today's `/clear`, unchanged and silent (D-3 / I-3).
 *
 * Kept as a real form rather than as a separate command because "clear the
 * screen" and "clear the conversation" are two different intentions, and a user
 * who wants the first must not have to risk the second. It also gives
 * `clearTranscript` a live dispatcher: `CLAUDE.md` forbids orphaned actions, and
 * this was the last one that would have had none.
 */
function clearScreenOnly(ctx: CommandContext): void {
  // A USER OVERRIDE OF A PROJECTION, the same class as `/todo clear`, so it
  // reuses reason `'user'`; the distinction against `clearMessages()`'s `'reset'`
  // is recorded on `TodoStore`. Clearing the STORE and not merely the view
  // mirror is what keeps `/save`, `/todo status|continue` and follow-through
  // agreeing with the screen - they read the store directly.
  ctx.controller.clearTodos();
  ctx.dispatch({ type: 'clearTranscript' });
}
