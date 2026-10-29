/**
 * AgentsBoardOverlay — the read-only detail board behind `Ctrl+B` / `/agents`
 * (tui-subagent-panel §4.4 / §6.3).
 *
 * READ-ONLY IS THE SAFETY BOUNDARY (§2.2). Nothing here nudges, kills or re-dispatches
 * a child, and no new `TeamEvent` member was introduced to feed it: a board that can
 * only read can never kill a healthy child, which is the whole reason this is a
 * second surface rather than a control panel.
 *
 * ONE SCREEN, CONTROLLED MODE. `OverlayFrame`'s controlled form already owns paging,
 * the position indicator and the narrow-terminal degradation, and `helpRows` /
 * `projectQueueRows` are the precedent. A second pane would mean a second horizontal
 * budget inside Ink for a benefit the board's 2-up field rows already deliver.
 *
 * IT DOES NOT GO BLANK WHEN THE DISPATCH ENDS (D-9). `state.team` becomes `null` the
 * frame the dispatch settles, and a reader would lose the child they were reading
 * about at the exact moment they wanted the post-mortem. The last live snapshot is
 * therefore FROZEN (a copy, held in a ref) and keeps rendering with a
 * `dispatch ended` row; a board opened AFTER the dispatch has ended builds from the
 * transcript's settled `team` entry instead (`resolveBoardSource`), which is where the
 * `result` section earns its place - the error is the one fact that is never stripped.
 *
 * NO `ink-spinner` HERE (D-13): `spinner-census.test.ts` pins the exact list of files
 * that mount an animated spinner, and this is a reading surface, not an animation.
 * The panel is where motion belongs.
 *
 * AND NO MOTION PROP (v2 implementation note, appended to the spec's
 * "implementation findings"). Because nothing here animates, a motion flag would be a
 * prop with no consumer - and worse, the same census counts how many times `App.tsx`
 * hands the RAW motion flag to a child and asserts the count is EXACTLY ONE, so passing
 * it from the board's branch would break a shipped guard rail for no gain.
 *
 * ASCII ONLY: every symbol comes through `glyphs`.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Text, useInput } from 'ink';
import type { Entry } from '../../model/agent/reducer.js';
import type { Theme } from '../theme.js';
import type { TermCapabilities } from '../capabilities.js';
import { pickGlyphs } from '../glyphs.js';
import { OverlayFrame } from '../layout/OverlayFrame.js';
import {
  buildAgentBoardRows,
  resolveBoardSource,
  resolveSelection,
  type BoardRow,
  type BoardSource,
} from '../layout/agents-board.js';
import type { TeamSnapshot } from '../../model/team/types.js';
import type { VoiceContext } from '../tool-voice.js';

/** `OverlayFrame`'s own breakpoint, mirrored so the chrome estimate cannot drift. */
const FRAME_BORDERLESS_COLS = 48;

/**
 * Close a frozen live snapshot: the dispatch it described has ended.
 *
 * `durationMs` is derived from the LAST frame the snapshot was live, so the board's
 * summary shows the dispatch's real total instead of a clock that keeps running against
 * a dispatch nobody can see any more. When the snapshot never had a `startedAt` there is
 * nothing to derive and the field stays absent - the LIVE-ONLY rule turns that into an
 * empty clock cell rather than an invented number (§4.4.2).
 */
function settleFrozen(frozen: { source: BoardSource; at: number }): BoardSource {
  const { source, at } = frozen;
  const total = source.startedAt === undefined ? undefined : Math.max(0, at - source.startedAt);
  return {
    ...source,
    active: false,
    ...(total !== undefined ? { durationMs: total } : {}),
  };
}

export interface AgentsBoardOverlayProps {
  /** Names and wording; bound to the shown dispatch's scope by the row builder. */
  voice: VoiceContext;
  /** The live snapshot; `null` once the dispatch has settled. */
  team: TeamSnapshot | null;
  /** The transcript, for the settled fallback (D-9 path 4). */
  entries: readonly Entry[];
  /** Overlay content width (`App`'s `viewCols`). */
  cols: number;
  maxRows: number;
  scrollOffset: number;
  onScrollClamp: (offset: number) => void;
  isActive: boolean;
  native: boolean;
  theme: Theme;
  caps: TermCapabilities;
  /** Injectable clock, so the board's tests do not depend on wall time. */
  now?: number;
}

/** Palette slot -> theme colour. One place, so a tone can never be spelled twice. */
function toneColor(tone: BoardRow['tone'], theme: Theme): string | undefined {
  switch (tone) {
    case 'accent':
      return theme.accent;
    case 'primary':
      return theme.primary;
    case 'muted':
      return theme.muted;
    case 'warn':
      return theme.noticeWarn;
    case 'error':
      return theme.noticeError;
    case 'done':
      return theme.toolDone;
    case 'hint':
      return theme.hintFg;
  }
}

