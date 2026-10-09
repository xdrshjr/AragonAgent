/**
 * Keyboard-enhancement lifecycle (the Shift+Enter newline fix).
 *
 * WHY A LIFECYCLE MODULE AND NOT ANOTHER `screen.ts` MODE. The alternate
 * screen is bound to fullscreen rendering; keyboard enhancement must run in
 * every interactive session, inline included, because the composer is always
 * there. It still follows the screen module's discipline: bytes are written
 * ONLY for a TTY stdout, restore is idempotent, and the caller owns every
 * decision -- this module is told the resolved capability and never derives
 * one from config or environment.
 *
 * PLATFORM SPLIT, DECIDED BY BYTE-LEVEL PROBES (see
 * docs/diagnoses/shift-enter-newline-dead-by-default):
 *
 * - win32: `?9001h` (win32-input-mode). It works through ConPTY on both
 *   conhost and Windows Terminal; kitty `CSI > 1 u` is swallowed there (a
 *   `CSI ? u` query never answers) and modifyOtherKeys is a no-op. Gated on
 *   the SAME `vtInputSupported` measurement the mouse feature uses: on Node
 *   < 22.17 / < 24.2 libuv never turns on `ENABLE_VIRTUAL_TERMINAL_INPUT`,
 *   so the records cannot reach the process and the mode would be a lie.
 * - everything else: kitty disambiguate (`CSI > 1 u`) plus
 *   `modifyOtherKeys=2`. iTerm2 / kitty / ghostty / WezTerm / foot implement
 *   at least one; terminals that implement neither ignore both bytes.
 */

import {
  CSI_U_DISABLE,
  CSI_U_ENABLE,
} from './csiu-keys.js';
import { WIN32_INPUT_DISABLE, WIN32_INPUT_ENABLE } from './win32-input-mode.js';

export interface KeyboardEnhancementHandle {
  /** Idempotent; writes the disable bytes exactly once. */
  restore(): void;
}

const NOOP_HANDLE: KeyboardEnhancementHandle = { restore() {} };

/** The handle a gated-out session reads: nothing was pushed, nothing unwinds. */
export const NOOP_KEYBOARD_ENHANCEMENT: KeyboardEnhancementHandle = NOOP_HANDLE;

function safeWrite(stdout: NodeJS.WriteStream, data: string): void {
  try {
    stdout.write(data);
  } catch {
    // A closed/broken stdout must never crash the exit path.
  }
}

/**
 * Ask the terminal to report modified keys distinctly. The returned handle's
 * `restore()` hands the keyboard back; wire it into the same convergence
 * point the screen restore uses so every exit path unwinds both.
 *
 * `vtInputSupported` is the measurement `cli.tsx` already resolves for the
 * mouse gate; on win32 it decides between `?9001h` and nothing at all.
 */
export function enableKeyboardEnhancement(
  stdout: NodeJS.WriteStream | undefined,
  opts: { readonly platform: string; readonly vtInputSupported: boolean },
): KeyboardEnhancementHandle {
  if (!stdout || !stdout.isTTY || typeof stdout.write !== 'function') return NOOP_HANDLE;
  const enable = opts.platform === 'win32'
    ? (opts.vtInputSupported ? WIN32_INPUT_ENABLE : '')
    : CSI_U_ENABLE;
  if (enable.length === 0) return NOOP_HANDLE;
  const disable = opts.platform === 'win32' ? WIN32_INPUT_DISABLE : CSI_U_DISABLE;

  safeWrite(stdout, enable);
  let restored = false;
  return {
    restore(): void {
      if (restored) return;
      restored = true;
      safeWrite(stdout, disable);
    },
  };
}
