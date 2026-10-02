/**
 * The update line (cli-auto-update section 6.2) - the THIRD occupant of the
 * already-budgeted bottom row, after the toast stack and the activity line.
 *
 * ONE ROW, ALWAYS, AND NEVER `null` (C-15 / P0-1 / D-19). The return type is
 * `React.ReactElement` rather than `React.ReactElement | null`, so the compiler
 * refuses the shortcut: `BottomStatusRow` decides presence with `if (update)`,
 * which tests a REACT ELEMENT, and an element whose render returns `null` is
 * still truthy. Taking that branch would emit a box of ZERO rows - the frame
 * keeps its fixed height, Yoga hands the row to the transcript, and
 * `viewportRows()` goes on reporting the old number to `ScrollViewport`,
 * `selectWindow`, `overlayMaxRows`, `popupMaxRows` and `buildTodoRailLayout`. The
 * transcript would gain a row while the updater is idle and lose it the moment
 * it has news. Presence is the CALLER's decision, through
 * `shouldRenderUpdateLine`, exactly as `App.tsx` already decides the activity
 * line's with `running && !overlayNode`.
 *
 * PURE: a function of `snapshot + compact + theme + caps`. No state, no timer,
 * no clock. `<Text wrap="truncate">` so a narrow terminal degrades by truncation
 * rather than by wrapping into a second row the fixed frame cannot afford.
 *
 * ASCII ONLY, and every user-visible character comes from `pickGlyphs(caps)`
 * (C-3). No literal `...`, `+` or `~` may be spelled inline - `ActivityLine`'s
 * routing of even the ellipsis through `pickGlyphs` is the precedent.
 *
 * `compact` RATHER THAN `cols` (IF-1). Section 6.2 describes the width tiers in
 * terms of `cols`, but resolving them here would mean importing
 * `UPDATE_LIMITS.statusCompactCols` - a VALUE - from `update/`, and section 3.1
 * rule 1 requires this module's only edge into that tree to be erasable by tsc.
 * The caller owns `UPDATE_LIMITS` already (it computes presence from it), so it
 * resolves the threshold too. Same rule as presence: the call site decides.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { Theme } from './theme.js';
import type { TermCapabilities } from './capabilities.js';
import { pickGlyphs } from './glyphs.js';
import type { UpdateSnapshot } from '../update/types.js';

export interface UpdateLineProps {
  snapshot: UpdateSnapshot;
  /** `cols < UPDATE_LIMITS.statusCompactCols`, resolved by the caller. */
  compact: boolean;
  theme: Theme;
  caps: TermCapabilities;
}

interface Rendered {
  glyph: string;
  text: string;
  color: string | undefined;
}

