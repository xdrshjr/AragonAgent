/**
 * Settings > Governance: eleven arrows-adjustable rows (governance-mode-v1-1 5, closing
 * governance-mode IF-13).
 *
 * ASCII ONLY - `src/ui/**` is inside `glyphs.test.ts::inScope`.
 *
 * THIS IS `TeamFanoutPage` WITH A DIFFERENT TABLE, ON PURPOSE. Every defence that page
 * carries was paid for by a real defect, so each one is inherited verbatim:
 *
 *  - THE PAGE OWNS ONE PIECE OF STATE, its cursor. Every value comes from `props.view.rows`,
 *    which `SettingsScreen` derives from the reducer; a second copy of the draft here could
 *    disagree with the root page about what Ctrl+S is about to save.
 *  - `Enter` TOGGLES THE SWITCH ROWS AND DOES NOTHING ON A NUMBER (R-P1-12). A stray Return
 *    that silently changed a number is indistinguishable from a bug, and the arrow keys are
 *    already the obvious control there.
 *  - IT DOES NOT LISTEN FOR Ctrl+S, AND THE FOOTER SAYS SO (R-P1-13). `useRootSettingsInput`
 *    gates its `useInput` on `state.page === 'root'`, so a subpage has no save listener at
 *    all; a footer promising "Ctrl+S saves here" would be a lie the user acts on.
 *
 * THE RESTART NOTE IS THE ONE THING THIS PAGE ADDS. `enabled` is a REGISTRATION key: the tool
 * array is fixed when the session is built, so flipping it here changes the file and the
 * next launch, not this session. The note sits under that row so the consequence is read
 * where the choice is made.
 */

import React, { useState } from 'react';
import { Text, useInput } from 'ink';
import { pickGlyphs } from '../glyphs.js';
import { OverlayFrame } from '../layout/OverlayFrame.js';
import { clipProfileText, useProfileScroll, type ProfileFrameProps }
  from './ModelProfilePicker.js';
import type { GovernanceSettingKey, GovernanceSettingRow } from './governance-settings.js';

/** What the page may ask the screen to change. */
export interface GovernanceSettingsAction {
  type: 'governance-step';
  key: GovernanceSettingKey;
  delta: -1 | 1;
}

export interface GovernanceSettingsView {
  /** Exactly eleven, in the fixed order the cursor indexes. */
  rows: GovernanceSettingRow[];
  error?: string;
  /** Shown under the first row; `null` when the draft agrees with this session. */
  restartNote: string | null;
}

interface GovernanceSettingsPageProps extends ProfileFrameProps {
  view: GovernanceSettingsView;
  dispatch: (action: GovernanceSettingsAction) => void;
  /** Esc: back to the settings root. The draft is NOT discarded here. */
  onBack: () => void;
}

/** Matches the root page's `padEnd(18)` rows so the value column lines up (measured). */
const LABEL_PAD = 18;

/** The rows `Enter` flips, and nothing else (R-P1-12). */
const TOGGLE_KEYS: ReadonlySet<GovernanceSettingKey> = new Set<GovernanceSettingKey>([
  'enabled',
  'shiftTab',
  'panel',
  'confirmCharter',
]);

export function GovernanceSettingsPage(props: GovernanceSettingsPageProps): React.ReactElement {
  const [index, setIndex] = useState(0);
  const rows = props.view.rows;
  const count = Math.max(1, rows.length);
  const cursor = Math.min(index, count - 1);
  const focused = rows[cursor];
  const note = props.view.restartNote;
  // The note is one extra LINE after row 0, so every later row sits one line lower.
  const offset = useProfileScroll(props, cursor + (note !== null && cursor > 0 ? 1 : 0));
  const nudge = (delta: -1 | 1): void => {
    if (focused) props.dispatch({ type: 'governance-step', key: focused.key, delta });
  };
  const handleKey = (key: Parameters<Parameters<typeof useInput>[0]>[1]): void => {
    if (key.escape) { props.onBack(); return; }
    if (key.upArrow || (key.tab && key.shift)) { setIndex((cursor - 1 + count) % count); return; }
    if (key.downArrow || key.tab) { setIndex((cursor + 1) % count); return; }
    if (key.leftArrow || key.rightArrow) { nudge(key.leftArrow ? -1 : 1); return; }
    // `Enter` toggles the switch rows and does NOTHING on a numeric or choice row.
    if (key.return && focused && TOGGLE_KEYS.has(focused.key)) nudge(1);
  };
  useInput((_input, key) => {
    if (props.isActive === false) return;
    handleKey(key);
  });
  const glyphs = pickGlyphs(props.caps);
  const body: React.ReactElement[] = [];
  rows.forEach((row, at) => {
    const line = `${row.label.padEnd(LABEL_PAD)}${row.value}`;
    body.push(
      <Text key={row.key} wrap="truncate"
        color={at === cursor ? props.theme.accent : props.theme.muted}>
        {`${at === cursor ? glyphs.caret : ' '} ${clipProfileText(line, props.cols - 8)}`}
      </Text>,
    );
    if (at === 0 && note !== null) {
      body.push(
        <Text key="restart-note" wrap="truncate" color={props.theme.muted}>
          {`  ${clipProfileText(note, props.cols - 8)}`}
        </Text>,
      );
    }
  });
  // The hint explains the FOCUSED row: the range and the reason are the point of the page.
  if (focused) {
    body.push(<Text key="hint" wrap="truncate" color={props.theme.muted}>
      {clipProfileText(focused.hint, props.cols - 8)}
    </Text>);
  }
  return <OverlayFrame {...props} rows={body} scrollOffset={offset}
    title={props.view.error ?? 'Governance'}
    hint="Arrows adjust. Esc goes back; Ctrl+S on the main page saves." />;
}
