/**
 * The bottom status row — the one already-budgeted row above the composer, now
 * shared by two occupants (agent-activity-presentation §3.2.3 / D-17 / P0-1).
 *
 * THE ACTIVITY LINE IS NOT A NEW `AppShell` SLOT, AND THIS FILE IS WHY.
 *
 * `viewportRows()` (`layout/budget.ts`) is the ONE function that says how many
 * rows the viewport gets, and it enumerates exactly `header + toast + composer +
 * status`. In full-screen `AppShell`'s root is `height={frameHeight(rows)}` with
 * `overflow="hidden"`, the bottom chrome box is `flexShrink={0}` and the viewport
 * box is its only `flexShrink={1}` child — so an extra chrome row does not make
 * the frame taller, Yoga takes the row out of the TRANSCRIPT. Meanwhile
 * `viewportRows()` keeps returning the old number to `ScrollViewport`,
 * `selectWindow`'s spacers, `overlayMaxRows`, `popupMaxRows` and `todoRailRows`.
 * The transcript would draw one row shorter than every consumer believes, ONLY
 * WHILE A RUN IS IN FLIGHT, so the layout would shift on submit and shift back on
 * `agent_end`.
 *
 * `ToastStack.tsx` already legislates this for itself: *"in `fullscreen` this
 * ALWAYS occupies exactly one row — an empty row when there is nothing to say.
 * Rendering conditionally would make the viewport height (and therefore the whole
 * transcript) jump every time a toast appears or expires."* A run starts and ends
 * far more often than a toast appears and expires, so the activity line is the
 * STRONGER case for that rule, not an exception to it.
 *
 * Sharing the row means `budget.ts` and `AppShell.tsx` come out of this round
 * UNMODIFIED — and `budget.test.ts` asserts that they did (AC-8a, DoD #8).
 *
 * PRECEDENCE: toast > activity > update > blank. A toast wins because a
 * transient ack is a RESPONSE TO THE USER, and the row nearest the input belongs
 * to it. The update line is LAST because it is the only one of the three that is
 * PERSISTENT (cli-auto-update D-2): it loses nothing by waiting for the run to
 * end, whereas an activity line deferred is an activity line that never renders.
 * That also means a user who is actively working never sees the updater at all
 * until they stop, which is the whole of the silence requirement.
 *
 * THE TOAST TAKES THE ROW BUT NOT THE SPINNER
 * (`activity-spinner-vanishes-behind-toast`). "Toast wins" used to mean the
 * activity line was never mounted while an ack was up — and because `App`
 * suppresses the other seven animated sites for exactly as long as it BELIEVES
 * this row is showing one, a mid-run toast left the whole frame with ZERO
 * animations for its 2.5 s TTL, indistinguishable from a hung process. Steering
 * and plan approval both ack mid-run, so a long run hit it repeatedly.
 *
 * The row still belongs to the toast: the spinner joins it as a bare glyph, no
 * phrase and no clock, so `bottom-status-row.test.tsx`'s "the ack keeps its
 * words" assertion and the toast's own width are both untouched. A row-direction
 * box holding two one-row children is STILL ONE ROW, which is what the note
 * above actually forbids disturbing — `budget.ts` and `AppShell.tsx` stay out of
 * it. And because the glyph is mounted under precisely the condition `App` uses
 * to suppress the others, "the line is up" and "every other site is still" agree
 * again by construction rather than by enumeration of what can pre-empt the row.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { Theme } from './theme.js';
import type { Toast } from '../agent/reducer.js';
import type { RenderMode } from './layout/frame.js';
import { ToastStack } from './ToastStack.js';

export interface BottomStatusRowProps {
  mode: RenderMode;
  toasts: Toast[];
  /** `<ActivityLine>` while a run owns the screen, else `null`. */
  activity: React.ReactNode;
  /**
   * The bare animated spinner (`liveSpinner`), or `null` when it would be a
   * STATIC glyph — an ASCII terminal, or `reducedMotion`.
   *
   * IT IS NOT A SECOND MOUNT CONDITION. `activity` alone decides whether a life
   * signal belongs on this row; this prop only says which FORM the signal takes,
   * and it is read only when `activity` is non-null. So a caller cannot make the
   * two disagree, which is the failure mode that produced this prop.
   *
   * `null` means PREFIX NOTHING, not "prefix the still glyph". A static `·` in
   * front of every toast would be a visible change to ASCII terminals and to
   * users who asked for stillness — neither of whom ever had the dead-frame bug,
   * and both of whom must come out byte-identical.
   */
  activityGlyph?: React.ReactElement | null;
  /**
   * `<UpdateLine>` when the updater has something to say, else `null` — AND THE
   * CALLER DECIDES WHICH (C-15 / cli-auto-update P0-1).
   *
   * `if (update)` below tests a REACT ELEMENT, and an element whose own render
   * returns `null` is still truthy: that branch would emit a box of ZERO rows,
   * the frame would keep its fixed height, Yoga would hand the row to the
   * transcript, and `viewportRows()` would go on reporting the old number to
   * five consumers. So `UpdateLine` is typed `React.ReactElement` and `App`
   * gates it with `shouldRenderUpdateLine(snapshot)`.
   *
   * OPTIONAL, because `bottom-status-row.test.tsx` and the `App.tsx` fixtures
   * construct this component without it and the test tree is inside
   * `tsconfig.test.json` (`typecheck-scope.test.ts`); a required prop turns
   * `npm run typecheck` red for a reason unrelated to this feature (P2-1).
   */
  update?: React.ReactNode;
  theme: Theme;
}

