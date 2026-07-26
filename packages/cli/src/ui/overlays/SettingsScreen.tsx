/**
 * Settings screen — edit provider / model / base URL / thinking / max tokens /
 * API key for the active provider (spec §3.5 / §5.2). Up/Down move between
 * fields; Left/Right cycle enum fields; typing edits text/secret fields;
 * Enter saves; Esc (handled by the App) closes without saving.
 *
 * The API key is never printed: it renders as dots while editing and masked
 * otherwise.
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { ThinkingLevel } from '@argon-agent/core';
import { ADAPTER_PROVIDERS, THINKING_LEVELS, maskSecret } from '../../config/schema.js';
import type { Theme } from '../theme.js';
import type { TermCapabilities } from '../capabilities.js';
import { pickGlyphs } from '../glyphs.js';
import { OverlayFrame } from '../layout/OverlayFrame.js';

export interface SettingsValues {
  provider: string;
  model: string;
  baseUrl: string;
  thinkingLevel: ThinkingLevel;
  maxTokens: string;
  apiKey: string;
}

interface SettingsScreenProps {
  initial: SettingsValues;
  /** Resolved keys per provider so switching providers reloads the right key. */
  apiKeys: Record<string, string | undefined>;
  maxRows: number;
  cols: number;
  /** Owned by `App`, like every other overlay scroll offset. */
  scrollOffset: number;
  /** Clamped offset reported back to `App`; see `OverlayFrame`. */
  onScrollClamp?: (offset: number) => void;
  theme: Theme;
  caps: TermCapabilities;
  onSave: (values: SettingsValues) => void;
}

type FieldKey = keyof SettingsValues;
interface FieldDef {
  key: FieldKey;
  label: string;
  kind: 'enum' | 'text' | 'secret';
  options?: readonly string[];
}

const FIELDS: FieldDef[] = [
  { key: 'provider', label: 'Provider', kind: 'enum', options: ADAPTER_PROVIDERS },
  { key: 'model', label: 'Model', kind: 'text' },
  { key: 'baseUrl', label: 'Base URL', kind: 'text' },
  { key: 'thinkingLevel', label: 'Thinking', kind: 'enum', options: THINKING_LEVELS },
  { key: 'maxTokens', label: 'Max tokens', kind: 'text' },
  { key: 'apiKey', label: 'API key', kind: 'secret' },
];

export function SettingsScreen({
  initial,
  apiKeys,
  maxRows,
  cols,
  scrollOffset,
  onScrollClamp,
  theme,
  caps,
  onSave,
}: SettingsScreenProps): React.ReactElement {
  const [values, setValues] = useState<SettingsValues>(initial);
  const [index, setIndex] = useState(0);
  const glyphs = pickGlyphs(caps);

  const field = FIELDS[index]!;

  const cycle = (dir: 1 | -1) => {
    if (field.kind !== 'enum' || !field.options) return;
    const opts = field.options;
    const cur = opts.indexOf(String(values[field.key]));
    const next = (cur + dir + opts.length) % opts.length;
    const nextVal = opts[next]!;
    setValues((prev) => {
      const updated = { ...prev, [field.key]: nextVal } as SettingsValues;
      // Clear the key editor on provider switch. Never round-trip a resolved
      // (possibly env-only) key into the editor — saving would then persist a
      // secret the user never typed into the 0600 config file.
      if (field.key === 'provider') {
        updated.apiKey = '';
      }
      return updated;
    });
  };

  useInput((input, key) => {
    if (key.escape) return; // App closes the overlay.

    if (key.upArrow) {
      setIndex((i) => (i - 1 + FIELDS.length) % FIELDS.length);
      return;
    }
    if (key.downArrow || key.tab) {
      setIndex((i) => (i + 1) % FIELDS.length);
      return;
    }
    if (key.return) {
      onSave(values);
      return;
    }
    if (field.kind === 'enum') {
      if (key.leftArrow) cycle(-1);
      if (key.rightArrow) cycle(1);
      return;
    }
    // text / secret editing
    if (key.backspace || key.delete) {
      setValues((prev) => ({ ...prev, [field.key]: String(prev[field.key]).slice(0, -1) }));
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setValues((prev) => ({ ...prev, [field.key]: String(prev[field.key]) + input }));
    }
  });

  const displayValue = (f: FieldDef, selected: boolean): string => {
    const raw = String(values[f.key] ?? '');
    if (f.kind === 'secret') {
      // Indicate an already-configured key (env or file) without revealing it or
      // its length — the editor stays empty until the user types a replacement.
      const configured = (apiKeys[values.provider] ?? '').length > 0;
      if (raw.length > 0) {
        return selected
          ? glyphs.maskDot.repeat(Math.min(raw.length, 24))
          : maskSecret(raw, { maskChar: glyphs.maskDot, ellipsis: glyphs.ellipsis });
      }
      if (configured) return selected ? '(configured - type to replace)' : '(configured)';
      return selected ? '(type to set)' : '(none)';
    }
    if (f.kind === 'enum') return raw;
    return raw.length > 0 ? raw : selected ? '(type to set)' : '(none)';
  };

  // One element per row, each `wrap="truncate"` — the contract for OverlayFrame's
  // controlled mode. The old title alone was 68 characters and wrapped below 70
  // columns, adding a row the frame could not account for (P2-9 / R-8).
  const rows: React.ReactElement[] = FIELDS.map((f, i) => {
    const selected = i === index;
    return (
      <Text key={f.key} wrap="truncate">
        <Text color={selected ? theme.accent : theme.muted}>
          {selected ? `${glyphs.caret} ` : '  '}
        </Text>
        <Text color={selected ? theme.assistant : theme.muted}>
          {(f.key === 'apiKey' ? `API key (${values.provider})` : f.label).padEnd(18)}
        </Text>
        <Text color={selected ? theme.primary : theme.muted}>{displayValue(f, selected)}</Text>
        {f.kind === 'enum' && selected && (
          <Text color={theme.muted}>
            {' ('}
            {glyphs.arrowLeft}/{glyphs.arrowRight}
            {')'}
          </Text>
        )}
      </Text>
    );
  });
  rows.push(
    <Text key="__save" wrap="truncate" color={theme.muted}>
      Enter saves. Keys persist to the config file (0600).
    </Text>,
  );

  return (
    <OverlayFrame
      title="Settings"
      hint={`${glyphs.arrowUp}${glyphs.arrowDown} field ${glyphs.midDot} ${glyphs.arrowLeft}${glyphs.arrowRight} change ${glyphs.midDot} Enter save ${glyphs.midDot} Esc close`}
      maxRows={maxRows}
      cols={cols}
      rows={rows}
      scrollOffset={scrollOffset}
      onScrollClamp={onScrollClamp}
      theme={theme}
      caps={caps}
    />
  );
}
