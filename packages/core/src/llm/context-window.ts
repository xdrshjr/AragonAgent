import type { ModelInfo } from './types.js';

export type ContextWindowInfo = Pick<ModelInfo, 'contextWindow'> & {
  /**
   * `user` is produced ONLY by a host layer (the CLI's model-windows.json); no
   * Core code path ever returns it. It is in the union because `ModelInfo`
   * carries whatever the host resolved, and a source Core cannot even name is
   * a host value silently laundered into `catalog`.
   */
  contextWindowSource: 'api' | 'catalog' | 'fallback' | 'user';
};

/** Never interpret output-token limits as an input/context limit. */
export function reportedContextWindow(model: Record<string, unknown>): ContextWindowInfo {
  const top = model.top_provider as Record<string, unknown> | undefined;
  const candidates = [top?.context_length, model.context_length, model.context_window,
    model.max_input_tokens, model.inputTokenLimit, model.contextWindow];
  const value = candidates.find((n) => typeof n === 'number' && Number.isSafeInteger(n) && n > 0);
  return typeof value === 'number'
    ? { contextWindow: value, contextWindowSource: 'api' }
    : { contextWindow: 128_000, contextWindowSource: 'fallback' };
}

/** Recognize only explicit vendor namespaces and dated snapshots, not arbitrary aliases. */
export function catalogModelId(modelId: string): string {
  return modelId.trim().toLowerCase()
    .replace(/^(models|openai|anthropic|google)\//, '')
    .replace(/-(?:\d{4}-\d{2}-\d{2}|\d{8})$/, '');
}

// Context-only fallbacks: do not invent prices or change the model picker.
// https://developers.openai.com/api/docs/models/gpt-5
// https://developers.openai.com/api/docs/models/gpt-5.1
// https://developers.openai.com/api/docs/models/gpt-5.2
// https://developers.openai.com/api/docs/models/gpt-5.4
// https://developers.openai.com/api/docs/models/gpt-5.4-mini
// https://developers.openai.com/api/docs/models/gpt-5-mini
// https://developers.openai.com/api/docs/models/gpt-5.3-codex
// https://developers.openai.com/api/docs/models/gpt-4.1
// https://ai.google.dev/gemini-api/docs/models/gemini-2.5-pro
// https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash
// https://platform.claude.com/docs/en/models/sonnet-4-6/overview
// Explicit IDs avoid assuming that future versions or chat variants share a limit.
const CATALOG: Record<string, number> = {
  'gpt-5': 400_000,
  'gpt-5.1': 400_000,
  'gpt-5.2': 400_000,
  'gpt-5.4': 1_050_000,
  'gpt-5.4-mini': 400_000,
  'gpt-5-mini': 400_000,
  'gpt-5.3-codex': 400_000,
  'gpt-4.1': 1_047_576,
  'gemini-2.5-pro': 1_048_576,
  'gemini-2.5-flash': 1_048_576,
  'claude-sonnet-4-6': 1_000_000,
};

export function catalogContextWindow(modelId: string): number | undefined {
  const id = catalogModelId(modelId);
  return Object.prototype.hasOwnProperty.call(CATALOG, id) ? CATALOG[id] : undefined;
}
