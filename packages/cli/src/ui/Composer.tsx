/**
 * Composer (spec §4.7) — the thin shell around the existing `PromptInput`.
 *
 * Owns exactly two things: the semantic border color and the hint row. The
 * editor's pure helpers (`applyEdit` / `moveVertical` / `slashSuggestions` /
 * `fileTokenAt`) are untouched, so `input.test.ts` keeps passing.
 *
 * The draft flag is held HERE rather than in `App`: the border has to react to
 * "the input is no longer empty", and routing that through App would re-render
 * the transcript on the first keystroke of every message.
 *
 * As of v0.4.0 this is the ONLY place keybinding hints are shown — the status
 * bar's duplicate cluster is gone (§4.6). Two hints for the same keys, one of
 * them 31 columns wide, were both redundant and the reason the status bar had a
 * `cols >= 110` breakpoint.
 */

import React, { useCallback, useState } from 'react';
import { Box, Text } from 'ink';
import type { Theme } from './theme.js';
import type { TermCapabilities } from './capabilities.js';
import { pickGlyphs } from './glyphs.js';
import { HINT_FADE_AFTER } from '../config/schema.js';
import { PromptInput, type CommandOption } from './PromptInput.js';
import { ModeChip } from './ModeChip.js';
import { MODE_LABEL, MODE_TOGGLE_KEYS, nextMode, type AgentMode } from '../agent/agent-mode.js';

export interface ComposerProps {
  /** False while an overlay owns the keyboard (the input is visually blurred). */
  isActive: boolean;
  running: boolean;
  history: string[];
  commands: CommandOption[];
  cwd: string;
  /** Dropped on short terminals to buy back a row (§5.4). */
  showHint: boolean;
  /** Lifetime submissions; drives progressive disclosure of the idle hint. */
  submitCount: number;
  /** User opt-out (`--no-hints` / `hints: false`). */
  hintsEnabled: boolean;
  /** Mirror of the controller's effective mode; drives the chip and the border. */
  agentMode: AgentMode;
  /**
   * Which key this hint should NAME for the mode toggle
   * (shift-tab-mode-toggle-still-dead-on-windows, C3-1).
   *
   * A PROP RATHER THAN A CONSTANT because on some consoles the constant is a
   * lie. This row used to render `shift+tab` unconditionally, with no link to
   * the capability check three files away, so the machines where that key is
   * swallowed were the ones being told to press it - permanently, on every
   * frame, while the one warning they got scrolled out of the transcript
   * minutes earlier (analysis section 3.7). Defaults to the primary key, which
   * is what every unaffected machine renders.
   */
  modeToggleKey?: string;
  popupMaxRows?: number;
  popupMaxHeight?: number;
  onPopupRowsChange?: (rows: number) => void;
  /**
   * Rows of newer output below the viewport, forwarded to the input row's chip
   * (tui-selection-and-scroll-follow §4.2 / G7).
   *
   * IT IS STATE, NOT A FADEABLE HINT, and it therefore does NOT pass through the
   * `showHint` / `hintsEnabled` gate below. Those two govern the teaching row —
   * which retires keys the user has demonstrably learned and is dropped outright
   * on a short terminal — and "you are 12 rows behind the newest output" is
   * neither learnable nor optional. Same argument that keeps `esc abort`
   * un-faded in `hintText`.
   */
  scrolledLines?: number;
  /**
   * Live background services (background-service-supervision §3.8), 0 when none.
   *
   * IT IS STATE, NOT A FADEABLE HINT, exactly like `scrolledLines` above: the
   * clause it adds is the only visible way to stop something, and `hintText`
   * below keeps it out of the faded form for the same reason `esc abort` is kept
   * there.
   */
  services?: number;
  /**
   * The composer's DRAFT row count, forwarded upward (tui-paste-handling
   * section 5.5).
   *
   * `hasDraft` stays here, because the border reacts to it and routing that
   * through `App` would re-render the transcript on the first keystroke of every
   * message. The row count is the opposite case: `layout/budget.ts` needs it, so
   * it has to reach `App` — and it changes on a line break rather than on a
   * character, which is what keeps the re-render rate the same (R-6).
   */
  onDraftRows?: (rows: number) => void;
  /** Paste refusals from `PromptInput`, routed to `App`'s notice dispatch. */
  onNotice?: (level: 'warn' | 'error', text: string) => void;
  theme: Theme;
  caps: TermCapabilities;
  onSubmit: (text: string) => void;
  onHelp?: () => void;
}

/**
 * Build the hint row.
 *
 * The `running` branch is NEVER abbreviated, no matter how experienced the user
 * is. Once the status bar's hint cluster was removed, the composer became the
 * only place that names the abort key — and fading that out after eight
 * submissions would leave a long-running task with no visible way to stop it.
 * Progressive disclosure is for teaching discoverable things, not for retiring
 * an emergency exit (§4.6 / A-14 / M-10b).
 */
