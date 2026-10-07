/** Input border and draft shell. Global action hints and activity live below the viewport. */
import React, { useCallback, useState } from 'react';
import { Box, type DOMElement } from 'ink';
import type { Theme } from './theme.js';
import type { TermCapabilities } from './capabilities.js';
import { pickGlyphs } from './glyphs.js';
import { HINT_FADE_AFTER } from '../config/schema.js';
import type { ComposerSubmitResult } from './composer-input.js';
import { PromptInput, type CommandOption } from './PromptInput.js';
import type { RunActivity } from './run-status-row.js';
import { MODE_LABEL, nextMode, type AgentMode } from '../agent/agent-mode.js';

/** Legacy caller shape retained for source compatibility; Composer no longer mounts it. */
export interface RunRowProps {
  activity: RunActivity;
  /** The row is in the viewport with no overlay: draw the animated spinner. */
  live: boolean;
  /** Measured by `ScrollViewport` to learn whether the row has scrolled away. */
  rowRef?: React.RefObject<DOMElement>;
}

export interface ComposerProps {
  /** Compatibility prop; activity is now rendered by the global StatusBar. */
  runRow?: RunRowProps | null;
  cols?: number;
  deleteDisambiguated?: boolean;
  onCompletionContextChange?: (context: 'none' | 'slash' | 'file') => void;
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
  /** Compatibility prop; submission count no longer hides essential actions. */
  submitCount: number;
  /** Compatibility prop; App owns secondary teaching-hint visibility. */
  hintsEnabled: boolean;
  /** Mirror of the controller's effective mode; drives the border. */
  agentMode: AgentMode;
  /** Compatibility prop; the global action row names the effective mode key. */
  modeToggleKey?: string;
  popupMaxRows?: number;
  popupMaxHeight?: number;
  onPopupRowsChange?: (rows: number) => void;
  /** Rows of newer output below the viewport, forwarded to the input's scroll chip. */
  scrolledLines?: number;
  /** Compatibility prop; the global status and action rows show live services. */
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
  onSubmit: (text: string) => ComposerSubmitResult;
  onHelp?: () => void;
}

/** Legacy helper retained for consumers and contract tests; not rendered by Composer. */
export function runningHintClauses(opts: {
  glyphs: ReturnType<typeof pickGlyphs>;
  services: number;
}): string[] {
  const { glyphs, services } = opts;
  const clauses = [`${glyphs.enterKey} queue`, `esc${glyphs.times}2 interrupt`];
  if (services > 0) clauses.push(`ctrl+c stop ${services}`);
  clauses.push(`ctrl+c${glyphs.times}2 exit`);
  return clauses;
}

/** Compatibility formatter. Product hints use interaction-hints.ts. */
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
  if (running) return runningHintClauses({ glyphs, services }).join(dot);
  const toggle = `${toggleKey} ${MODE_LABEL[nextMode(mode)].toLowerCase()}`;
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

/** Compatibility export for existing hint contract tests. */
export const hintTextForTest = hintText;

export function Composer({
  deleteDisambiguated, onCompletionContextChange,
  cols, cursorVisible, onInteraction, measureRef,
  isActive,
  reducedMotion,
  onEscape,
  onEscapeDismiss,
  running,
  history,
  commands,
  cwd,
  agentMode,
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

  return (
    <Box ref={measureRef} flexDirection="column" flexShrink={0}>
      <PromptInput
        deleteDisambiguated={deleteDisambiguated}
        onCompletionContextChange={onCompletionContextChange}
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
    </Box>
  );
}