export function AgentsBoardOverlay({
  voice,
  team,
  entries,
  cols,
  maxRows,
  scrollOffset,
  onScrollClamp,
  isActive,
  native,
  theme,
  caps,
  now,
}: AgentsBoardOverlayProps): React.ReactElement {
  const glyphs = pickGlyphs(caps);
  const at = now ?? Date.now();
  const [selectedLabel, setSelectedLabel] = useState<string | null>(null);
  /**
   * THE FROZEN SNAPSHOT (D-9), plus the clock reading it was frozen at.
   *
   * A ref rather than state on purpose: it is written from an effect that must not
   * trigger a render of its own, and reading it during the render that FIRST sees
   * `team === null` is what keeps the board from blinking empty for one frame. The
   * timestamp is kept WITH the snapshot because a frozen live source still says
   * `active: true` - it was live when it was copied - and a board that kept believing
   * that would never show its `dispatch ended` row nor stop its clock.
   */
  const frozen = useRef<{ source: BoardSource; at: number } | null>(null);

  const live = team === null ? null : resolveBoardSource({ team, entries });
  useEffect(() => {
    if (live !== null) frozen.current = { source: live, at };
  }, [live, at]);

  // PRIORITY: live > frozen > the most recent settled entry (§4.4.5). The frozen copy
  // only ever takes over on the frame the live snapshot disappears, and a NEW dispatch
  // overwrites it on its own first frame, so the two paths cannot both be active.
  //
  // A FROZEN SOURCE IS SETTLED, and it is closed here rather than at the moment of
  // copying: `active: false` is what draws `dispatch ended` (task AC-17), and taking
  // `durationMs` from the freeze instant stops the clock at the dispatch's real end
  // instead of letting it count up forever from a snapshot that no longer exists.
  const frozenSource = frozen.current === null ? null : settleFrozen(frozen.current);
  const source = live ?? frozenSource ?? resolveBoardSource({ team: null, entries });
  const selected = source === null ? null : resolveSelection(source.runs, selectedLabel);

  /**
   * UP/DOWN MOVES THE CHILD CURSOR, and a change of child RESETS the scroll.
   *
   * `agents` deliberately does NOT join `App`'s row-scroll set (`help | plan | queue`):
   * the same trade `settings` makes with its field cursor, where Up/Down is worth more
   * as navigation than as a six-row scroll. `PgUp` / `PgDn` / the wheel still page the
   * board through `App`'s `controlled` set, so no reading gesture is lost.
   */
  const move = useCallback((delta: number): void => {
    const runs = source?.runs ?? [];
    if (runs.length === 0) return;
    const current = resolveSelection(runs, selectedLabel);
    const index = current === null ? -1 : runs.findIndex((run) => run.label === current.label);
    const next = runs[Math.min(runs.length - 1, Math.max(0, index + delta))];
    if (next === undefined || next.label === current?.label) return;
    setSelectedLabel(next.label);
    // The documented semantic of this port is "the offset should now be 0" (§6.3).
    onScrollClamp(0);
  }, [onScrollClamp, selectedLabel, source]);

  useInput((_input, key) => {
    if (!isActive) return;
    if (key.upArrow) move(-1);
    else if (key.downArrow) move(1);
  }, { isActive });

  // THE FRAME'S CHROME IS NOT FREE (v2 implementation note). `cols` arrives as the
  // overlay's FRAME width (`App`'s `viewCols`), and `OverlayFrame` spends 4 of those
  // columns on its border plus `paddingX={1}` (2 in the narrow rail form, which drops
  // the right border and the right padding). A board laid out against the frame width
  // therefore has its LAST four columns eaten by Ink's truncation - which lands exactly
  // on the right-anchored figures this board exists to align. `helpRows` gets away with
  // it because its rows are prose; these are a table.
  const contentCols = Math.max(1, cols - (cols >= FRAME_BORDERLESS_COLS ? 4 : 2));

  const rows: BoardRow[] = source === null
    ? [{
      key: 'empty',
      kind: 'hint',
      text: 'No subagent dispatch yet.',
      tone: 'muted',
    }]
    : buildAgentBoardRows({
      source,
      cols: contentCols,
      now: at,
      selectedLabel: selected?.label ?? null,
      glyphs,
      native,
      voice,
    });

  // The `dispatch ended` banner is a ROW rather than a title swap: the title is the
  // frame's own ("Agents"), and replacing it would hide which screen the reader is on.
  const endedRow: BoardRow[] = source !== null && !source.active
    ? [{
      key: 'ended',
      kind: 'hint',
      text: `dispatch ended ${glyphs.midDot} Esc to close`,
      tone: 'warn',
    }]
    : [];

  const elements = [...endedRow, ...rows].map((row) => (
    <Text key={row.key} wrap="truncate"
      color={toneColor(row.tone, theme)}
      {...(row.kind === 'section' ? { bold: true } : {})}>
      {row.text}
    </Text>
  ));

  // THE HINT SHRINKS WITH THE FRAME. `OverlayFrame` prints the hint as one unwrapped
  // row, so a 41-column hint inside a 30-column frame makes the FRAME 41 wide - the
  // board would overflow the terminal and take the overlay's border with it.
  const hint = contentCols >= 60
    ? `Esc close ${glyphs.midDot} Up/Down child ${glyphs.midDot} PgUp/PgDn scroll`
    : contentCols >= 30
      ? `Esc close ${glyphs.midDot} Up/Down child`
      : 'Esc close';

  return (
    <OverlayFrame
      title="Agents"
      hint={hint}
      maxRows={maxRows}
      cols={cols}
      rows={elements}
      scrollOffset={scrollOffset}
      onScrollClamp={onScrollClamp}
      theme={theme}
      caps={caps}
    />
  );
}
