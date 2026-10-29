/**
 * GovernanceBoardOverlay - the read-only `/gov board` overview
 * (governance-mode section 10.5).
 *
 * ASCII ONLY: every symbol comes through `glyphs`.
 *
 * READ-ONLY IS THE SAFETY BOUNDARY, as for the Agents board: nothing here scores, rules
 * or resolves anything. The only side effect is `e`, which asks the owner to copy the
 * `board.md` path.
 *
 * `OverlayFrame` SELF-MANAGED MODE, with this file owning the window. The tab strip must
 * stay put while the rows scroll, which the frame's controlled mode (it windows EVERY row
 * it is given) cannot do; so the body is "one strip row + a window of rows" and the
 * windowing is `sliceWindow` through `boardWindow`, the arithmetic the frame itself uses.
 * `PgUp` / `PgDn` / the wheel arrive through `App`'s `controlled` overlay list as
 * `scrollOffset`; Up/Down and Left/Right are this component's own keys, the same split the
 * Agents board makes.
 *
 * NO `ink-spinner` and no motion prop (spinner-census): this is a reading surface.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Theme } from '../theme.js';
import type { TermCapabilities } from '../capabilities.js';
import { pickGlyphs } from '../glyphs.js';
import { OverlayFrame, overlayBodyRows } from '../layout/OverlayFrame.js';
import {
  boardBodyRows,
  boardHint,
  boardPosition,
  boardWindow,
  buildGovernanceBoardLayout,
  stepTab,
  type BoardTab,
  type GovernanceBoardData,
} from '../layout/governance-board.js';
import { cellWidth } from '../layout/cells.js';
import { GovernanceLine, GovernanceRun } from '../GovernanceRun.js';
import { BOARD_COPIED, BOARD_NO_PATH, BOARD_TITLE } from '../governance-copy.js';
import type { VoiceContext } from '../tool-voice.js';

/** `OverlayFrame`'s own breakpoint, mirrored so the chrome estimate cannot drift. */
const FRAME_BORDERLESS_COLS = 48;

export interface GovernanceBoardOverlayProps {
  /** Persona names for the roster tab. REQUIRED (D-15): a forgotten site is a compile error. */
  voice: VoiceContext;
  /** The board's data, or null when there is no governed run to show. */
  data: GovernanceBoardData | null;
  /** The overlay's FRAME width (`App`'s `viewCols`). */
  cols: number;
  maxRows: number;
  scrollOffset: number;
  onScrollClamp: (offset: number) => void;
  isActive: boolean;
  theme: Theme;
  caps: TermCapabilities;
  /** `e`: copy the board file path. Absent = the key reports the path as unavailable. */
  onCopyPath?: (path: string) => void;
  onNotice?: (level: 'info' | 'warn', text: string) => void;
  initialTab?: BoardTab;
}

export function GovernanceBoardOverlay({
  voice,
  data,
  cols,
  maxRows,
  scrollOffset,
  onScrollClamp,
  isActive,
  theme,
  caps,
  onCopyPath,
  onNotice,
  initialTab = 'roster',
}: GovernanceBoardOverlayProps): React.ReactElement {
  const glyphs = pickGlyphs(caps);
  const [tab, setTab] = useState<BoardTab>(initialTab);

  // The frame spends 4 of `cols` on its border + padding (2 in the narrow rail form), so a
  // board planned against the frame width would lose its last four columns to truncation.
  const contentCols = Math.max(1, cols - (cols >= FRAME_BORDERLESS_COLS ? 4 : 2));
  const layout = buildGovernanceBoardLayout({ cols: contentCols, tab, data, glyphs, voice });
  const height = boardBodyRows(overlayBodyRows(maxRows, cols));
  const window = boardWindow(layout.lines.length, scrollOffset, height);
  const position = boardPosition(window, glyphs);

  useEffect(() => {
    if (window.clamped !== scrollOffset) onScrollClamp(window.clamped);
  }, [window.clamped, scrollOffset, onScrollClamp]);

  // The offset the NEXT key press starts from. A held Down key delivers several presses
  // before React re-renders; stepping from the rendered value would turn three presses
  // into one row of movement.
  const offsetRef = useRef(window.clamped);
  offsetRef.current = window.clamped;

  useInput((input, key) => {
    if (!isActive) return;
    if (key.leftArrow || key.rightArrow) {
      setTab((current) => stepTab(current, key.rightArrow ? 1 : -1));
      offsetRef.current = 0;
      onScrollClamp(0);
      return;
    }
    if (key.upArrow || key.downArrow) {
      offsetRef.current = Math.max(0, offsetRef.current + (key.upArrow ? -1 : 1));
      onScrollClamp(offsetRef.current);
    } else if (input === 'e' || input === 'E') {
      const path = data?.boardPath ?? null;
      if (path === null || onCopyPath === undefined) {
        onNotice?.('warn', BOARD_NO_PATH);
        return;
      }
      onCopyPath(path);
      onNotice?.('info', BOARD_COPIED);
    }
  }, { isActive });

  const visible = layout.lines.slice(window.start, window.start + window.visible);

  return (
    <OverlayFrame
      title={BOARD_TITLE}
      hint={boardHint(contentCols, glyphs)}
      maxRows={maxRows}
      cols={cols}
      theme={theme}
      caps={caps}
    >
      <Box flexDirection="row" height={1} flexShrink={0}>
        <Box flexGrow={1} flexShrink={1} overflow="hidden">
          <GovernanceLine segments={layout.tabStrip.segments} theme={theme} />
        </Box>
        {position !== '' && (
          <Box width={cellWidth(position) + 1} flexShrink={0} justifyContent="flex-end">
            <Text color={theme.muted}>{position}</Text>
          </Box>
        )}
      </Box>
      {visible.map((line) => (
        <GovernanceLine key={line.key} segments={line.segments} theme={theme} />
      ))}
    </OverlayFrame>
  );
}
