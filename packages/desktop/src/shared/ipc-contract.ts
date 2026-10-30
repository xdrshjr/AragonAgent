/**
 * The control plane: `ipcMain.handle` channels (renderer -> main, request/response) and the
 * one-way broadcasts (main -> renderer).
 *
 * SINGLE SOURCE OF TRUTH. The main process registers exactly the channels in
 * `IPC_CHANNELS`, the preload exposes exactly those (and re-checks at run time), and the
 * renderer's typed client is generated from the same map - so a channel cannot exist in one
 * place and not another. Every handler returns an `IpcResult`; a handler never throws across
 * the boundary and an unvalidated argument comes back as `invalid_argument`.
 */

import type { ConfigPatchResultDto, ConfigViewResultDto } from './config-view.js';
import type { DesktopState } from './desktop-state.js';
import type { ChromeTheme } from './window-chrome.js';
import type { SessionRunStatus, SkillInfoDto } from './port-protocol.js';

/** Same values as `PlatformName`, restated so the renderer needs no Node typings. */
export type PlatformName =
  | 'aix' | 'android' | 'cygwin' | 'darwin' | 'freebsd' | 'haiku' | 'linux' | 'netbsd' | 'openbsd' | 'sunos' | 'win32';

export type IpcErrorCode =
  | 'invalid_argument'
  | 'conflict'
  | 'invalid_json'
  | 'write_failed'
  | 'read_failed'
  | 'profile_key_required'
  | 'session_busy_elsewhere'
  | 'host_unavailable'
  | 'path_not_allowed'
  | 'not_found'
  | 'engine_unavailable'
  | 'cancelled'
  | 'too_large'
  | 'unavailable'
  | 'internal';

export type IpcResult<T> = { ok: true; value: T } | { ok: false; code: IpcErrorCode; message: string };

export interface ClipboardImageResult {
  /** A PNG. */
  bytes: ArrayBuffer;
  width: number;
  height: number;
}

export interface AppInfo {
  versions: { desktop: string; cli: string; core: string; tui: string; electron: string; node: string };
  platform: PlatformName;
  homeRoot: string;
  /** True when `ARAGON_HOME` redirected the home (tests, portable mode). */
  overridden: boolean;
  /** Set when the engine could not be loaded; the renderer shows a full-page error. */
  engineError: string | null;
  isPackaged: boolean;
  /** desktop-state.json was unreadable at launch and was set aside; preferences are back to defaults. */
  preferencesReset?: boolean;
  /** Product switches. Absent = everything on (older callers and test fixtures do not set it). */
  features?: { attachments: boolean };
}

export type SessionOrigin = 'exec' | 'tui';

export interface SessionRowDto {
  id: string;
  title: string | null;
  cwd: string;
  /** Normalised grouping key (see `workspaceGroupKey`). */
  groupKey: string;
  updatedAt: number;
  turns: number;
  provider: string;
  model: string;
  origin: SessionOrigin;
  pinned: boolean;
  branchOf?: string;
  /** The file could not be parsed; it is still listed so the user knows it exists. */
  unreadable: boolean;
  /** A live process that is not one of our session hosts is writing this session. */
  liveElsewhere: boolean;
  /** Metadata is still being read in the background. */
  pending: boolean;
  /** A session host for it is running (or parked) in this app. */
  hostStatus: SessionHostStatus | null;
}

export type SessionHostStatus =
  | 'starting' | 'ready' | 'running' | 'waiting-approval' | 'parked'
  | 'crashed' | 'failed' | 'unresponsive';

export interface SessionOpenInput {
  id?: string;
  cwd: string;
  branchOf?: string;
  /** Open read-only (the session is written by a terminal). */
  readOnly?: boolean;
}

export interface SessionOpenResult {
  sessionId: string;
  /** One-time token the renderer must present when the session's port arrives. */
  channelToken: string;
}

export interface PromptDto {
  id: string;
  title: string;
  content: string;
  description?: string;
  tags?: string[];
  favorite?: boolean;
  useCount: number;
  updatedAt: number;
}

export interface PromptDraftDto {
  title: string;
  content: string;
  description?: string;
  tags?: string[];
  favorite?: boolean;
}

export interface ConnectionDraftDto {
  provider: string;
  model: string;
  baseUrl?: string | null;
  apiKey?: string | null;
  profileId?: string;
}

