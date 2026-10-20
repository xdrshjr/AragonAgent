/**
 * The Agent-kit picker: `ctrl+K` (agent-model-kits §4.6 / D-10 / D-11).
 *
 * ASCII ONLY - `src/ui/**` is inside `glyphs.test.ts::inScope`.
 *
 * A LIST PLUS A DETAIL BLOCK, not one row per kit with three columns: three
 * connections never fit on a 72-column terminal, and the `OverlayFrame` detail
 * idiom is how this package already says everything that does not fit in a row
 * (`ModelProfilePicker`, the compaction card). The list carries names and
 * markers only, so the choice stays scannable at any width.
 *
 * THE OVERLAY IS READ-ONLY (R-11): Enter applies for this session, Esc leaves
 * everything as it was. That is what makes moving `killToEnd` off `Ctrl+K`
 * (D-15) a one-time surprise instead of a risk - a user who presses the old
 * key gets a reversible screen, not a deleted line.
 */

import React, { useState } from 'react';
import { Text, useInput } from 'ink';
import type { ModelProfilesConfig } from '../../config/model-profiles.js';
import type { CliConfig } from '../../config/schema.js';
import type { ActiveKit } from '../../config/kit-resolution.js';
import type { Theme } from '../theme.js';
import type { TermCapabilities } from '../capabilities.js';
import { pickGlyphs } from '../glyphs.js';
import { OverlayFrame } from '../layout/OverlayFrame.js';
import { clipProfileText, useProfileScroll } from './ModelProfilePicker.js';
import { kitDetail, kitPickHint, kitRows, NO_KITS_HINT,
  type KitConnectionsSource } from './kit-picker-state.js';

export interface KitPickerProps {
  isActive?: boolean;
  theme: Theme;
  caps: TermCapabilities;
  cols: number;
  maxRows: number;
  scrollOffset: number;
  onScrollClamp?: (offset: number) => void;
  library?: ModelProfilesConfig | undefined;
  config: CliConfig;
  /**
   * The config file's bindings, for the `Current setup` detail block (§4.6).
   *
   * OMITTED BY EMBEDDED HOSTS AND TESTS, in which case the block falls back to
   * `config` - which is exactly right when no kit is in effect, since the live
   * config then IS the file.
   */
  diskConfig?: KitConnectionsSource | undefined;
  active: ActiveKit;
  /** Only the APPLY is refused while work is in flight; browsing still works. */
  busy: boolean;
  /** `null` = `Current setup`, i.e. release the session kit. */
  onChoose: (kitId: string | null) => void;
  onClose: () => void;
}

export function KitPicker(props: KitPickerProps): React.ReactElement {
  const rows = kitRows({ library: props.library, active: props.active });
  const glyphs = pickGlyphs(props.caps);
  const [index, setIndex] = useState(0);
  const count = rows.length;
  const cursor = Math.min(index, count - 1);
  const focused = rows[cursor]!;
  const offset = useProfileScroll(props, cursor);
  const hasKits = (props.library?.kits ?? []).length > 0;
  const body: React.ReactElement[] = rows.map((row, at) => (
    <Text key={row.id ?? 'current'} wrap="truncate"
      color={at === cursor ? props.theme.accent : props.theme.muted}>
      {`${at === cursor ? glyphs.caret : ' '} ${clipProfileText(row.label, props.cols - 8)}`}
    </Text>
  ));
  if (!hasKits) {
    body.push(<Text key="empty" wrap="truncate" color={props.theme.muted}>
      {clipProfileText(NO_KITS_HINT, props.cols - 8)}
    </Text>);
  }
  // THE DETAIL BLOCK DESCRIBES THE FOCUSED ROW ONLY. Shown last so a narrow
  // terminal clips the detail, never the choice.
  for (const [at, line] of kitDetail({ row: focused, library: props.library,
    config: props.config, diskConfig: props.diskConfig }).entries()) {
    body.push(<Text key={`detail-${at}`} wrap="truncate" color={props.theme.muted}>
      {clipProfileText(`  ${line}`, props.cols - 8)}
    </Text>);
  }
  useInput((_input, key) => {
    if (props.isActive === false) return;
    if (key.escape) { props.onClose(); return; }
    if (key.upArrow || (key.tab && key.shift)) setIndex((cursor - 1 + count) % count);
    else if (key.downArrow || key.tab) setIndex((cursor + 1) % count);
    else if (key.return) props.onChoose(focused.id);
  });
  return <OverlayFrame title={props.busy ? 'Agent kits (running)' : 'Agent kits'}
    hint={kitPickHint({ busy: props.busy, hasKits })}
    rows={body} scrollOffset={offset} onScrollClamp={props.onScrollClamp}
    maxRows={props.maxRows} cols={props.cols} theme={props.theme} caps={props.caps} />;
}
