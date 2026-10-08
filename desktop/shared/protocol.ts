/**
 * The IPC contract between the Electron main process and the renderer.
 *
 * Channel names live in one const object so preload, main and the renderer
 * client cannot drift apart. Payload shapes are declared next to their channel.
 *
 * Rules:
 * - Main -> renderer pushes use `on*` channels; everything else is invoke/handle.
 * - Every payload is structured-clone-safe (no functions, no class instances).
 */

import type { ExecEvent } from './exec-events.js';

export const CHANNELS = {
  // Main -> renderer pushes.
  sessionEvent: 'session:event',
  sessionPhase: 'session:phase',
  sessionListChanged: 'session:list-changed',
  testProgress: 'settings:test-progress',
  // Renderer -> main invokes.
  sessionsList: 'sessions:list',
  sessionsCreate: 'sessions:create',
  sessionsOpen: 'sessions:open',
  sessionsSend: 'sessions:send',
  sessionsInterrupt: 'sessions:interrupt',
  sessionsClose: 'sessions:close',
  sessionsRemove: 'sessions:remove',
  sessionsRename: 'sessions:rename',
  sessionsSetCwd: 'sessions:set-cwd',
  sessionsSetProfile: 'sessions:set-profile',
  sessionsClearContext: 'sessions:clear-context',
  settingsGet: 'settings:get',
  settingsSave: 'settings:save',
  settingsTest: 'settings:test',
  dialogPickDir: 'dialog:pick-dir',
  shellOpenPath: 'shell:open-path',
  appInfo: 'app:info',
} as const;

/** Process-level lifecycle of one session's agent child, distinct from turn_state. */
export type SessionPhase =
  | 'idle' // spawned, waiting for the next user frame
  | 'running' // a turn (or follow-through chain) is in flight
  | 'starting' // spawn in progress, no init event yet
  | 'closing' // end frame sent, waiting for settle + exit
  | 'closed' // child exited cleanly
  | 'error'; // child exited unexpectedly or failed to start

export interface SessionMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  cwd: string;
  profileId: string;
  /** Absolute path of the CLI-side session file, from the init event. */
  sessionFile: string | null;
  /**
   * How many times the user cleared the context window. 0 = the original
   * window. The CLI-side session id gains an `-e<n>` suffix per clear so the
   * next spawn starts a fresh model context while the desktop journal (and
   * the visible transcript) keeps the whole history.
   */
  contextEpoch: number;
  /** Cumulative usage across the whole journal, updated on each result. */
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  cost: { amount: number; known: boolean };
  messageCount: number;
}

export interface SessionOpenResult {
  meta: SessionMeta;
  events: ExecEvent[];
  phase: SessionPhase;
}

export interface CreateSessionInput {
  cwd: string;
  profileId: string;
  title?: string;
}

export type RenameInput = { id: string; title: string };

// ---- Settings ----

export type ProfileMode = 'anthropic' | 'openai' | 'custom';
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

/** A model profile as stored on disk. `hasKey` is exposure state; the key itself never crosses IPC. */
export interface ModelProfile {
  id: string;
  label: string;
  mode: ProfileMode;
  model: string;
  /** Empty string means "provider default". Required for `custom`. */
  baseUrl: string;
  thinking: ThinkingLevel;
  hasKey: boolean;
  /** Masked preview such as `sk-...f2a1`, or '' when no key is stored. */
  keyPreview: string;
}

export interface SettingsSnapshot {
  profiles: ModelProfile[];
  activeProfileId: string;
  defaultCwd: string;
}

export type ProfileIssue =
  | 'label_empty'
  | 'label_too_long'
  | 'model_empty'
  | 'model_too_long'
  | 'base_url_invalid'
  | 'base_url_required_for_custom'
  | 'key_required'
  | 'duplicate_label';

export interface ProfileDraftInput {
  id?: string;
  label: string;
  mode: ProfileMode;
  model: string;
  baseUrl: string;
  thinking: ThinkingLevel;
  /** Plain key to store; undefined/null/'' means "keep the existing key". */
  apiKey?: string | null;
}

export interface SaveSettingsInput {
  profiles: ProfileDraftInput[];
  activeProfileId: string;
  defaultCwd: string;
}

export interface SaveSettingsResult {
  ok: boolean;
  issues: { profileIndex: number; code: ProfileIssue }[];
  snapshot: SettingsSnapshot | null;
}

export type TestOutcome =
  | { kind: 'ok'; model: string; provider: string; durationMs: number }
  | { kind: 'failed'; message: string; code?: string }
  | { kind: 'cancelled' };

export interface TestProgressStep {
  phase: 'starting' | 'model' | 'tool' | 'done';
  detail?: string;
}

export interface AppInfo {
  version: string;
  runtimeSource: 'dev' | 'packaged';
  cliPath: string;
  platform: string;
  /** User home directory, the fallback cwd for new sessions. */
  homeDir: string;
}
