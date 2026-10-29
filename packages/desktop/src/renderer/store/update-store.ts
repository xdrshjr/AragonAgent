/**
 * The update notification state, shared by the title-bar badge and the Updates page.
 *
 * One subscription to `update:status` for the whole window; the main process owns the schedule,
 * so this store never polls. `check()` is the "Check now" button: a manual check, which shows a
 * version the user earlier chose to skip.
 */

import { create } from 'zustand';
import { ipc, onBroadcast } from '../api.js';
import type { UpdateStatus } from '../../shared/ipc-contract.js';

export interface UpdateState {
  status: UpdateStatus | null;
  check(): Promise<void>;
  skip(version: string): Promise<void>;
  openDownload(): Promise<boolean>;
}

export const useUpdates = create<UpdateState>((set) => ({
  status: null,
  async check() {
    set({ status: { state: 'checking' } });
    const response = await ipc('update:check');
    set({ status: response.ok ? response.value : { state: 'error', kind: 'network', checkedAt: Date.now() } });
  },
  async skip(version) {
    const response = await ipc('update:skip-version', { version });
    if (response.ok) set({ status: response.value });
  },
  async openDownload() {
    const response = await ipc('update:open-download');
    return response.ok && response.value.opened;
  },
}));

/** Wire the broadcast once; returns the unsubscribe. */
export function watchUpdates(): () => void {
  return onBroadcast('update:status', (status) => useUpdates.setState({ status }));
}

/** Whether the badge should show: only for a version on offer. */
export function selectOffer(state: UpdateState): string | null {
  return state.status?.state === 'available' ? state.status.version : null;
}