export function BottomStatusRow({
  mode,
  toasts,
  activity,
  activityGlyph,
  update,
  theme,
}: BottomStatusRowProps): React.ReactElement | null {
  // A toast wins the row outright — but a run in flight keeps its spinner on it.
  if (toasts.length > 0) {
    const spinner = activity ? activityGlyph : null;
    // Byte-identical to the old branch whenever there is no live spinner to
    // carry: no run, an ASCII terminal, or `reducedMotion`.
    if (!spinner) return <ToastStack toasts={toasts} theme={theme} mode={mode} />;
    const fullscreen = mode === 'fullscreen';
    return (
      // `flexDirection` SPELLED OUT even though `row` is Yoga's default: it is
      // what keeps two children on ONE row, and the header above turns on that
      // being true. Left implicit, it reads as an oversight next to the child
      // below that declares `column` — and "make them match" is a one-word edit
      // that doubles the row, takes it from the transcript, and desynchronises
      // every `viewportRows()` consumer without failing a type or a lint.
      <Box flexDirection="row" flexShrink={0}>
        {/*
          `ToastStack` opens its FULL-SCREEN row with a leading space and its
          INLINE rows without one, and it indents the inline stack by a blank
          row (`marginTop`). The prefix mirrors both, so each mode's toast keeps
          the left edge and the vertical position it already had and only gains
          ` ⠋ ` in front of its glyph.
        */}
        <Box flexShrink={0} marginTop={fullscreen ? 0 : 1}>
          <Text color={theme.thinking}>
            {fullscreen ? ' ' : ''}
            {spinner}
            {fullscreen ? '' : ' '}
          </Text>
        </Box>
        {/*
          The toast keeps the REST of the row, and the wrapper is a COLUMN on
          purpose. `ToastStack`'s own box is `flexShrink={0}`: dropped straight
          into a row it is sized by its own content on the MAIN axis, so a long
          ack keeps its full intrinsic width, `wrap="truncate"` has nothing to
          truncate against, and the text is clipped by the frame edge with no
          ellipsis instead of ending in one (measured: 100 cols of `x` and no
          `…`). Inside a column, width is the CROSS axis, `flexShrink` does not
          apply to it, and the stack stretches to the width `flexGrow` won here —
          which is what `wrap="truncate"` reads.
        */}
        <Box flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">
          <ToastStack toasts={toasts} theme={theme} mode={mode} />
        </Box>
      </Box>
    );
  }
  // Inline has no frame and therefore nothing to protect: `ToastStack`'s inline
  // branch is already a conditional 0-3 row stack, and these are simply one more
  // conditional row above it.
  if (activity) return <Box flexShrink={0}>{activity}</Box>;
  if (update) return <Box flexShrink={0}>{update}</Box>;
  // The blank full-screen row that IS the budget must keep being emitted.
  return <ToastStack toasts={toasts} theme={theme} mode={mode} />;
}
