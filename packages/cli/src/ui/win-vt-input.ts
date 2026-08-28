/**
 * Will this console ever deliver `CSI Z` and SGR mouse reports?
 * (shift-tab-and-mouse-wheel-dead-on-some-terminals, F1')
 *
 * ASCII ONLY - this tree is inside the glyph scanner's scope.
 *
 * On Windows the answer is decided by NODE, not by the terminal emulator and not
 * by anything this package writes. `Shift+Tab` and SGR mouse reporting both
 * exist only while the console input handle has `ENABLE_VIRTUAL_TERMINAL_INPUT`
 * set, and Node only sets it from v22.17.0 / v24.2.0 onward, where
 * `SetRawMode` switched from `UV_TTY_MODE_RAW` to `UV_TTY_MODE_RAW_VT`
 * (`nodejs/node` `src/tty_wrap.cc`). Before that libuv translates console input
 * records into ANSI itself, and that translation
 *
 *   - has no `VK_TAB` entry, and takes the character branch for it because
 *     `uChar.UnicodeChar` is 0x09, where SHIFT_PRESSED is never read. So
 *     `Shift+Tab` arrives as a PLAIN TAB, byte-identical to `Tab`;
 *   - `continue`s past every record that is not a `KEY_EVENT`, so a mouse
 *     report cannot reach the process at all.
 *
 * Measured rather than reasoned: injecting the same keystrokes into the same
 * console, Node 20.19.0 yields `09` for `Shift+Tab` and Node 22.18.0 yields
 * `1b 5b 5a`; console mode samples `0x0008` and `0x0208` respectively. The full
 * probe data is in `docs/diagnoses/shift-tab-and-mouse-wheel-dead-on-some-terminals/`.
 *
 * PURE: the platform and the version are arguments, so the whole table is
 * testable without a Windows box and without a second Node install.
 */

import { satisfiesNodeRange } from '../update/semver.js';

/**
 * The versions whose `setRawMode(true)` reaches `UV_TTY_MODE_RAW_VT`.
 *
 * `<23` IS LOAD-BEARING: 23.x branched before the change landed and never got
 * it, and 24.0/24.1 did not have it either - the fix reached the 24 line only in
 * 24.2.0. A range of `>=22.17.0` alone would call both of those supported.
 *
 * A TYPO HERE DISABLES THE WHOLE GATE SILENTLY, because `satisfiesNodeRange`
 * fails open: a clause it cannot parse makes the range unknown and the answer
 * `true`. `win-vt-input.test.ts` pins concrete version strings against concrete
 * booleans for exactly that reason - it is the only guard this constant has.
 */
export const WINDOWS_VT_INPUT_NODE_RANGE = '>=22.17.0 <23 || >=24.2.0';

/**
 * `false` only for the combination that is known to swallow both inputs:
 * `win32` running a Node outside `WINDOWS_VT_INPUT_NODE_RANGE`.
 *
 * FAILS OPEN, deliberately, in both directions (inherited from
 * `satisfiesNodeRange`, whose own reasoning is written down at its definition):
 * a version string that cannot be parsed is assumed supported. Guessing wrong
 * that way costs nothing beyond today's behaviour; guessing wrong the other way
 * would turn the mouse off on a machine where it works, which is a regression
 * this bug does not justify risking.
 *
 * Every non-Windows platform is `true` unconditionally. macOS and Linux go
 * through a real pty, where the terminal - not Node - encodes the keys, so no
 * version of Node has ever been able to affect this.
 */
export function supportsWindowsVtInput(platform: string, nodeVersion: string): boolean {
  if (platform !== 'win32') return true;
  return satisfiesNodeRange(WINDOWS_VT_INPUT_NODE_RANGE, nodeVersion);
}
