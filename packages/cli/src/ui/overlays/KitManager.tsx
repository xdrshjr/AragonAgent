/**
 * Settings > Kit pack: the manager page (agent-model-kits §4.5 / D-9).
 *
 * ASCII ONLY - `src/ui/**` is inside `glyphs.test.ts::inScope`.
 *
 * CRUD LIVES HERE AND NOWHERE ELSE: `New kit` and `e` open the editor, `d` asks
 * a confirmation that NAMES the consequences, `s` runs exit A (three slots plus
 * the persisted pointer, because a default that only moved a pointer would not
 * be in effect at the next launch - RV-P0-3), and `Enter` applies a kit to the
 * transaction draft. Nothing on this page writes the config file.
 */

import React, { useState } from 'react';
import { Text, useInput } from 'ink';
import type { Theme } from '../theme.js';
import type { TermCapabilities } from '../capabilities.js';
import { pickGlyphs } from '../glyphs.js';
import { OverlayFrame } from '../layout/OverlayFrame.js';
import { clipProfileText, useProfileScroll, type ProfileFrameProps } from './ModelProfilePicker.js';
import type { KitAction, KitManagerRow } from './kit-settings-state.js';

interface KitManagerProps extends ProfileFrameProps {
  rows: KitManagerRow[];
  error?: string;
  dispatch: React.Dispatch<KitAction>;
  /** Leave the kit pages entirely: `Esc` here means "back to Settings". */
  onBack: () => void;
}

/** `New kit` first, then one row per kit, then the three actions. */
const NEW_KIT = 'New kit';
const ACTIONS = ['Duplicate', 'Delete', 'Set default'] as const;

export function KitManager(props: KitManagerProps): React.ReactElement {
  const glyphs = pickGlyphs(props.caps);
  const [index, setIndex] = useState(0);
  // NULL, NOT THE FIRST KIT: `selected` is "the last kit the cursor was on", and
  // starting it at `rows[0]` would let `d` on the `New kit` row delete a kit the
  // user never pointed at.
  const [selected, setSelected] = useState<string | null>(null);
  const count = props.rows.length + 1 + ACTIONS.length;
  const cursor = Math.min(index, count - 1);
  const focused = props.rows[cursor - 1];
  const offset = useProfileScroll(props, cursor);
  const current = focused?.id ?? selected;
  function action(name: typeof ACTIONS[number]): void {
    if (!current) return;
    if (name === 'Duplicate') props.dispatch({ type: 'kit-duplicate', id: current });
    if (name === 'Delete') props.dispatch({ type: 'kit-delete', id: current });
    // EXIT A, NOT A POINTER WRITE (RV-P0-3): the three slots and the pointer move
    // together, because "the default" IS the disk binding (D-13).
    if (name === 'Set default') props.dispatch({ type: 'kit-default', id: current });
  }
  useInput((input, key) => {
    if (props.isActive === false) return;
    if (key.escape) { props.onBack(); return; }
    if (key.upArrow || (key.tab && key.shift)) {
      const next = (cursor - 1 + count) % count;
      setIndex(next);
      if (props.rows[next - 1]) setSelected(props.rows[next - 1]!.id);
      return;
    }
    if (key.downArrow || key.tab) {
      const next = (cursor + 1) % count;
      setIndex(next);
      if (props.rows[next - 1]) setSelected(props.rows[next - 1]!.id);
      return;
    }
    if (key.return) {
      if (cursor === 0) { props.dispatch({ type: 'kit-open', id: null }); return; }
      if (focused) { props.dispatch({ type: 'kit-apply', id: focused.id }); return; }
      action(ACTIONS[cursor - 1 - props.rows.length]!);
      return;
    }
    if (key.ctrl || key.meta) return;
    const letter = input.toLowerCase();
    // `e` opens the focused kit; `d` and `s` are the two destructive/intent-bearing
    // single keys. ALL THREE require a focused KIT ROW, so none of them can fire
    // from `New kit` or from the action rows at the bottom.
    if (!focused) return;
    if (letter === 'e') { props.dispatch({ type: 'kit-open', id: focused.id }); return; }
    if (letter === 'd') { props.dispatch({ type: 'kit-delete', id: focused.id }); return; }
    if (letter === 's') action('Set default');
  });
  const lines = [NEW_KIT, ...props.rows.map((row) => `${row.label}  ${row.summary}`),
    ...ACTIONS];
  const rows = lines.map((line, at) => (
    <Text key={at} wrap="truncate" color={at === cursor ? props.theme.accent : props.theme.muted}>
      {`${at === cursor ? glyphs.caret : ' '} ${clipProfileText(line, props.cols - 8)}`}
    </Text>
  ));
  if (!props.rows.length) {
    rows.push(<Text key="empty" wrap="truncate" color={props.theme.muted}>
      {clipProfileText('No kits yet. Press Enter on New kit to build one from this setup.',
        props.cols - 8)}
    </Text>);
  }
  return <OverlayFrame {...props} title={props.error ?? 'Agent kits'}
    hint="Enter apply | e edit | d delete | s set default | Esc back"
    rows={rows} scrollOffset={offset} />;
}
