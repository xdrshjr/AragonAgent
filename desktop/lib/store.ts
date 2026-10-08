'use client';

/**
 * The renderer store (zustand): session list, per-session fold state, phases,
 * pending (optimistic) user messages, settings, and UI flags.
 *
 * Incoming IPC events are buffered and flushed once per animation frame so a
 * burst of `text_delta` events costs one render, and every event funnels
 * through the SAME pure `foldEvent` used to replay journals.
 */

import { create } from 'zustand';
import type { ExecEvent } from '@shared/exec-events';
import type {
  AppInfo,
  ProfileDraftInput,
  SaveSettingsInput,
  SaveSettingsResult,
  SessionMeta,
  SessionPhase,
  SettingsSnapshot,
} from '@shared/protocol';
import { createFoldState, foldEvent, type FoldState } from '@shared/fold';
import { bridge, hasBridge } from './ipc';

export interface SessionView {
  meta: SessionMeta;
  fold: FoldState;
  phase: SessionPhase;
  /** Optimistic user messages not yet echoed by the child (queued turns). */
  pending: string[];
  /** Last fatal error message surfaced for this session. */
  fatal: string | null;
  /** Bumped on every folded event; selector dependency for mutation-based folds. */
  rev: number;
  draft: string;
  /** Transcript indices where the user cleared the context window (live session only). */
  dividers: number[];
}

interface AppStore {
  bridgeOk: boolean;
  sessions: SessionMeta[];
  activeId: string | null;
  views: Record<string, SessionView>;
  settings: SettingsSnapshot | null;
  settingsOpen: boolean;
  search: string;
  appInfo: AppInfo | null;
  busyAction: boolean;

  init(): Promise<void>;
  refreshSessions(): Promise<void>;
  openSession(id: string): Promise<void>;
  newSession(): Promise<void>;
  sendActive(text: string): Promise<void>;
  interruptActive(): Promise<void>;
  removeSession(id: string): Promise<void>;
  renameSession(id: string, title: string): Promise<void>;
  changeActiveCwd(cwd: string): Promise<void>;
  setActiveProfile(profileId: string): Promise<void>;
  clearContextActive(): Promise<void>;
  setDraft(id: string, text: string): void;
  setSearch(text: string): void;
  setSettingsOpen(open: boolean): void;
  saveSettings(input: SaveSettingsInput): Promise<SaveSettingsResult>;
  testProfile(draft: ProfileDraftInput): Promise<import('@shared/protocol').TestOutcome>;
  setActive(id: string | null): void;
}

const eventQueue: { sessionId: string; event: ExecEvent }[] = [];
let flushScheduled = false;

