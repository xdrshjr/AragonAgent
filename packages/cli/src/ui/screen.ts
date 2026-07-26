/**
 * Alternate screen buffer take-over (spec §4.4).
 *
 * Why the alt-screen and not a clear: `\x1b[3J` destroys the user's scrollback
 * (their build log, their stack trace) — an unacceptable side effect for a
 * developer tool. The alt-screen is non-destructive: the main buffer is covered,
 * not erased, and comes back untouched on exit. It also parks the cursor at
 * (1,1), which gives the frame accounting in §4.2 a deterministic origin.
 *
 * CALL SITE IS LOAD-BEARING: only `cli.tsx::runInteractive()` may call this.
 * Hoisting it into `buildProgram()` / `parseAsync` would push `\x1b[?1049h`
 * into `argon -p "…" > out.txt`, `argon config set`, and `argon --version`.
 */

export interface ScreenHandle {
  /** Leave the alternate screen. Idempotent — safe from every exit path. */
  restore(): void;
}

const ENTER_ALT = '\x1b[?1049h';
const LEAVE_ALT = '\x1b[?1049l';
const CURSOR_HOME = '\x1b[H';
const CLEAR_VISIBLE = '\x1b[2J';
/** Ink's log-update hides the cursor; a signal kill never gives it back. */
const SHOW_CURSOR = '\x1b[?25h';

const NOOP_HANDLE: ScreenHandle = { restore() {} };

function safeWrite(stdout: NodeJS.WriteStream, data: string): void {
  try {
    stdout.write(data);
  } catch {
    // A closed/broken stdout must never turn into a crash on the exit path.
  }
}

/**
 * Enter the alternate screen. A non-TTY stdout is a hard no-op (tests, pipes,
 * CI) — writing screen-control sequences into a redirected file corrupts it.
 */
export function enterAltScreen(stdout: NodeJS.WriteStream | undefined): ScreenHandle {
  if (!stdout || !stdout.isTTY || typeof stdout.write !== 'function') return NOOP_HANDLE;

  safeWrite(stdout, ENTER_ALT + CLEAR_VISIBLE + CURSOR_HOME);

  let restored = false;
  return {
    restore(): void {
      if (restored) return;
      restored = true;
      safeWrite(stdout, SHOW_CURSOR + LEAVE_ALT);
    },
  };
}

/**
 * Replay the session summary into the normal buffer after `restore()`, so the
 * conversation does not evaporate along with the alternate screen.
 */
export function writeExitTranscript(
  stdout: NodeJS.WriteStream | undefined,
  text: string,
): void {
  if (!stdout || typeof stdout.write !== 'function') return;
  if (text.length === 0) return;
  safeWrite(stdout, text.endsWith('\n') ? text : `${text}\n`);
}
