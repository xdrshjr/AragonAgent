/**
 * Terminal plan — the ONE decision point for how the interactive TUI occupies the
 * terminal (tui-native-terminal-scroll §4.1 / D10).
 *
 * `cli.tsx::runInteractive` used to derive `wantMouse`, `mouseOn`, `wantSelect`,
 * `pasteOn` and `enhancedKeysOn` inline, each with its own comment about why the
 * others must agree. Adding a second screen mode multiplies that surface, so the
 * agreement is computed here, once, and the call site only READS the result.
 *
 * PURE: no I/O, no `process` access, so every row of the rules below is a table
 * test with plain literals.
 *
 * I-S9 · `app` reproduces the pre-feature expressions term for term. The
 * regression test diffs this function against a verbatim copy of those
 * expressions, because "the same by inspection" is how mouse and paste drifted
 * apart the last time.
 */

import type { ScrollMode } from '../model/config/schema.js';

export type { ScrollMode } from '../model/config/schema.js';

export interface TerminalPlanInput {
  /** The resolved `scrollMode` config value. */
  scrollMode: ScrollMode;
  configMouse: boolean;
  configMouseSelect: boolean;
  configPaste: boolean;
  configKeyboardEnhancement: boolean;
  configDiffRender: boolean;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  platform: NodeJS.Platform;
  /** Measured on win32 (`forceVtInputForThisConsole`); irrelevant elsewhere. */
  vtInputSupported: boolean;
}

export interface TerminalPlan {
  scrollMode: ScrollMode;
  /** `app`: enter the alternate screen. `native`: never. */
  altScreen: boolean;
  /** Whether the terminal is asked for SGR mouse reports (and a mouse filter is wanted). */
  mouseReporting: boolean;
  /** Application-drawn drag selection. Always `false` in native mode (the terminal selects). */
  dragSelect: boolean;
  bracketedPaste: boolean;
  enhancedKeys: boolean;
  /**
   * Which frame writer fronts Ink's stdout. `native` ALWAYS needs the scrollback
   * writer, even with `diffRender` off: static rows are injected through it.
   */
  differ: 'fullscreen' | 'scrollback' | 'none';
  /** Native + `diffRender:false` — every frame rewrites the whole live region. */
  fullEveryFrame: boolean;
}

export function resolveTerminalPlan(input: TerminalPlanInput): TerminalPlan {
  const bothTty = input.stdinIsTTY && input.stdoutIsTTY;
  // Paste and keyboard enhancement ride the stdin filter and say nothing about
  // scrolling, so the two modes agree on them (rule 3).
  const bracketedPaste = input.configPaste && input.stdinIsTTY;
  const enhancedKeys =
    input.configKeyboardEnhancement &&
    input.stdinIsTTY &&
    (input.platform !== 'win32' || input.vtInputSupported);

  if (input.scrollMode === 'native') {
    return {
      scrollMode: 'native',
      altScreen: false,
      mouseReporting: false,
      dragSelect: false,
      bracketedPaste,
      enhancedKeys,
      differ: 'scrollback',
      fullEveryFrame: !input.configDiffRender,
    };
  }

  const mouseReporting = input.configMouse && bothTty && input.vtInputSupported;
  return {
    scrollMode: 'app',
    altScreen: true,
    mouseReporting,
    dragSelect: mouseReporting && input.configMouseSelect,
    bracketedPaste,
    enhancedKeys,
    differ: input.configDiffRender ? 'fullscreen' : 'none',
    fullEveryFrame: false,
  };
}
