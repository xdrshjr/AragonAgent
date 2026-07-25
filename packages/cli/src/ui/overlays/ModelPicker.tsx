/**
 * Model picker overlay. Sources its provider set from the adapter-backed
 * providers only (R5) so it never offers a model whose provider would fail at
 * run with `Unknown LLM provider`. Lists each provider's builtin models.
 */

import React from 'react';
import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';
import type { ModelRegistry } from '@argon-agent/core';
import { ADAPTER_PROVIDERS } from '../../config/schema.js';
import type { Theme } from '../theme.js';

interface ModelPickerProps {
  registry: ModelRegistry;
  currentProvider: string;
  currentModel: string;
  theme: Theme;
  onSelect: (provider: string, model: string) => void;
}

interface Item {
  label: string;
  value: string; // `${provider}:${modelId}`
}

export function ModelPicker({
  registry,
  currentProvider,
  currentModel,
  theme,
  onSelect,
}: ModelPickerProps): React.ReactElement {
  const items: Item[] = [];
  const seen = new Set<string>();
  for (const provider of ADAPTER_PROVIDERS) {
    for (const model of registry.getModels(provider)) {
      const value = `${provider}:${model.id}`;
      if (seen.has(value)) continue;
      seen.add(value);
      const current = provider === currentProvider && model.id === currentModel ? ' ✓' : '';
      items.push({ label: `${provider} · ${model.name} (${model.id})${current}`, value });
    }
  }

  const initialIndex = Math.max(
    0,
    items.findIndex((it) => it.value === `${currentProvider}:${currentModel}`),
  );

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.primary}
      paddingX={1}
      marginTop={1}
    >
      <Text color={theme.primary} bold>
        Select a model — Enter to choose, Esc to cancel
      </Text>
      <SelectInput
        items={items}
        initialIndex={initialIndex >= 0 ? initialIndex : 0}
        onSelect={(item: Item) => {
          const [provider, ...rest] = item.value.split(':');
          onSelect(provider!, rest.join(':'));
        }}
      />
    </Box>
  );
}
