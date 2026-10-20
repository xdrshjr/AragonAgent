/**
 * Settings > Kit pack > editor (agent-model-kits §4.5).
 *
 * ASCII ONLY - `src/ui/**` is inside `glyphs.test.ts::inScope`.
 *
 * FOUR ROWS AND TWO ACTIONS, and every slot is an explicit decision (D-8): the
 * Main slot is required, the Fast slot is a two-state choice (`off` is a
 * decision, not an omission), and the Subagent slot reuses the existing
 * `Same as main` / `Fast tier model` vocabulary so the summary sentence the root
 * page already prints (`Fast tier (off - falls back to main)`) needs no second
 * wording. Nothing is written until the ROOT page's Save.
 */

import React, { useState } from 'react';
import { Text, useInput } from 'ink';
import type { ModelProfileState } from './model-profile-state.js';
import type { KitAction, KitDraft } from './kit-settings-state.js';
import { pickGlyphs } from '../glyphs.js';
import { OverlayFrame } from '../layout/OverlayFrame.js';
import { stripPasteFrames } from '../paste-frames.js';
import { stripEnterFrames } from '../enter-frames.js';
import { clipProfileText, useProfileScroll, type ProfileFrameProps } from './ModelProfilePicker.js';

const ROWS = ['name', 'main', 'subagent', 'fast', 'save', 'cancel'] as const;
type EditorRow = typeof ROWS[number];

interface KitEditorProps extends ProfileFrameProps {
  draft: KitDraft;
  state: ModelProfileState;
  dispatch: React.Dispatch<KitAction>;
}

function slotLabel(draft: KitDraft, state: ModelProfileState): {
  main: string; fast: string; subagent: string;
} {
  const entries = state.draft.profiles?.entries ?? [];
  const name = (id: string | null): string => {
    const entry = id ? entries.find((item) => item.id === id) : undefined;
    // `Profile missing` rather than a blank: a kit can be pointed at a profile
    // that was removed on disk, and the editor is where that gets fixed.
    return entry ? `${entry.provider}:${entry.model}  (${entry.name})` : id ? 'Profile missing'
      : '(not set)';
  };
  const subagent = draft.subagent.model === 'main' ? 'Same as main'
    : draft.subagent.model === 'fast' ? 'Fast tier model'
      : name(draft.subagent.modelProfileId);
  return { main: name(draft.mainProfileId), fast: name(draft.fastProfileId),
    subagent };
}

export function KitEditor(props: KitEditorProps): React.ReactElement {
  const glyphs = pickGlyphs(props.caps);
  const { draft, dispatch } = props;
  const [index, setIndex] = useState(0);
  const row = ROWS[index]!;
  const offset = useProfileScroll(props, index);
  const labels = slotLabel(draft, props.state);
  const filled = [draft.mainProfileId, draft.fastProfileId,
    draft.subagent.model !== 'profile' || draft.subagent.modelProfileId]
    .filter(Boolean).length;
  function activate(target: EditorRow): void {
    if (target === 'main') dispatch({ type: 'kit-slot', slot: 'main' });
    if (target === 'fast') dispatch({ type: 'kit-slot', slot: 'fast' });
    if (target === 'subagent') dispatch({ type: 'kit-slot', slot: 'subagent' });
    if (target === 'save') dispatch({ type: 'kit-save' });
    if (target === 'cancel') dispatch({ type: 'kit-cancel' });
  }
  useInput((input, key) => {
    if (props.isActive === false) return;
    if (key.escape) { dispatch({ type: 'kit-cancel' }); return; }
    if (key.upArrow || (key.tab && key.shift)) {
      setIndex((index - 1 + ROWS.length) % ROWS.length); return;
    }
    if (key.downArrow || key.tab) { setIndex((index + 1) % ROWS.length); return; }
    if (key.return) { activate(row); return; }
    if (row !== 'name' || key.ctrl || key.meta) return;
    // THE NAME IS THE ONLY TEXT FIELD, and control characters are stripped by the
    // reducer rather than refused here - a pasted name with a newline should
    // become a name, not an error the user cannot see.
    const text = stripPasteFrames(stripEnterFrames(input));
    if (key.backspace || key.delete) {
      dispatch({ type: 'kit-name', value: [...draft.name].slice(0, -1).join('') });
      return;
    }
    if (text) dispatch({ type: 'kit-name', value: `${draft.name}${text}` });
  });
  const lines = [`Name          ${draft.name}`,
    `Main profile  ${labels.main}`,
    `Subagent      ${labels.subagent}`,
    `Fast tier     ${draft.fastProfileId ? labels.fast : 'off (this kit turns it off)'}`,
    `Save          (${filled} slots set)`, 'Cancel'];
  const rows = lines.map((line, at) => (
    <Text key={at} wrap="truncate" color={at === index ? props.theme.accent : props.theme.muted}>
      {`${at === index ? glyphs.caret : ' '} ${clipProfileText(line, props.cols - 8)}`}
    </Text>
  ));
  if (draft.error) {
    rows.push(<Text key="error" wrap="truncate" color={props.theme.noticeError}>
      {clipProfileText(draft.error, props.cols - 8)}
    </Text>);
  }
  return <OverlayFrame {...props} title={draft.id ? 'Edit kit' : 'New kit'}
    hint="Enter choose | type to rename | Esc back" rows={rows} scrollOffset={offset} />;
}
