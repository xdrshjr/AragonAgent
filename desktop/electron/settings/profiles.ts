/**
 * Pure model-profile validation and normalization.
 *
 * A profile is a named connection snapshot. Three modes exist:
 * - `anthropic`  -> Anthropic Messages API (optional base URL override for gateways)
 * - `openai`     -> OpenAI Chat Completions API (optional base URL override)
 * - `custom`     -> any OpenAI-compatible endpoint; base URL is required
 *
 * Keys are deliberately NOT validated here: a profile without a stored key is
 * legal (the child may inherit a provider env var), and only a live connection
 * test can prove the key works.
 */

import type { ModelProfile, ProfileDraftInput, ProfileIssue, ThinkingLevel } from '../../shared/protocol.js';
import { newProfileId } from '../../shared/ids.js';

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
];

export const PROFILE_LIMITS = {
  maxProfiles: 20,
  labelMax: 60,
  modelMax: 120,
  baseUrlMax: 2048,
} as const;

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === 'string' && (THINKING_LEVELS as readonly string[]).includes(value);
}

export function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export interface NormalizedDraft {
  label: string;
  mode: ModelProfile['mode'];
  model: string;
  baseUrl: string;
  thinking: ThinkingLevel;
  apiKey: string | null;
}

/** Trim and clamp every field; invalid enums fall back rather than reject (validation reports). */
export function normalizeDraft(draft: ProfileDraftInput): NormalizedDraft {
  const mode: ModelProfile['mode'] =
    draft.mode === 'anthropic' || draft.mode === 'openai' || draft.mode === 'custom' ? draft.mode : 'anthropic';
  const thinking = isThinkingLevel(draft.thinking) ? draft.thinking : 'off';
  return {
    label: (draft.label ?? '').trim().slice(0, PROFILE_LIMITS.labelMax),
    mode,
    model: (draft.model ?? '').trim().slice(0, PROFILE_LIMITS.modelMax),
    baseUrl: (draft.baseUrl ?? '').trim().slice(0, PROFILE_LIMITS.baseUrlMax),
    thinking,
    apiKey: typeof draft.apiKey === 'string' && draft.apiKey.length > 0 ? draft.apiKey : null,
  };
}

/**
 * Validate one normalized draft against its siblings (for duplicate labels).
 * Returns issues in a stable order so the UI can show the first one.
 */
export function validateProfile(
  draft: NormalizedDraft,
  siblingLabels: readonly string[],
): ProfileIssue[] {
  const issues: ProfileIssue[] = [];
  if (draft.label.length === 0) issues.push('label_empty');
  if (draft.model.length === 0) issues.push('model_empty');
  if (draft.mode === 'custom' && draft.baseUrl.length === 0) {
    issues.push('base_url_required_for_custom');
  }
  if (draft.baseUrl.length > 0 && !isHttpUrl(draft.baseUrl)) {
    issues.push('base_url_invalid');
  }
  if (siblingLabels.some((label) => label === draft.label)) {
    issues.push('duplicate_label');
  }
  return issues;
}

/** Build the on-disk profile view of a draft; `id` is the existing id or null for a new profile. */
export function toStoredProfile(
  draft: NormalizedDraft,
  id: string | null,
): {
  id: string;
  label: string;
  mode: ModelProfile['mode'];
  model: string;
  baseUrl: string;
  thinking: ThinkingLevel;
} {
  return {
    id: id ?? newProfileId(),
    label: draft.label,
    mode: draft.mode,
    model: draft.model,
    baseUrl: draft.baseUrl,
    thinking: draft.thinking,
  };
}

/** The profile every fresh install starts with, so the first settings screen is never empty. */
export function defaultProfiles(): ModelProfile[] {
  return [
    {
      id: 'profile-default-anthropic',
      label: 'Claude (default)',
      mode: 'anthropic',
      model: 'claude-sonnet-4-6',
      baseUrl: '',
      thinking: 'off',
      hasKey: false,
      keyPreview: '',
    },
  ];
}
