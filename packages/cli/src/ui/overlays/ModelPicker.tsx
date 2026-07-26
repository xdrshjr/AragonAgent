/**
 * Model picker overlay. Sources its provider set from the adapter-backed
 * providers only (R5) so it never offers a model whose provider would fail at
 * run with `Unknown LLM provider`. Lists each provider's builtin models.
 *
 * Uses `OverlayFrame`'s SELF-MANAGED mode (§4.4 / R-12). `ink-select-input`
 * windows itself via `limit` and registers its own `useInput` with `isFocused`
 * defaulting to true; Ink delivers every key to every mounted handler, so a
 * frame that also claimed the arrow keys would move the selection twice per
 * press. Slicing it by element would be worse still — it is one component, not
 * a list of rows. So the frame draws chrome only, and `App` registers no arrow
 * keys while this overlay is open.
 */

import React from 'react';
import SelectInput from 'ink-select-input';
import type { ModelRegistry } from '@argon-agent/core';
import { ADAPTER_PROVIDERS } from '../../config/schema.js';
import type { Theme } from '../theme.js';
import type { TermCapabilities } from '../capabilities.js';
import { pickGlyphs } from '../glyphs.js';
import { OverlayFrame } from '../layout/OverlayFrame.js';
import { overlayListLimit } from '../layout/overlay-window.js';

interface ModelPickerProps {
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

  const initialIndex = Math.max(
    0,
    items.findIndex((it) => it.value === `${currentProvider}:${currentModel}`),
  );

  return (
    <OverlayFrame
      title="Select a model"
      hint={`Enter choose ${glyphs.midDot} Esc cancel`}
      maxRows={maxRows}
      cols={cols}
      theme={theme}
      caps={caps}
    >
      {/*
        `limit` was previously not passed at all. Nine models happen to fit
        today, which made it a latent bug rather than a visible one: adding a
        few more would have reproduced exactly the silent clipping this round
        exists to remove (P2-10).
      */}
      <SelectInput
        items={items}
        limit={overlayListLimit(maxRows)}
        initialIndex={initialIndex >= 0 ? initialIndex : 0}
        onSelect={(item: Item) => {
          const [provider, ...rest] = item.value.split(':');
          onSelect(provider!, rest.join(':'));
        }}
      />
    </OverlayFrame>
  );
}
