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
 * The fixed status row retains emergency and history-navigation hints while
 * this footer scrolls outside the viewport. Editor state stays mounted.
 */

import React, { useCallback, useState } from 'react';
import { Box, Text, type DOMElement } from 'ink';
import stringWidth from 'string-width';
import type { Theme } from './theme.js';
import type { TermCapabilities } from './capabilities.js';
import { pickGlyphs } from './glyphs.js';
import { HINT_FADE_AFTER } from '../config/schema.js';
import { PromptInput, type CommandOption } from './PromptInput.js';
import { ModeChip, modeChipCols } from './ModeChip.js';
import { ActivityLabel, resolveActivityLabel } from './ActivityLine.js';
import { RUN_ROW_LEAD, planRunRow, type RunActivity } from './run-status-row.js';
import { MODE_LABEL, MODE_TOGGLE_KEYS, nextMode, type AgentMode } from '../agent/agent-mode.js';

/**
 * The run status row (tui-scrollbar-edge-and-run-row §3.3): the spinner, the phrase
 * and the `steer / interrupt / exit` clauses on ONE row above the input box.
 * `App` passes it only while a run is in flight AND the idle hint row would have
 * been shown, so enabling it never changes the footer's height.
 */
export interface RunRowProps {
  activity: RunActivity;
  /** The row is in the viewport with no overlay: draw the animated spinner. */
  live: boolean;
  /** Measured by `ScrollViewport` to learn whether the row has scrolled away. */
  rowRef?: React.RefObject<DOMElement>;
}

export interface ComposerProps {
  /** Present only while the run status row replaces the hint row below the input. */
  runRow?: RunRowProps | null;
  cols?: number;
  cursorVisible?: boolean;
  onInteraction?: () => void;
  measureRef?: React.RefObject<DOMElement>;
  /** False while an overlay owns the keyboard (the input is visually blurred). */
  isActive: boolean;
  reducedMotion?: boolean;
  onEscape?: () => void;
  onEscapeDismiss?: () => void;
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
 * The running-state hint as separate clauses, most urgent first.
 *
 * `hintText` joins them (its output is pinned by AC-43), and the run status row
 * consumes the SAME array so it can drop whole clauses from the tail on a narrow
 * terminal instead of cutting `interrupt` in half. One source, two consumers.
 */
export function runningHintClauses(opts: {
  glyphs: ReturnType<typeof pickGlyphs>;
  services: number;
}): string[] {
  const { glyphs, services } = opts;
  const clauses = [`${glyphs.enterKey} steer`, `esc${glyphs.times}2 interrupt`];
  // Confirmation is named even when service controls also need space.
  if (services > 0) clauses.push(`ctrl+c stop ${services}`);
  clauses.push(`ctrl+c${glyphs.times}2 exit`);
  return clauses;
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
  if (running) return runningHintClauses({ glyphs, services }).join(dot);
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

function RunRow({
  runRow, cols, services, agentMode, theme, caps,
}: {
  runRow: RunRowProps;
  cols: number;
  services: number;
  agentMode: AgentMode;
  theme: Theme;
  caps: TermCapabilities;
}): React.ReactElement {
  const glyphs = pickGlyphs(caps);
  const separator = ` ${glyphs.midDot} `;
  const clauses = runningHintClauses({ glyphs, services });
  const plan = planRunRow({
    cols,
    // Spinner glyph + the space after it, then the label.
    labelCols: 2 + stringWidth(resolveActivityLabel(runRow.activity, glyphs)),
    hintClauseCols: clauses.map((clause) => stringWidth(clause)),
    separatorCols: stringWidth(separator),
    chipCols: modeChipCols(agentMode),
  });
  return (
    <Box ref={runRow.rowRef} flexDirection="row" flexShrink={0}>
      <Box width={RUN_ROW_LEAD} flexShrink={0}><Text>{' '}</Text></Box>
      <Box width={plan.labelCols} flexShrink={0}>
        <ActivityLabel {...runRow.activity} spinnerLive={runRow.live} theme={theme} caps={caps} />
      </Box>
      {plan.hintClauses > 0 && (
        <Text wrap="truncate" color={theme.hintFg ?? theme.muted}>
          {separator}{clauses.slice(0, plan.hintClauses).join(separator)}
        </Text>
      )}
      {plan.chip && (
        <>
          <Box flexGrow={1} />
          <ModeChip mode={agentMode} theme={theme} caps={caps} />
        </>
      )}
    </Box>
  );
}

export function Composer({
  runRow,
  cols, cursorVisible, onInteraction, measureRef,
  isActive,
  reducedMotion,
  onEscape,
  onEscapeDismiss,
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
  // While the run row is up it REPLACES the hint row below the input (same row
  // count, so starting a run never moves the layout).
  const runRowActive = running && !!runRow;
  const visible = showHint && hintsEnabled && !runRowActive;

  return (
    <Box ref={measureRef} flexDirection="column" flexShrink={0}>
      {runRowActive && (
        <RunRow
          runRow={runRow}
          cols={cols ?? process.stdout.columns ?? 80}
          services={services}
          agentMode={agentMode}
          theme={theme}
          caps={caps}
        />
      )}
      <PromptInput
        cols={cols}
        cursorVisible={cursorVisible}
        onInteraction={onInteraction}
        isActive={isActive}
        reducedMotion={reducedMotion}
        onEscape={onEscape}
        onEscapeDismiss={onEscapeDismiss}
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
        borderColor={borderColor}
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
