/**
 * Import / export of the prompt library as JSON. Pure.
 *
 * Import accepts either a bare array or `{ prompts: [...] }` (what export writes). Every item
 * goes through the engine's own `validatePromptDraft`, so a file cannot smuggle in a prompt
 * the library itself would refuse; invalid items are counted and skipped, never half-imported.
 */

import { validatePromptDraft } from '@aragon-agent/tui/model/prompts/validate';
import type { PromptDraftInput } from '@aragon-agent/tui/model/prompts/types';
import type { PromptDto } from '../../shared/ipc-contract.js';

export type ImportParse =
  | { ok: true; drafts: PromptDraftInput[]; skipped: number }
  | { ok: false; reason: 'not_json' | 'no_prompts' };

export function exportPrompts(prompts: readonly PromptDto[]): string {
  const rows = prompts.map((prompt) => ({
    title: prompt.title,
    content: prompt.content,
    ...(prompt.description ? { description: prompt.description } : {}),
    ...(prompt.tags && prompt.tags.length > 0 ? { tags: prompt.tags } : {}),
    ...(prompt.favorite ? { favorite: true } : {}),
  }));
  return JSON.stringify({ schema: 1, prompts: rows }, null, 2);
}

function asDraft(raw: unknown): PromptDraftInput | null {
  if (raw === null || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  if (typeof item.title !== 'string' || typeof item.content !== 'string') return null;
  const tags = Array.isArray(item.tags) ? item.tags.filter((tag): tag is string => typeof tag === 'string') : undefined;
  const verdict = validatePromptDraft({
    title: item.title,
    content: item.content,
    ...(typeof item.description === 'string' ? { description: item.description } : {}),
    ...(tags ? { tags } : {}),
    ...(item.favorite === true ? { favorite: true } : {}),
  });
  return verdict.ok ? verdict.input : null;
}

export function parsePromptImport(text: string): ImportParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'not_json' };
  }
  const list = Array.isArray(parsed) ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { prompts?: unknown }).prompts)
      ? (parsed as { prompts: unknown[] }).prompts : null;
  if (list === null || list.length === 0) return { ok: false, reason: 'no_prompts' };
  const drafts: PromptDraftInput[] = [];
  let skipped = 0;
  for (const item of list) {
    const draft = asDraft(item);
    if (draft) drafts.push(draft);
    else skipped += 1;
  }
  return drafts.length === 0 ? { ok: false, reason: 'no_prompts' } : { ok: true, drafts, skipped };
}
