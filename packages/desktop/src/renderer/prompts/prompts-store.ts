/**
 * The prompt library as the picker and Settings > Prompts share it: one list, one set of
 * mutations. Every mutation goes through `ipc('prompts:*')` (the main process owns
 * `quick-prompts.json`, shared with the terminal) and re-reads the list afterwards, so the
 * screen shows what is on disk rather than what this window hopes is there.
 */

import { create } from 'zustand';
import { ipc } from '../api.js';
import type { IpcErrorCode, PromptDraftDto, PromptDto } from '../../shared/ipc-contract.js';

export type PromptsFailure = { ok: false; code: IpcErrorCode; message: string };
export type PromptsOutcome = { ok: true } | PromptsFailure;

interface PromptsState {
  prompts: PromptDto[];
  loaded: boolean;
  error: string | null;
  refresh(): Promise<void>;
  create(draft: PromptDraftDto): Promise<PromptsOutcome>;
  update(id: string, patch: Partial<PromptDraftDto>): Promise<PromptsOutcome>;
  remove(id: string): Promise<PromptsOutcome>;
  favorite(id: string, favorite: boolean): Promise<PromptsOutcome>;
  markUsed(id: string): Promise<void>;
}

export const usePrompts = create<PromptsState>((set, get) => {
  /** Run one mutation, then re-read so the list matches the file. */
  const mutate = async (call: () => Promise<{ ok: true } | PromptsFailure>): Promise<PromptsOutcome> => {
    const result = await call();
    if (result.ok) await get().refresh();
    return result;
  };
  return {
    prompts: [],
    loaded: false,
    error: null,
    async refresh() {
      const response = await ipc('prompts:list');
      if (response.ok) set({ prompts: response.value, loaded: true, error: null });
      else set({ loaded: true, error: response.message });
    },
    create: (draft) => mutate(async () => {
      const response = await ipc('prompts:create', draft);
      return response.ok ? { ok: true } : response;
    }),
    update: (id, patch) => mutate(async () => {
      const response = await ipc('prompts:update', { id, patch });
      return response.ok ? { ok: true } : response;
    }),
    remove: (id) => mutate(async () => {
      const response = await ipc('prompts:delete', { id });
      return response.ok ? { ok: true } : response;
    }),
    favorite: (id, favorite) => mutate(async () => {
      const response = await ipc('prompts:favorite', { id, favorite });
      return response.ok ? { ok: true } : response;
    }),
    async markUsed(id) {
      await ipc('prompts:use', { id });
    },
  };
});