export function UpdateLine({ snapshot, compact, theme, caps }: UpdateLineProps): React.ReactElement {
  const glyphs = pickGlyphs(caps);
  const version = snapshot.latestVersion ?? snapshot.currentVersion;
  const advice = snapshot.advice ?? '';
  const dot = glyphs.midDot;

  const line = ((): Rendered | null => {
    if (snapshot.phase === 'installing') {
      return {
        glyph: glyphs.arrowUp,
        text: compact
          ? `${version}${glyphs.ellipsis}`
          : `updating to ${version}${glyphs.ellipsis}`,
        color: theme.muted,
      };
    }

    if (snapshot.phase === 'ready') {
      return {
        glyph: glyphs.check,
        text: compact ? `${version} ready` : `${version} installed ${dot} restart aragon to apply`,
        color: theme.toast.success,
      };
    }

    if (snapshot.phase === 'failed') {
      // H2's three classified failures (cli-auto-update-hardening section 8).
      // Each names the REAL obstacle rather than the generic one, because each
      // is allowed to break the three-strike silence and a notice that breaks
      // silence must be worth the interruption.
      if (snapshot.reason === 'blocked-by-os') {
        // `npm i -g` FROM THE SAME SHELL HITS THE SAME HANDLE. On Windows the
        // shim that launched us is being read by the `cmd.exe` running it for
        // as long as our process lives, and npm's install rewrites that shim -
        // so the generic advice is not merely unhelpful here, it is a wrong
        // instruction (R-3 / section 5.3.1).
        return {
          glyph: glyphs.warn,
          text:
            compact || !advice
              ? 'update blocked'
              : `update blocked ${dot} close other aragon windows, then: ${advice}`,
          color: theme.noticeWarn,
        };
      }
      if (snapshot.reason === 'no-space') {
        return {
          glyph: glyphs.warn,
          text: compact ? 'no disk space' : `update failed ${dot} no disk space`,
          color: theme.noticeWarn,
        };
      }
      if (snapshot.reason === 'not-writable') {
        return {
          glyph: glyphs.warn,
          text:
            compact || !advice
              ? 'update blocked'
              : `update needs write access ${dot} ${advice}`,
          color: theme.noticeWarn,
        };
      }
      return {
        glyph: glyphs.warn,
        text: compact || !advice ? 'update failed' : `update failed ${dot} ${advice}`,
        color: theme.noticeWarn,
      };
    }

    if (snapshot.phase === 'available') {
      if (snapshot.reason === 'node-too-old') {
        // Both numbers or neither: "needs a newer Node" without saying which is
        // a notice the user cannot act on.
        const detail =
          snapshot.requiredNode && snapshot.runningNode
            ? `${version} needs Node ${snapshot.requiredNode} (running ${snapshot.runningNode})`
            : `${version} needs a newer Node`;
        return {
          glyph: glyphs.warn,
          text: compact ? 'needs newer Node' : detail,
          color: theme.noticeWarn,
        };
      }
      if (snapshot.reason === 'install-ineffective') {
        return {
          glyph: glyphs.warn,
          text: compact
            ? 'check npm prefix'
            : `${version} installed elsewhere${advice ? ` ${dot} ${advice}` : ''}`,
          color: theme.noticeWarn,
        };
      }
      return {
        glyph: glyphs.arrowUp,
        text: compact
          ? version
          : `${version} available${advice ? ` ${dot} ${advice}` : ''}`,
        color: theme.muted,
      };
    }

    // H1's rollback notice, and it goes HERE rather than in a phase branch
    // (cli-auto-update-hardening section 8 / P0-1). It is true for a whole
    // SESSION rather than for a phase, so `shouldRenderUpdateLine` decides its
    // presence from `snapshot.rolledBackFrom` outside `phase` entirely - and the
    // phases that leaves are exactly `idle` / `checking`, which is this
    // fallthrough. An earlier draft put it in the `failed` / `available`
    // branches and keyed it on phase `idle`, a phase neither branch handles;
    // three independent suppressions, so the one line telling a user their CLI
    // had been silently downgraded could never have appeared.
    //
    // NOT `version` ABOVE: that is `latestVersion ?? currentVersion`, and after
    // a rollback `latestVersion` may well be the BAD release we just escaped.
    if (snapshot.rolledBackFrom) {
      const to = snapshot.rolledBackTo ?? snapshot.currentVersion;
      return {
        glyph: glyphs.warn,
        text: compact
          ? 'rolled back'
          : `rolled back to ${to} after ${snapshot.rolledBackFrom} failed to start`,
        color: theme.noticeWarn,
      };
    }

    // `idle` / `checking`, and a `failed` below the notice threshold. The CALLER
    // never mounts us here (`shouldRenderUpdateLine` is false), but the row must
    // still be exactly one row if it ever is - the same blank-row discipline
    // `ToastStack` applies to its own budgeted row.
    return null;
  })();

  if (!line) {
    return (
      <Box flexShrink={0}>
        <Text> </Text>
      </Box>
    );
  }

  return (
    <Box flexShrink={0}>
      <Text wrap="truncate" color={line.color}>
        {' '}
        {line.glyph} {line.text}
      </Text>
    </Box>
  );
}
