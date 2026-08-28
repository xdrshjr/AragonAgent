/**
 * Clipboard (tui-selection-and-scroll-follow §4.4.5) — the SINGLE clipboard path
 * for the package. `/copy` and the selection release both come through here.
 *
 * Two mechanisms, both attempted, and the return value names the better one so
 * the toast can say what was SENT rather than claiming a success neither one can
 * confirm:
 *
 *  1. **OSC 52.** It reaches the clipboard of the machine the USER is sitting
 *     at, which is the only correct target over SSH, and it is the only mechanism
 *     that works with no helper binary installed. `/copy` gained SSH support the
 *     moment it moved onto this module.
 *  2. **The platform binary** (`clip` / `pbcopy` / `xclip`), moved here unchanged
 *     from `commands/builtins.ts`, for the local case and for terminals that
 *     ignore OSC 52 (tmux without `set -g set-clipboard on`, R-7).
 *
 * IT TAKES A WRITE *DOOR*, NOT A STREAM, and that is P1-6 rather than taste. In
 * full-screen mode stdout is a `Proxy` in front of the frame differ; an
 * unrecognised chunk there takes `passThrough(true)`, which increments
 * `fallbacks` and — on the first one — raises `onFirstFallback`, wired to
 * `console.warn(FRAME_FALLBACK_NOTICE)`. Sending OSC 52 through the proxy would
 * therefore print a diagnostic at a user who did nothing wrong the first time
 * they copied anything, and would permanently corrupt a counter documented to
 * mean "something wrote to stdout behind Ink's back". The caller supplies
 * `writeForeign` instead, and this module cannot pick the wrong door.
 */

import { spawn } from 'node:child_process';
import process from 'node:process';

export type CopyVia = 'osc52' | 'native' | 'none';

/**
 * Ceiling on an OSC 52 payload, in bytes of the ORIGINAL text.
 *
 * xterm's default limit is around 100 000 BASE64 characters and tmux / screen
 * are stricter, so 56 000 source bytes (~74 700 base64) stays inside all three
 * with room to spare. Past it the sequence is skipped rather than truncated: a
 * terminal that drops an over-long OSC 52 leaves the clipboard holding whatever
 * was there before, and half a selection is worse than none.
 */
export const MAX_OSC52_BYTES = 56_000;

/** `\x1b]52;c;<base64>\x07` — `c` is the CLIPBOARD selection, not PRIMARY. */
export function osc52(text: string): string {
  return `\x1b]52;c;${Buffer.from(text, 'utf-8').toString('base64')}\x07`;
}

/** Best-effort clipboard copy via the platform's clipboard CLI. */
function copyNative(text: string): boolean {
  const cmd =
    process.platform === 'win32'
      ? { file: 'clip', args: [] as string[] }
      : process.platform === 'darwin'
      ? { file: 'pbcopy', args: [] }
      : { file: 'xclip', args: ['-selection', 'clipboard'] };
  try {
    const child = spawn(cmd.file, cmd.args, { stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', () => {
      /* swallow — clipboard is best-effort, and a missing xclip is ordinary */
    });
    child.stdin?.end(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Put `text` on the clipboard and report the best mechanism that was reached.
 *
 * `write` is the foreign-write door (see the module header). Omit it and OSC 52
 * is skipped entirely, which is the correct behaviour for a caller that has no
 * terminal to write to.
 *
 * NEITHER MECHANISM IS DETECTABLE. `spawn` returning without throwing does not
 * mean `xclip` exists, and an OSC 52 sequence a terminal ignores is
 * indistinguishable from one it honours. The return value therefore names what
 * was ATTEMPTED, and every caller's user-facing text is worded accordingly.
 */
export function copyText(text: string, write?: (chunk: string) => void): CopyVia {
  if (text.length === 0) return 'none';

  let sentOsc52 = false;
  if (write && Buffer.byteLength(text, 'utf-8') <= MAX_OSC52_BYTES) {
    try {
      write(osc52(text));
      sentOsc52 = true;
    } catch {
      // A closed or broken stdout must never turn a copy into a crash.
    }
  }

  const sentNative = copyNative(text);
  if (sentOsc52) return 'osc52';
  return sentNative ? 'native' : 'none';
}
