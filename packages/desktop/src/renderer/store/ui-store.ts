/**
 * Renderer-only UI state: which session is in front, which panels are open, which overlay is
 * showing. Nothing here is conversation data (that is `session-store`) and nothing here is a
 * terminal setting (that is `config-store`). The layout-ish fields are mirrored into
 * `desktop-state.json` by `App` so the window reopens the way it was left.
 */

import { create } from 'zustand';
import { LIMITS, type InspectorTab } from '../../shared/desktop-state.js';

export type MainView = 'session' | 'settings';
export type SettingsPage =
  | 'general' | 'models' | 'agent' | 'team' | 'todo' | 'fast' | 'context' | 'retry'
  | 'skills' | 'governance' | 'prompts' | 'shortcuts' | 'diagnostics' | 'updates' | 'about';

export interface UiState {
  activeSessionId: string | null;
  sidebarOpen: boolean;
  sidebarWidth: number;
  inspectorOpen: boolean;
  inspectorWidth: number;
  inspectorTab: InspectorTab;
  view: MainView;
  settingsPage: SettingsPage;
  paletteOpen: boolean;
  promptPickerOpen: boolean;
  shortcutsOpen: boolean;
  /** Bumped to ask the composer of the active session to take focus. */
  composerFocusNonce: number;
  /** Text to place into the composer (from the prompt picker); consumed once. */
  composerInsert: { nonce: number; text: string } | null;
  /** The session whose "Export as Markdown" dialog is open, or null. */
  exportSessionId: string | null;
  /** The session whose find bar is open, or null. */
  findSessionId: string | null;

  setExportSession(id: string | null): void;
  setFindSession(id: string | null): void;
  setActiveSession(id: string | null): void;
  setSidebarOpen(open: boolean): void;
  setSidebarWidth(width: number): void;
  setInspectorOpen(open: boolean): void;
  setInspectorWidth(width: number): void;
  setInspectorTab(tab: InspectorTab): void;
  openSettings(page?: SettingsPage): void;
  closeSettings(): void;
  setPaletteOpen(open: boolean): void;
  setPromptPickerOpen(open: boolean): void;
  setShortcutsOpen(open: boolean): void;
  focusComposer(): void;
  insertIntoComposer(text: string): void;
}

export const useUi = create<UiState>((set) => ({
  activeSessionId: null,
  sidebarOpen: true,
  sidebarWidth: 260,
  inspectorOpen: false,
  inspectorWidth: LIMITS.inspectorWidth.fallback,
  inspectorTab: 'changes',
  view: 'session',
  settingsPage: 'general',
  paletteOpen: false,
  promptPickerOpen: false,
  shortcutsOpen: false,
  composerFocusNonce: 0,
  composerInsert: null,
  exportSessionId: null,
  findSessionId: null,

  setExportSession: (id) => set({ exportSessionId: id }),
  setFindSession: (id) => set({ findSessionId: id }),
  setActiveSession: (id) => set({ activeSessionId: id, view: 'session' }),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  setSidebarWidth: (width) => set({ sidebarWidth: Math.min(420, Math.max(200, Math.round(width))) }),
  setInspectorOpen: (open) => set({ inspectorOpen: open }),
  setInspectorWidth: (width) => set({ inspectorWidth: Math.min(LIMITS.inspectorWidth.max, Math.max(LIMITS.inspectorWidth.min, Math.round(width))) }),
  setInspectorTab: (tab) => set({ inspectorTab: tab, inspectorOpen: true }),
  openSettings: (page) => set((state) => ({ view: 'settings', settingsPage: page ?? state.settingsPage })),
  closeSettings: () => set({ view: 'session' }),
  setPaletteOpen: (open) => set({ paletteOpen: open }),
  setPromptPickerOpen: (open) => set({ promptPickerOpen: open }),
  setShortcutsOpen: (open) => set({ shortcutsOpen: open }),
  focusComposer: () => set((state) => ({ composerFocusNonce: state.composerFocusNonce + 1 })),
  insertIntoComposer: (text) => set((state) => ({
    composerInsert: { nonce: (state.composerInsert?.nonce ?? 0) + 1, text },
  })),
}));