function hintText(opts: {
  running: boolean;
  submitCount: number;
  glyphs: ReturnType<typeof pickGlyphs>;
  mode: AgentMode;
  toggleKey: string;
  /** Live background services; 0 leaves both rows byte-identical to today's. */
  services: number;
}): string {
  const { running, submitCount, glyphs, mode, toggleKey, services } = opts;
  const dot = ` ${glyphs.midDot} `;
  // THE EXIT CLAUSE SURVIVES IN BOTH ROWS (P1-4). The obvious edit here is to
  // replace `ctrl+c*2 exit` with `ctrl+c stop N` — and that would delete the
  // only visible way to quit at exactly the moment Ctrl+C stops meaning "quit",
  // on the screen a user reaches when something has already gone wrong. Both
  // clauses are shown; the row is `wrap="truncate"` and they are ordered
  // most-urgent-first, so a terminal too narrow for all of them drops the exit
  // clause last rather than the abort key.
  if (running) {
    if (services > 0) {
      return [
        `${glyphs.enterKey} steer`,
        // Rung two is named because the whole point of the ladder is that the
        // first press can fail; a user who does not know there is a second press
        // is left exactly where the reported screenshot left them.
        `esc abort${glyphs.times}2 force`,
        `ctrl+c stop ${services}`,
        `ctrl+c${glyphs.times}2 exit`,
      ].join(dot);
    }
    return [`${glyphs.enterKey} steer`, 'esc abort', `ctrl+c${glyphs.times}2 exit`].join(dot);
  }
  // The hint names the DESTINATION, not the current state — the correct label
  // for a toggle affordance, and the reason the mode word here is the OPPOSITE
  // of the one on the chip beside it.
  const toggle = `${toggleKey} ${MODE_LABEL[nextMode(mode)].toLowerCase()}`;
  // The faded form KEEPS the mode toggle. Progressive disclosure exists to
  // retire things the user has demonstrably learned, and `submitCount` counts
  // submissions — a user can send fifty messages without ever discovering
  // Shift+Tab. Same argument that keeps `esc abort` un-faded above.
  // NEVER FADED, for the reason the props doc gives: it is the only visible way
  // to stop a process the agent left running, and progressive disclosure retires
  // things the user has demonstrably learned — not emergency exits.
  const stop = services > 0 ? [`ctrl+c stop ${services}`] : [];
  if (submitCount >= HINT_FADE_AFTER) return [...stop, toggle, '? help'].join(dot);
  return [
    ...stop,
    `${glyphs.enterKey} send`,
    `${glyphs.shiftEnter} newline`,
    '/ commands',
    '@ files',
    toggle,
    '? help',
  ].join(dot);
}

/**
 * `hintText`, for the interrupt-ladder tests (AC-43).
 *
 * EXPORTED UNDER A TEST-FACING NAME rather than exporting `hintText` itself, so
 * the private helper stays private in the module graph and nothing in `src/`
 * grows a second caller by accident. The row is the ONLY visible way to stop a
 * process the agent left running, so it is worth asserting on directly rather
 * than fishing the string out of a rendered frame.
 */
export const hintTextForTest = hintText;

export function Composer({
  isActive,
  running,
  history,
  commands,
  cwd,
  showHint,
  submitCount,
  hintsEnabled,
  agentMode,
  services = 0,
  modeToggleKey = MODE_TOGGLE_KEYS.primary,
  popupMaxRows,
  popupMaxHeight,
  onPopupRowsChange,
  scrolledLines = 0,
  onDraftRows,
  onNotice,
  theme,
  caps,
  onSubmit,
  onHelp,
}: ComposerProps): React.ReactElement {
  const [hasDraft, setHasDraft] = useState(false);
  const onDraftChange = useCallback(
    (next: { hasDraft: boolean; rows: number }) => {
      setHasDraft(next.hasDraft);
      onDraftRows?.(next.rows);
    },
    [onDraftRows],
  );

  // Plan mode inserts ONE branch, above `draft` and below `running`. The
  // ordering is load-bearing: an in-flight run's border must stay `toolRunning`,
  // because "is it running" is more urgent than "which mode".
  const borderColor = !isActive
    ? theme.toolPending
    : running
    ? theme.toolRunning
    : agentMode === 'plan'
    ? theme.accent
    : hasDraft
    ? theme.focusBorder ?? theme.primary
    : theme.idleBorder ?? theme.border;

  const glyphs = pickGlyphs(caps);
  const visible = showHint && hintsEnabled;

  return (
    <Box flexDirection="column" flexShrink={0}>
      <PromptInput
        isActive={isActive}
        running={running}
        history={history}
        commands={commands}
        cwd={cwd}
        theme={theme}
        caps={caps}
        popupMaxRows={popupMaxRows}
        popupMaxHeight={popupMaxHeight}
        onPopupRowsChange={onPopupRowsChange}
        onSubmit={onSubmit}
        onHelp={onHelp}
        agentMode={agentMode}
        bordered={{ color: borderColor }}
        onDraftChange={onDraftChange}
        onNotice={onNotice}
        scrolledLines={scrolledLines}
      />
      {visible && (
        // The chip rides the EXISTING hint row rather than adding one, so it
        // costs zero rows on a 24-row terminal.
        <Box flexDirection="row" flexShrink={0}>
          <Text>{'  '}</Text>
          <ModeChip mode={agentMode} theme={theme} caps={caps} />
          <Text wrap="truncate" color={theme.hintFg ?? theme.muted}>
            {/* AN OPTIONS OBJECT rather than a sixth positional parameter: this
                repo's own guideline caps a function at five (P2-11), and a sixth
                boolean-ish scalar in a positional list is the shape that gets
                passed in the wrong order. */}
            {hintText({
              running,
              submitCount,
              glyphs,
              mode: agentMode,
              toggleKey: modeToggleKey,
              services,
            })}
          </Text>
        </Box>
      )}
    </Box>
  );
}
