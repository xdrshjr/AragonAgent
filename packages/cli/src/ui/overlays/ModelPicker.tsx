/**
 * Model picker overlay. Sources its provider set from the adapter-backed
 * providers only (R5) so it never offers a model whose provider would fail at
 * run with `Unknown LLM provider`. Lists each provider's builtin models.
 *
 * Selection belongs to a model ID, independently of the visible row window.
 * Resizing or hiding the overlay never resets it. Each item occupies one row;
 * this component owns navigation while App owns Escape.
 */

import React, { useState } from 'react';
import { Text, useInput } from 'ink';
import type { ModelRegistry } from '@aragon-agent/core';
import { ADAPTER_PROVIDERS } from '../../config/schema.js';
import type { Theme } from '../theme.js';
import type { TermCapabilities } from '../capabilities.js';
import { pickGlyphs } from '../glyphs.js';
import { OverlayFrame, overlayBodyRows } from '../layout/OverlayFrame.js';

interface ModelPickerProps {
  isActive?: boolean;
  registry: ModelRegistry;
  currentProvider: string;
  currentModel: string;
  maxRows: number;
  cols: number;
  theme: Theme;
  caps: TermCapabilities;
  onSelect: (provider: string, model: string) => void;
}

interface Item {
  label: string;
  value: string; // `${provider}:${modelId}`
}

export function ModelPicker({
  isActive = true,
  registry,
  currentProvider,
  currentModel,
  maxRows,
  cols,
  theme,
  caps,
  onSelect,
}: ModelPickerProps): React.ReactElement {
  const glyphs = pickGlyphs(caps);
  const items: Item[] = [];
  const seen = new Set<string>();
  for (const provider of ADAPTER_PROVIDERS) {
    for (const model of registry.getModels(provider)) {
      const value = `${provider}:${model.id}`;
      if (seen.has(value)) continue;
      seen.add(value);
      const current =
        provider === currentProvider && model.id === currentModel ? ` ${glyphs.check}` : '';
      items.push({
        label: `${provider} ${glyphs.midDot} ${model.name} (${model.id})${current}`,
        value,
      });
    }
  }

  const [selectedValue, setSelectedValue] = useState(`${currentProvider}:${currentModel}`);
  const selectedIndex = Math.max(0, items.findIndex(item => item.value === selectedValue));
  const visibleRows = overlayBodyRows(maxRows, cols);
  const offset = Math.max(0, Math.min(selectedIndex - visibleRows + 1, items.length - visibleRows));
  const choose = (item: Item | undefined): void => {
    if (!item) return;
    const [provider, ...rest] = item.value.split(':');
    onSelect(provider!, rest.join(':'));
  };
  useInput((input, key) => {
    // Consume hidden input without changing selection, including when this is
    // the only mounted input handler; otherwise buffered keys can replay later.
    if (!isActive || !items.length) return;
    if (key.upArrow || input === 'k') {
      setSelectedValue(items[(selectedIndex - 1 + items.length) % items.length]!.value);
    } else if (key.downArrow || input === 'j') {
      setSelectedValue(items[(selectedIndex + 1) % items.length]!.value);
    } else if (key.return) choose(items[selectedIndex]);
    else if (/^[1-9]$/.test(input)) {
      const visibleIndex = Number(input) - 1;
      if (visibleIndex < visibleRows) choose(items[offset + visibleIndex]);
    }
  });

  return (
    <OverlayFrame
      title="Select a model"
      hint={`Enter choose ${glyphs.midDot} Esc cancel`}
      maxRows={maxRows}
      cols={cols}
      theme={theme}
      caps={caps}
      scrollOffset={offset}
      rows={items.length ? items.map((item, index) => <Text key={item.value}
        wrap="truncate" color={index === selectedIndex ? theme.accent : theme.primary}>
        {index === selectedIndex ? `${glyphs.caret} ` : '  '}{item.label}
      </Text>) : [<Text key="empty" wrap="truncate">No models available</Text>]}
    />
  );
}