export const useStore = create<AppStore>((set, get) => ({
  // Optimistic: assume the Electron bridge exists until init() proves
  // otherwise, so prerendered HTML and the first client render agree.
  bridgeOk: true,
  sessions: [],
  activeId: null,
  views: {},
  settings: null,
  settingsOpen: false,
  search: '',
  appInfo: null,
  busyAction: false,

  async init() {
    if (!hasBridge()) {
      set({ bridgeOk: false });
      return;
    }
    const api = bridge();
    api.onSessionEvent((sessionId, event) => {
      eventQueue.push({ sessionId, event });
      scheduleFlush(set, get);
    });
    api.onSessionPhase((sessionId, phase) => {
      set((state) => {
        const view = state.views[sessionId];
        if (!view) return state;
        return {
          views: { ...state.views, [sessionId]: { ...view, phase } },
        };
      });
    });
    api.onSessionListChanged((sessions) => {
      set((state) => {
        // Sync meta of open views (title/usage/cwd updates arrive here).
        const views: Record<string, SessionView> = {};
        for (const [id, view] of Object.entries(state.views)) {
          const meta = sessions.find((entry) => entry.id === id);
          views[id] = meta ? { ...view, meta } : view;
        }
        return { sessions, views };
      });
    });
    const [sessions, settings, appInfo] = await Promise.all([
      api.sessions.list(),
      api.settings.get(),
      api.app.info(),
    ]);
    set({ sessions, settings, appInfo });
    if (sessions.length > 0) {
      await get().openSession(sessions[0].id);
    }
  },

  async refreshSessions() {
    if (!hasBridge()) return;
    const sessions = await bridge().sessions.list();
    set({ sessions });
  },

  async openSession(id) {
    if (!hasBridge()) return;
    const api = bridge();
    const result = await api.sessions.open(id);
    const fold = createFoldState();
    for (const event of result.events) foldEvent(fold, event);
    set((state) => ({
      activeId: id,
      views: {
        ...state.views,
        [id]: {
          meta: result.meta,
          fold,
          phase: result.phase,
          pending: [],
          fatal: null,
          rev: 1,
          draft: state.views[id]?.draft ?? '',
          dividers: [],
        },
      },
    }));
  },

  async newSession() {
    if (!hasBridge()) return;
    const state = get();
    const settings = state.settings;
    const lastCwd = state.sessions[0]?.cwd;
    const cwd =
      settings?.defaultCwd || lastCwd || state.appInfo?.homeDir || '.';
    const profileId = settings?.activeProfileId || settings?.profiles[0]?.id || '';
    if (!profileId) {
      set({ settingsOpen: true });
      return;
    }
    const meta = await bridge().sessions.create({ cwd, profileId });
    set({ sessions: [meta, ...state.sessions.filter((entry) => entry.id !== meta.id)] });
    await get().openSession(meta.id);
  },

  async sendActive(text) {
    const { activeId } = get();
    if (!activeId || text.trim().length === 0) return;
    set((state) => {
      const view = state.views[activeId];
      if (!view) return state;
      return {
        views: { ...state.views, [activeId]: { ...view, pending: [...view.pending, text] } },
      };
    });
    try {
      await bridge().sessions.send(activeId, text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set((state) => {
        const view = state.views[activeId];
        if (!view) return state;
        return {
          views: {
            ...state.views,
            [activeId]: { ...view, pending: view.pending.filter((entry) => entry !== text), fatal: message },
          },
        };
      });
    }
  },

  async interruptActive() {
    const { activeId } = get();
    if (activeId) await bridge().sessions.interrupt(activeId);
  },

  async removeSession(id) {
    await bridge().sessions.remove(id);
    set((state) => {
      const views = { ...state.views };
      delete views[id];
      const sessions = state.sessions.filter((entry) => entry.id !== id);
      const activeId = state.activeId === id ? sessions[0]?.id ?? null : state.activeId;
      return { views, sessions, activeId };
    });
    const next = get().activeId;
    if (next) await get().openSession(next);
  },

  async renameSession(id, title) {
    await bridge().sessions.rename({ id, title });
  },

  async changeActiveCwd(cwd) {
    const { activeId } = get();
    if (!activeId) return;
    await bridge().sessions.setCwd(activeId, cwd);
  },

  async setActiveProfile(profileId) {
    if (!hasBridge()) return;
    const api = bridge();
    const state = get();
    if (!state.settings) return;
    const input: SaveSettingsInput = {
      profiles: state.settings.profiles.map((profile) => ({
        id: profile.id,
        label: profile.label,
        mode: profile.mode,
        model: profile.model,
        baseUrl: profile.baseUrl,
        thinking: profile.thinking,
        apiKey: null,
      })),
      activeProfileId: profileId,
      defaultCwd: state.settings.defaultCwd,
    };
    const result = await api.settings.save(input);
    if (result.ok && result.snapshot) set({ settings: result.snapshot });
    const activeId = get().activeId;
    if (activeId && result.ok) {
      await api.sessions.setProfile(activeId, profileId);
    }
  },

  async clearContextActive() {
    const { activeId } = get();
    if (!activeId) return;
    const updated = await bridge().sessions.clearContext(activeId);
    if (!updated) return;
    set((state) => {
      const view = state.views[activeId];
      if (!view) return state;
      return {
        views: {
          ...state.views,
          [activeId]: {
            ...view,
            meta: updated,
            phase: 'closed',
            dividers: [...view.dividers, view.fold.entries.length],
          },
        },
      };
    });
  },

  setDraft(id, text) {
    set((state) => {
      const view = state.views[id];
      if (!view) return state;
      return { views: { ...state.views, [id]: { ...view, draft: text } } };
    });
  },

  setSearch(text) {
    set({ search: text });
  },

  setSettingsOpen(open) {
    set({ settingsOpen: open });
  },

  async saveSettings(input) {
    const result = await bridge().settings.save(input);
    if (result.ok && result.snapshot) set({ settings: result.snapshot });
    return result;
  },

  async testProfile(draft) {
    return bridge().settings.test(draft);
  },

  setActive(id) {
    set({ activeId: id });
  },
}));

function scheduleFlush(
  set: (fn: (state: AppStore) => Partial<AppStore>) => void,
  get: () => AppStore,
): void {
  if (flushScheduled) return;
  flushScheduled = true;
  requestAnimationFrame(() => {
    flushScheduled = false;
    const batch = eventQueue.splice(0, eventQueue.length);
    set((state) => applyEvents(state, batch));
    void get();
  });
}

function applyEvents(
  state: AppStore,
  batch: { sessionId: string; event: ExecEvent }[],
): Partial<AppStore> {
  let views = state.views;
  let dirty = false;
  for (const { sessionId, event } of batch) {
    const view = views[sessionId];
    if (!view) continue;
    dirty = true;
    foldEvent(view.fold, event);
    const pending = reconcilePending(view.pending, event);
    const fatal =
      event.type === 'error' && event.fatal ? event.message : event.type === 'user' ? null : view.fatal;
    views = {
      ...views,
      [sessionId]: { ...view, pending, fatal, rev: view.rev + 1 },
    };
  }
  return dirty ? { views } : {};
}

function reconcilePending(pending: string[], event: ExecEvent): string[] {
  if (event.type !== 'user' || event.source !== 'caller') return pending;
  const at = pending.indexOf(event.text);
  if (at < 0) return pending;
  return pending.filter((entry, index) => index !== at);
}
