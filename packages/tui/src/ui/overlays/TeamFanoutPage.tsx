/**
 * Settings > Team: four arrows-adjustable rows (subagent-fanout 3.4.3, extended
 * by team-command-forced-dispatch §3.9).
 *
 * ASCII ONLY - `src/ui/**` is inside `glyphs.test.ts::inScope`.
 *
 * THE PAGE OWNS ONE PIECE OF STATE: its cursor. Every value comes from
 * `props.view.rows`, which `SettingsScreen` derives from the reducer state - so
 * this page cannot hold a second copy of the draft and then disagree with the
 * root page about what is about to be saved (the discipline
 * `model-profile-state.ts` records at its own head).
 *
 * FOUR ROWS, NOT THREE: `Team mode` moved here from `/team on|off`, because a
 * command that both configures and executes leaves the user unable to predict
 * what it did. The switch is the FIRST row - the other three describe a capability
 * it turns on.
 *
 * IT DOES NOT LISTEN FOR Ctrl+S, AND THE FOOTER SAYS SO (R-P1-13).
 * `useRootSettingsInput` gates its `useInput` on `state.page === 'root'`, so a
 * subpage has no save listener at all - the kit page included. A footer
 * promising "Ctrl+S saves here" would therefore be a lie the user acts on. The
 * honest instruction is the one already in their fingers: Esc back, Ctrl+S on the
 * main page.
 */

import React, { useState } from 'react';
import { Text, useInput } from 'ink';
import { pickGlyphs } from '../glyphs.js';
import { OverlayFrame } from '../layout/OverlayFrame.js';
import { clipProfileText, useProfileScroll, type ProfileFrameProps }
  from './ModelProfilePicker.js';
import type { TeamFanoutField, TeamFanoutView } from './team-fanout-state.js';

/** What the page may ask the screen to change. */
export interface TeamFanoutAction {
  type: 'team-fanout';
  field: TeamFanoutField;
  delta: -1 | 1;
}

interface TeamFanoutPageProps extends ProfileFrameProps {
  view: TeamFanoutView;
  dispatch: (action: TeamFanoutAction) => void;
  /** Esc: back to the settings root. The draft is NOT discarded here. */
  onBack: () => void;
  /**
   * Whether `task` is in this SESSION's tool list (`--no-team` is the false case).
   *
   * OPTIONAL, like every other pass-through on this screen: fixtures build
   * `ProfileFrameProps` by literal, and "absent" honestly means "not disclosed"
   * rather than "registered". When it is `false` and the draft says `on`, the
   * `Team mode` row reads `on (next launch)` - the tool array is immutable, so
   * that is the truth about what saving will achieve (I-7 / AC-9).
   */
  teamRegistered?: boolean;
}

/**
 * Label column, matching the root page's `padEnd(18)` rows above and below this
 * one. `Team mode` is 9 characters and `Max subagents` is 13, so 18 keeps the
 * value column aligned with `Subagent model` on the root page - measured, not
 * guessed.
 */
const LABEL_PAD = 18;

/**
 * The two rows `Enter` toggles, and nothing else (R-P1-12).
 *
 * A stray Return that silently changed a NUMBER is indistinguishable from a bug,
 * and the arrow keys are already the obvious control there.
 */
const TOGGLE_FIELDS: ReadonlySet<TeamFanoutField> = new Set(['enabled', 'overseer']);

export function TeamFanoutPage(props: TeamFanoutPageProps): React.ReactElement {
  const [index, setIndex] = useState(0);
  const rows = props.view.rows;
  const count = Math.max(1, rows.length);
  const cursor = Math.min(index, count - 1);
  const focused = rows[cursor];
  const offset = useProfileScroll(props, cursor);
  const nudge = (delta: -1 | 1): void => {
    if (!focused) return;
    props.dispatch({ type: 'team-fanout', field: focused.field, delta });
  };
  useInput((_input, key) => {
    if (props.isActive === false) return;
    if (key.escape) { props.onBack(); return; }
    if (key.upArrow || (key.tab && key.shift)) {
      setIndex((cursor - 1 + count) % count);
      return;
    }
    if (key.downArrow || key.tab) { setIndex((cursor + 1) % count); return; }
    if (key.leftArrow || key.rightArrow) { nudge(key.leftArrow ? -1 : 1); return; }
    // `Enter` toggles the two boolean rows and does NOTHING on a numeric row.
    if (key.return && focused && TOGGLE_FIELDS.has(focused.field)) nudge(1);
  });
  const lines = rows.map((row) => `${row.label.padEnd(LABEL_PAD)}${row.value}`);
  const glyphs = pickGlyphs(props.caps);
  const body = lines.map((line, at) => (
    <Text key={at} wrap="truncate"
      color={at === cursor ? props.theme.accent : props.theme.muted}>
      {`${at === cursor ? glyphs.caret : ' '} ${clipProfileText(line, props.cols - 8)}`}
    </Text>
  ));
  // The hint explains the FOCUSED row rather than decorating the frame: numbers
  // whose meaning is not obvious ("per dispatch" versus "at once") are the reason
  // this page exists at all.
  if (focused) {
    body.push(<Text key="hint" wrap="truncate" color={props.theme.muted}>
      {clipProfileText(focused.hint, props.cols - 8)}
    </Text>);
  }
  return <OverlayFrame {...props} rows={body} scrollOffset={offset}
    title={props.view.error ?? 'Team'}
    hint="Arrows adjust. Esc goes back; Ctrl+S on the main page saves." />;
}
