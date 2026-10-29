/**
 * GovernancePanel - the legion panel (governance-mode section 10.3).
 *
 * ASCII ONLY: every glyph comes from `pickGlyphs`, through the layout.
 *
 * THIS COMPONENT ONLY COLOURS AND PLACES. Every decision - which tier, which columns, how
 * wide, what each cell says, which row is hidden - was made by
 * `layout/governance-panel.ts`, and the `layout` prop is REQUIRED: `App` builds it once to
 * learn the panel's height (the native band and the TODO rail both budget against it) and
 * hands the very same object here, so the number that decides whether the panel mounts is
 * the number it is drawn from. A panel that re-planned itself could draw a taller tier than
 * the one the band reserved, and the band clips the overflow in silence.
 *
 * IT REPLACES `TeamPanel` WHILE A GOVERNED STAGE RUNS (D-17), it does not stack with it:
 * the repo has been bitten by a "double roster" once (tui-subagent-double-roster), and a
 * governed dispatch is the one case where two live rosters would be the same children
 * listed twice.
 *
 * NO `ink-spinner` HERE, on purpose. While a governed stage runs the lead's turn is
 * running, the activity row owns the one spinner (single-spinner-while-running), and every
 * panel is handed the widened reduced-motion signal anyway - an animation here would never
 * play. The working marker is `statusGlyph(...)`, and `reducedMotion` is the USER's
 * preference: it only decides whether a score change flashes for four seconds or stays put.
 *
 * COLUMNS ARE FIXED-WIDTH BOXES with exactly one elastic cell (`governance-roster.ts`), the
 * lesson `TeamPanel` records at length: a flex-grown column under a fixed-height parent
 * stretches to its widest child and the cells to its right lose their offsets.
 */

import React, { useRef } from 'react';
import { Box, Text } from 'ink';
import type { GovernanceSnapshot } from '../model/governance/types.js';
import type { Theme } from './theme.js';
import type { TermCapabilities } from './capabilities.js';
import { pickGlyphs } from './glyphs.js';
import { trackEliminated, type EliminatedSince } from './governance-status.js';
import { GovernanceLine, GovernanceRun } from './GovernanceRun.js';
import {
  PANEL_MARGIN_CELLS,
  type RosterCell,
  type RosterLine,
} from './layout/governance-roster.js';
import type { GovernancePanelLayout, PanelLine } from './layout/governance-panel.js';

/**
 * The first-seen-eliminated map, kept across snapshots so a replaced member shows its
 * `replaced by ...` note for exactly one phase. Reset when the run changes or ends.
 *
 * A ref written during render is acceptable here because the write is idempotent
 * (`trackEliminated` returns the same object when nothing is new) and no other component
 * reads the ref - `App` reads only the returned value.
 */
export function useEliminatedSince(snapshot: GovernanceSnapshot | null): EliminatedSince {
  const ref = useRef<{ runId: string | null; since: EliminatedSince }>({ runId: null, since: {} });
  if (snapshot === null) {
    if (ref.current.runId !== null) ref.current = { runId: null, since: {} };
    return ref.current.since;
  }
  const base = ref.current.runId === snapshot.runId ? ref.current.since : {};
  ref.current = { runId: snapshot.runId, since: trackEliminated(base, snapshot) };
  return ref.current.since;
}

function Margin(): React.ReactElement {
  return (
    <Box width={PANEL_MARGIN_CELLS} flexShrink={0}>
      <Text> </Text>
    </Box>
  );
}

function LineView({ line, theme }: { line: PanelLine; theme: Theme }): React.ReactElement {
  return (
    <Box flexDirection="row" width="100%" height={1} flexShrink={0} overflow="hidden">
      <Margin />
      <Box flexGrow={1} flexShrink={1} overflow="hidden">
        <GovernanceLine segments={line.left} theme={theme} />
      </Box>
      {line.rightCells > 0 && (
        <Box width={line.rightCells} flexShrink={0} justifyContent="flex-end">
          <GovernanceLine segments={line.right} theme={theme} />
        </Box>
      )}
    </Box>
  );
}

function CellView({ cell, theme }: { cell: RosterCell; theme: Theme }): React.ReactElement {
  const content = <GovernanceLine segments={cell.segments} theme={theme} />;
  if (cell.elastic) {
    return <Box flexGrow={1} flexShrink={1} overflow="hidden">{content}</Box>;
  }
  return (
    <Box
      width={cell.width}
      flexShrink={0}
      overflow="hidden"
      justifyContent={cell.align === 'right' ? 'flex-end' : 'flex-start'}
    >
      {content}
    </Box>
  );
}

function RosterView({ line, theme }: { line: RosterLine; theme: Theme }): React.ReactElement {
  return (
    <Box flexDirection="row" width="100%" height={1} flexShrink={0} overflow="hidden">
      <Margin />
      {line.cells.map((cell) => (
        <CellView key={cell.key} cell={cell} theme={theme} />
      ))}
    </Box>
  );
}

export interface GovernancePanelProps {
  /** Built by `buildGovernancePanelLayout`; the SAME object `App` read the height from. */
  layout: GovernancePanelLayout;
  theme: Theme;
  caps: TermCapabilities;
}

export function GovernancePanel(
  { layout, theme, caps }: GovernancePanelProps,
): React.ReactElement | null {
  if (layout.height === 0 || layout.header === null) return null;
  const glyphs = pickGlyphs(caps);
  const rule = layout.ruleCells > 0 ? (
    <Box flexDirection="row" width="100%" height={1} flexShrink={0} overflow="hidden">
      <Margin />
      <Text wrap="truncate" color={theme.border}>{glyphs.hrule.repeat(layout.ruleCells)}</Text>
    </Box>
  ) : null;
  return (
    <Box flexDirection="column" width="100%" flexShrink={0}>
      <LineView line={layout.header} theme={theme} />
      {layout.pipeline !== null && <LineView line={layout.pipeline} theme={theme} />}
      {rule}
      {layout.rosterRows.map((line) => (
        <RosterView key={line.key} line={line} theme={theme} />
      ))}
      {layout.overflow !== null && (
        <Box flexDirection="row" width="100%" height={1} flexShrink={0} overflow="hidden">
          <Margin />
          <Text wrap="truncate" color={theme.muted}>{layout.overflow}</Text>
        </Box>
      )}
      {rule}
      {layout.ticker.map((line, index) => (
        <LineView key={`ticker-${index}`} line={line} theme={theme} />
      ))}
    </Box>
  );
}
