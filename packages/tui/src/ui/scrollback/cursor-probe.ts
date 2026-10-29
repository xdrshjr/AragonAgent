/**
 * Cursor-position probe — the one measurement the bottom anchor cannot do without
 * (tui-bottom-anchored-live-region §4.4 / §6.3).
 *
 * WHY IT EXISTS. "How many rows are left below the cursor" cannot be derived from
 * anything the process already knows: `CUD` clamps silently at the last row and
 * reports nothing, and the only other way to reach the bottom is to print `rows - 1`
 * newlines, which scrolls the user's screen. `ESC[6n` asks instead of guessing, and
 * every target terminal answers it — Windows Terminal, conhost through ConPTY, tmux,
 * screen, xterm/vte/alacritty/kitty/wezterm/foot/ghostty, the VS Code terminal and an
 * SSH session's far end.
 *
 * WHAT IT DOES NOT DO:
 *  - It does not touch raw mode. Raising raw is the HOST's job and must happen BEFORE
 *    the query (P0-1 / I-A10): in canonical mode the reply is line-buffered until a
 *    newline and the terminal ECHOES it as `^[[12;1R` onto the screen, so the probe
 *    would time out forever on Linux/macOS while printing garbage.
 *  - It does not consume input. The filter ahead of Ink owns every byte; this module
 *    is a second `'data'` listener that never `pause()`s, `read()`s or `unshift()`s
 *    (D5 / R2).
 *  - It does not retry. One query, one bounded wait, then the caller degrades.
 *
 * FAILURE IS NORMAL, NOT AN ERROR: a terminal that never answers is a terminal that
 * gets the one-off screen fill instead (rung 2 of the ladder). Nothing here throws,
 * and nothing here can keep the process alive: the timer is `unref()`ed and the
 * listener is always removed.
 */

import { SCROLLBACK_LIMITS } from './limits.js';
import {
  formatCursorReportQuery, spaceBelowFromReport, splitCursorReports,
} from '../../input/cursor-report.js';

export interface CursorProbeOptions {
  /** The REAL stdin — not the filter's PassThrough, and not Ink's stream. */
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  /** Terminal height, read at answer time so a mid-wait resize is not fatal. */
  rows: () => number | undefined;
  /** Overrides `SCROLLBACK_LIMITS.anchorProbeTimeoutMs` (tests). */
  timeoutMs?: number;
  /**
   * Keep the event loop alive while waiting for the answer.
   *
   * THE STARTUP PROBE MUST SET THIS, and the reason is measured rather than
   * theoretical: an `unref()`ed timer is invisible to the event loop, so on a session
   * where nothing is referenced yet — stdin already at EOF, a piped stdin, a console
   * whose reader is paused — the process can exit BEFORE the first frame is ever
   * drawn. `screen.test.ts`'s subprocess probe caught exactly that: exit code 0,
   * `ESC[6n` on screen and no application at all.
   *
   * Background re-probes keep the default (`false`): a teardown must never be
   * delayed, and by then the UI itself is holding the loop.
   */
  holdProcess?: boolean;
}

/** Longest acceptable report prefix we buffer before giving up on the chunk. */
const MAX_BUFFER_CHARS = 64;

/**
 * THE DEATH SWITCH (I-A9 / P1-6).
 *
 * Once the session is over — `finalizeNativeScreen()`, `disposeFrameWriter()`, a
 * disposed filter, the process `exit` hook — a query must never reach the terminal
 * again. It would be written at a terminal already handed back to the shell, where
 * nothing strips the reply, and the user's prompt would gain a literal `^[[12;1R`.
 * The flag lives at module level because `cli.tsx`'s four exit paths converge on one
 * call and must not each own a copy of the state.
 */
let disabled = false;
/** Single-flight: a drag can ask twice inside one settle window. */
let inFlight: Promise<number | null> | null = null;

/**
 * Arm or disarm the switch. `true` is permanent for the process: there is no
 * legitimate reason to probe after the screen has been handed back.
 */
export function setAnchorProbeDisabled(value: boolean): void {
  disabled = value;
  if (value) inFlight = null;
}

/** Test hook — the switch is process-wide by design, so tests must reset it. */
export function resetAnchorProbeForTests(): void {
  disabled = false;
  inFlight = null;
}

/**
 * Ask the terminal where the cursor is and return the rows left below it
 * (`0` = already on the last row). Returns `null` for every failure mode:
 *
 * | Situation                        | Result                          |
 * |----------------------------------|---------------------------------|
 * | switches off / not a TTY / rows unknown | `null`, synchronously, zero bytes |
 * | terminal answers                 | `rows - 1 - (row - 1)`          |
 * | timeout (`anchorProbeTimeoutMs`) | `null`, timer and listener removed |
 * | concurrent call                  | the same promise; one query only |
 * | `stdout.write` throws            | `null`                          |
 * | a late reply after the timeout   | ignored here; the filter strips it |
 */
export function probeAnchorSpaceBelow(o: CursorProbeOptions): Promise<number | null> {
  if (disabled) return Promise.resolve(null);
  if (!o.stdin.isTTY || !o.stdout.isTTY) return Promise.resolve(null);
  if (inFlight) return inFlight;
  const rowsNow = o.rows();
  if (rowsNow === undefined || !Number.isFinite(rowsNow) || rowsNow < 1) {
    return Promise.resolve(null);
  }

  const promise = new Promise<number | null>((resolve) => {
    const timeoutMs = o.timeoutMs ?? SCROLLBACK_LIMITS.anchorProbeTimeoutMs;
    let buffer = '';
    let settled = false;
    let timer: NodeJS.Timeout | null = null;

    const finish = (value: number | null): void => {
      if (settled) return;
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      o.stdin.removeListener('data', onData);
      resolve(value);
    };

    function onData(chunk: string | Buffer): void {
      if (settled) return;
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (buffer.length > MAX_BUFFER_CHARS) buffer = buffer.slice(-MAX_BUFFER_CHARS);
      const split = splitCursorReports(buffer);
      const report = split.reports[0];
      if (!report) return;
      finish(spaceBelowFromReport(report, o.rows() ?? undefined));
    }

    try {
      o.stdout.write(formatCursorReportQuery());
    } catch {
      // A closed or broken stdout is an ordinary failure, not a crash on startup.
      finish(null);
      return;
    }

    o.stdin.on('data', onData);
    timer = setTimeout(() => finish(null), Math.max(1, Math.floor(timeoutMs)));
    // `unref()` by default (see `holdProcess`), so a stray re-probe can never keep a
    // teardown alive. The startup probe opts back in: there it is the ONLY thing
    // holding the loop, and losing the session to save 150 ms is not a trade.
    if (!o.holdProcess) timer.unref?.();
  });

  inFlight = promise;
  void promise.then(() => {
    if (inFlight === promise) inFlight = null;
  });
  return promise;
}
