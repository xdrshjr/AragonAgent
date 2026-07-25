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
  theme: Theme;
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
  theme,
  onSave,
}: SettingsScreenProps): React.ReactElement {
  const [values, setValues] = useState<SettingsValues>(initial);
  const [index, setIndex] = useState(0);

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
        return selected ? '•'.repeat(Math.min(raw.length, 24)) : maskSecret(raw);
      }
      if (configured) return selected ? '(configured — type to replace)' : '(configured)';
      return selected ? '(type to set)' : '(none)';
    }
    if (f.kind === 'enum') return raw;
    return raw.length > 0 ? raw : selected ? '(type to set)' : '(none)';
  };

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.primary}
      paddingX={1}
      marginTop={1}
    >
      <Text color={theme.primary} bold>
        Settings — ↑/↓ move · ←/→ change · type to edit · Enter save · Esc close
      </Text>
      {FIELDS.map((f, i) => {
        const selected = i === index;
        return (
          <Box key={f.key} flexDirection="row">
            <Text color={selected ? theme.accent : theme.muted}>{selected ? '❯ ' : '  '}</Text>
            <Text color={selected ? theme.assistant : theme.muted}>
              {(f.key === 'apiKey' ? `API key (${values.provider})` : f.label).padEnd(18)}
            </Text>
            <Text color={selected ? theme.primary : theme.muted}>{displayValue(f, selected)}</Text>
            {f.kind === 'enum' && selected && <Text color={theme.muted}> (←/→)</Text>}
          </Box>
        );
      })}
      <Box marginTop={1}>
        <Text color={theme.muted}>Press Enter to save. Keys persist to the config file (0600).</Text>
      </Box>
    </Box>
  );
}