export interface ConnectionTestResultDto {
  ok: boolean;
  stage: 'config' | 'network' | 'auth' | 'model' | 'stream' | 'ok';
  detail: string;
  latencyMs?: number;
}

export interface ModelOptionDto {
  id: string;
  name?: string;
  contextWindow?: number;
}

/**
 * Update NOTIFICATION state (see `main/update-service.ts`): there is no download or install step,
 * so there is no `downloading` / `ready`. `unsupported` is also what a build with no feed, or a
 * user who switched checks off, sees.
 */
export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'uptodate'; checkedAt: number }
  | { state: 'available'; version: string; notesUrl?: string; downloadUrl: string; releasedAt?: string }
  | { state: 'error'; kind: 'network' | 'timeout' | 'bad_manifest'; checkedAt: number }
  | { state: 'unsupported'; message: string };

export interface SessionExportRequestDto {
  sessionId: string;
  /** A title-ish base name; the main process sanitizes it and appends a timestamp. */
  suggestedName: string;
  markdown: string;
  /** Only the dialog's starting folder; ignored unless it is an existing directory. */
  cwd?: string;
}

export interface QuitPlan {
  runningSessions: string[];
  liveServices: number;
}

/** channel -> { in, out }. `void` means "no argument". */
export interface IpcContract {
  'app:info': { in: void; out: AppInfo };
  'config:get': { in: void; out: ConfigViewResultDto };
  'config:patch': { in: { baseRevision: string; patch: Record<string, unknown> }; out: ConfigPatchResultDto };
  'config:reveal-key': { in: { provider: string; profileId?: string }; out: { key: string | null } };
  'config:test-connection': { in: ConnectionDraftDto; out: ConnectionTestResultDto };
  'config:discover-models': { in: Omit<ConnectionDraftDto, 'model'>; out: { models: ModelOptionDto[] } };
  'config:open-in-editor': { in: void; out: { opened: boolean } };
  'config:restore-backup': { in: void; out: { restored: boolean } };
  'skills:list': { in: { cwd?: string } | void; out: { skills: SkillInfoDto[] } };
  'sessions:list': { in: { query?: string } | void; out: SessionRowDto[] };
  'sessions:open': { in: SessionOpenInput; out: SessionOpenResult };
  'sessions:close': { in: { id: string }; out: { closed: boolean } };
  'sessions:park': { in: { id: string }; out: { parked: boolean } };
  'sessions:restart': { in: { id: string }; out: { restarted: boolean } };
  'sessions:pin': { in: { id: string; pinned: boolean }; out: { pinned: boolean } };
  'sessions:remove': { in: { id: string; confirm: boolean }; out: { removed: boolean } };
  'sessions:branch': { in: { id: string }; out: { id: string } };
  'workspace:pick': { in: void; out: { path: string | null } };
  'workspace:recent': { in: void; out: string[] };
  'prompts:list': { in: void; out: PromptDto[] };
  'prompts:create': { in: PromptDraftDto; out: { id: string } };
  'prompts:update': { in: { id: string; patch: Partial<PromptDraftDto> }; out: { ok: true } };
  'prompts:delete': { in: { id: string }; out: { ok: true } };
  'prompts:favorite': { in: { id: string; favorite: boolean }; out: { ok: true } };
  'prompts:use': { in: { id: string }; out: { ok: true } };
  'native:open-path': { in: { sessionId: string; relPath: string; reveal?: boolean }; out: { opened: boolean } };
  'native:open-external': { in: { url: string }; out: { opened: boolean } };
  /** Type and size of a path the user just dropped or picked. Never reads content. */
  'native:stat-path': { in: { path: string }; out: { kind: 'file' | 'folder' | 'missing'; size: number } };
  /**
   * The picture on the OS clipboard, or null when there is none. Image only (no text, no files),
   * read on demand from a paste or a menu click, never polled.
   */
  'native:read-clipboard-image': { in: void; out: ClipboardImageResult | null };
  /** Show a staged attachment in the file manager. The renderer names an id, never a path. */
  'native:reveal-attachment': { in: { sessionId: string; attachmentId: string }; out: { opened: boolean } };
  /** Copy a staged attachment where the user chooses; `path` is null when they cancel. */
  'native:save-attachment': {
    in: { sessionId: string; attachmentId: string; suggestedName: string };
    out: { path: string | null };
  };
  'native:notify': { in: { title: string; body: string; sessionId?: string }; out: { shown: boolean } };
  'diagnostics:export': { in: void; out: { savedTo: string | null } };
  /** The renderer built the Markdown; the main process asks where to save it and removes secrets. */
  'session:export': { in: SessionExportRequestDto; out: { path: string } };
  /** How much is running / waiting, for the taskbar progress bar and attention flash. */
  'native:activity': { in: { running: number; waiting: number }; out: { applied: boolean } };
  /** The theme the renderer resolved, so the native caption buttons and window background match it. */
  'window:set-chrome': { in: { theme: ChromeTheme }; out: { applied: boolean } };
  'update:check': { in: void; out: UpdateStatus };
  'update:install': { in: void; out: { started: boolean } };
  'update:skip-version': { in: { version: string }; out: UpdateStatus };
  /** The main process opens the URL it validated itself; the renderer cannot name one. */
  'update:open-download': { in: void; out: { opened: boolean } };
  'desktop-state:get': { in: void; out: DesktopState };
  'desktop-state:patch': { in: Partial<Omit<DesktopState, 'extras' | 'schema'>>; out: DesktopState };
  'app:quit-plan': { in: void; out: QuitPlan };
  'app:quit-confirmed': { in: { stopServices: boolean }; out: { quitting: true } };
  'app:cancel-quit': { in: void; out: { cancelled: true } };
}

