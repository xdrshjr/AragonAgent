/**
 * The sidebar's list of saved sessions (all of them, not just the ones open in this window),
 * grouped by workspace. Rows arrive from the main process's `SessionIndex`, which fills in
 * metadata progressively; `sessions:changed` broadcasts re-fetch.
 */

import { create } from 'zustand';
import { ipc, onBroadcast } from '../api.js';
import type { SessionHostStatus, SessionRowDto } from '../../shared/ipc-contract.js';

export interface SessionGroup {
  key: string;
  label: string;
  rows: SessionRowDto[];
}

export interface SessionsListState {
  rows: SessionRowDto[];
  loaded: boolean;
  query: string;
  /** Live host status by session id, kept fresh by `session:status` without a full refetch. */
  statuses: Record<string, SessionHostStatus>;
  refresh(): Promise<void>;
  setQuery(query: string): void;
}

export const useSessionsList = create<SessionsListState>((set, get) => ({
  rows: [],
  loaded: false,
  query: '',
  statuses: {},
  async refresh() {
    const response = await ipc('sessions:list', { query: get().query || undefined });
    if (response.ok) set({ rows: response.value, loaded: true });
  },
  setQuery(query) {
    set({ query });
    void get().refresh();
  },
}));

/** Pure: group rows by workspace key, pinned first within a group, groups by newest activity. */
export function groupSessions(rows: readonly SessionRowDto[]): SessionGroup[] {
  const groups = new Map<string, SessionGroup>();
  for (const row of rows) {
    const key = row.groupKey || '(unknown)';
    const group = groups.get(key) ?? { key, label: workspaceLabel(row.cwd), rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    group.rows.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
  }
  return [...groups.values()].sort((a, b) => newest(b) - newest(a));
}

const newest = (group: SessionGroup): number => Math.max(0, ...group.rows.map((row) => row.updatedAt));

/** The last path segment, in the user's own spelling. */
export function workspaceLabel(cwd: string): string {
  const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] ?? (cwd || '(unknown)');
}

/** Wire the broadcasts once; returns the unsubscribe. */
export function watchSessions(): () => void {
  const offChanged = onBroadcast('sessions:changed', () => { void useSessionsList.getState().refresh(); });
  const offStatus = onBroadcast('session:status', ({ id, status }) => {
    useSessionsList.setState((state) => ({ statuses: { ...state.statuses, [id]: status } }));
  });
  return () => { offChanged(); offStatus(); };
}
