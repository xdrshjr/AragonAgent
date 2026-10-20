/**
 * `/session` - report this session's identity, and the two things a user does
 * with it (tui-session-id-resume §3.11 / D-13 / D-14).
 *
 * ASCII ONLY - `src/commands/**` is inside `glyphs.test.ts::inScope`.
 *
 * WHY THE BODY LIVES HERE AND THE REGISTRATION STAYS IN `builtins.ts`: the same
 * reason `/clear` and `/compact` do. `builtins.ts` is already past the
 * 1000-line guideline, and this command is a report, not a one-liner.
 *
 * COPYING THE RESUME COMMAND IS THE POINT, NOT A CONVENIENCE (D-14). Typing 6
 * characters off a status bar is the only step of this whole feature that can
 * fail for a human, and `/session copy` removes it: one keystroke, the exact
 * command in the clipboard, no transcription.
 */

import type { CheckpointResult } from '../session/checkpoint.js';
import type { SessionIdentity } from '../session/startup-session.js';
import { sessionPathFor } from '../session/store.js';
import type { CommandContext } from './registry.js';

/**
 * What `/session` can see and do.
 *
 * THREE MEMBERS AND NO MORE. `identity()` is read at command time rather than
 * captured, because `/resume` rotates the id under a live App (D-15) and a
 * captured value would report the previous one for the rest of the session.
 */
export interface SessionCommandPort {
  /** The current identity, or `undefined` when this build has none. */
  identity(): SessionIdentity | undefined;
  /** Write once now; `pin` also marks the file as never-prunable. */
  checkpoint(opts?: { pin?: boolean }): CheckpointResult;
  /** Adopt another conversation and move to a derived id; `undefined` if it cannot. */
  rotate(loadedPath: string): SessionIdentity | undefined;
}

/**
 * The one path an id maps to.
 *
 * THROUGH `sessionPathFor` RATHER THAN A SECOND `join` (§2.2): that function is
 * the single choke point where an id becomes a file name, and a report that
 * built its own path would be the first thing to disagree with the writer about
 * where a session lives.
 */
export function sessionFilePath(id: string): string {
  return sessionPathFor(id);
}

/**
 * Run `/session`, `/session copy` or `/session pin`.
 *
 * ONE NOTICE FOR THE WHOLE REPORT (§3.11 / R-20): six separate notices would put
 * six cards in the transcript and replay them as six fragments on exit. The
 * `file` line is NOT truncated even when it overflows: it is a path the user
 * needs to be able to copy, and it is in the same family as `/save`'s
 * `Saved session to <path>`.
 */
export function runSessionCommand(ctx: CommandContext): void {
  const port = ctx.session;
  if (!port) {
    // HONEST RATHER THAN SILENT: a build without the feature should say so,
    // because "nothing happened" reads as a bug.
    ctx.notify('warn', 'This session has no id (session recording is off for this build).');
    return;
  }
  const verb = ctx.args.trim().toLowerCase();
  const identity = port.identity();
  if (!identity) {
    ctx.notify('warn', 'This session has no id (session recording is off for this build).');
    return;
  }
  if (verb === 'copy') {
    copyCommand(ctx, identity);
    return;
  }
  if (verb === 'pin') {
    pinSession(ctx, port, identity);
    return;
  }
  if (verb !== '') {
    // Rejected rather than ignored: a command that silently discards an argument
    // is a surface that lies about what it understood.
    ctx.notify('warn', `Unknown argument "${ctx.args.trim()}" - use /session [copy|pin].`);
    return;
  }
  report(ctx, identity);
}

/** The six-line report. Pure read: no checkpoint, no toast, no dispatch. */
function report(ctx: CommandContext, identity: SessionIdentity): void {
  const resume = `aragon --resume ${identity.id}`;
  const lines = [
    `id        ${identity.id}`,
    `file      ${sessionFilePath(identity.id)}`,
    identity.parentId
      ? `branch    ${identity.parentId} (this session does not write to it)`
      : 'branch    (none - this session started here)',
    `pinned    ${identity.pinned ? 'yes' : 'no'}`,
    `resume    ${resume}`,
    'save as   aragon --save <new-id>',
  ];
  ctx.notify('info', lines.join('\n'));
}

/** `/session copy` - the exact command, through the SAME door `/copy` uses. */
function copyCommand(ctx: CommandContext, identity: SessionIdentity): void {
  const text = `aragon --resume ${identity.id}`;
  if (!ctx.requestCopy) {
    ctx.notify('warn', 'Clipboard coordinator unavailable.');
    return;
  }
  void ctx.requestCopy({ text, lines: 1 }).then((result) => {
    if (result.status === 'confirmed' || result.status === 'sent') {
      ctx.toast('info', `Copied ${text}`);
      return;
    }
    // A failed or refused copy must not look like a successful one: the command
    // is short enough to read off the report above, so naming the failure is
    // enough to recover.
    ctx.notify(
      'warn',
      result.status === 'busy' ? 'Clipboard is busy - try /session copy again.' :
        `Copy failed: ${result.reason}`,
    );
  });
}

/** `/session pin` - write once and stop `sessions prune` from ever touching it. */
function pinSession(
  ctx: CommandContext,
  port: SessionCommandPort,
  identity: SessionIdentity,
): void {
  const result = port.checkpoint({ pin: true });
  if (!result.ok) {
    ctx.notify('warn', `Could not pin this session: ${result.message}`);
    return;
  }
  ctx.toast('info', `Session ${identity.id} pinned: aragon sessions prune will not delete it.`);
}