export type IpcChannel = keyof IpcContract;

export interface BroadcastContract {
  'config:changed': { revision: string; ok: boolean };
  'sessions:changed': { reason: 'files' | 'status' | 'metadata' };
  'session:status': { id: string; status: SessionHostStatus; detail?: string; restoredAt?: number };
  'update:status': UpdateStatus;
  'theme:system-changed': { dark: boolean };
  'app:quit-requested': QuitPlan;
  'session:focus': { id: string; approval?: boolean };
  'window:state': { maximized: boolean; fullscreen: boolean; focused: boolean };
}

export type BroadcastChannel = keyof BroadcastContract;

/** The runtime allow-list. Typed against the contract so a typo is a compile error. */
export const IPC_CHANNELS = [
  'app:info', 'config:get', 'config:patch', 'config:reveal-key', 'config:test-connection',
  'config:discover-models', 'config:open-in-editor', 'config:restore-backup',
  'skills:list', 'sessions:list', 'sessions:open', 'sessions:close', 'sessions:park', 'sessions:restart',
  'sessions:pin', 'sessions:remove', 'sessions:branch', 'workspace:pick', 'workspace:recent',
  'prompts:list', 'prompts:create', 'prompts:update', 'prompts:delete', 'prompts:favorite',
  'prompts:use', 'native:open-path', 'native:open-external', 'native:stat-path', 'native:read-clipboard-image',
  'native:reveal-attachment', 'native:save-attachment', 'native:notify',
  'diagnostics:export', 'session:export', 'native:activity', 'window:set-chrome', 'update:check', 'update:install', 'update:skip-version', 'update:open-download',
  'desktop-state:get',
  'desktop-state:patch', 'app:quit-plan', 'app:quit-confirmed', 'app:cancel-quit',
] as const satisfies readonly IpcChannel[];

export const BROADCAST_CHANNELS = [
  'config:changed', 'sessions:changed', 'session:status', 'update:status',
  'theme:system-changed', 'app:quit-requested', 'session:focus', 'window:state',
] as const satisfies readonly BroadcastChannel[];

/** Channel the main process uses to hand a session's port to the preload. */
export const SESSION_PORT_CHANNEL = 'session-port';

/** Message type the preload forwards to the page together with the transferred port. */
export const SESSION_PORT_MESSAGE = 'aragon:session-port';

/** The API the preload exposes as `window.aragon`. Nothing else crosses the bridge. */
export interface AragonApi {
  invoke<K extends IpcChannel>(
    channel: K,
    arg?: IpcContract[K]['in'],
  ): Promise<IpcResult<IpcContract[K]['out']>>;
  on<K extends BroadcastChannel>(channel: K, listener: (payload: BroadcastContract[K]) => void): () => void;
  platform: PlatformName;
  /** Absolute path of a dropped `File`, or '' when it is not a file on disk. */
  pathForFile(file: File): string;
}

/** Re-export so renderer code needs one import for run status. */
export type { SessionRunStatus };
