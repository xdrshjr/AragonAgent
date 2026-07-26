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
  popupMaxRows?: number;
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
function hintText(
  running: boolean,
  submitCount: number,
  glyphs: ReturnType<typeof pickGlyphs>,
): string {
  const dot = ` ${glyphs.midDot} `;
  if (running) {
    return [`${glyphs.enterKey} steer`, 'esc abort', `ctrl+c${glyphs.times}2 exit`].join(dot);
  }
  if (submitCount >= HINT_FADE_AFTER) return '? help';
  return [
    `${glyphs.enterKey} send`,
    `${glyphs.shiftEnter} newline`,
    '/ commands',
    '@ files',
    '? help',
  ].join(dot);
}

export function Composer({
  isActive,
  running,
  history,
  commands,
  cwd,
  showHint,
  submitCount,
  hintsEnabled,
  popupMaxRows,
  theme,
  caps,
  onSubmit,
  onHelp,
}: ComposerProps): React.ReactElement {
  const [hasDraft, setHasDraft] = useState(false);
  const onDraftChange = useCallback((next: boolean) => setHasDraft(next), []);

  const borderColor = !isActive
    ? theme.toolPending
    : running
    ? theme.toolRunning
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
        onSubmit={onSubmit}
        onHelp={onHelp}
        bordered={{ color: borderColor }}
        onDraftChange={onDraftChange}
      />
      {visible && (
        <Text wrap="truncate" color={theme.hintFg ?? theme.muted}>
          {'  '}
          {hintText(running, submitCount, glyphs)}
        </Text>
      )}
    </Box>
  );
}
