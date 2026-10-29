/**
 * The implementation of every control-plane channel, over a `Services` bag.
 *
 * Each handler returns an `IpcResult` and never throws: `register()` wraps the lot, so an
 * unexpected exception becomes `{ ok: false, code: 'internal' }` (and a log line) instead of
 * an unhandled rejection in the main process. Arguments are validated BEFORE a handler runs
 * (see `ipc-validate`), and the sender must be one of OUR windows showing OUR page.
 */

import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { shell, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from 'electron';
import type { ConfigService } from './config-service.js';
import type { DesktopStateStore } from './desktop-state-store.js';
import type { Engine } from './engine-loader.js';
import { INVALID, IPC_VALIDATORS } from './ipc-validate.js';
import type { LogSink } from './logging.js';
import type { NativeBridge } from './native-bridge.js';
import type { SessionChannelService } from './session-channel.js';
import type { CatalogResult } from './skills-catalog.js';
import type { SessionIndex } from './session-index.js';
import type { SessionSupervisor } from './session-supervisor.js';
import type { WindowManager } from './window-manager.js';
import { isAllowedNavigation } from './protocols.js';
import { mergeRendererWindows, rememberWorkspace } from '../shared/desktop-state.js';
import {
  IPC_CHANNELS,
  type AppInfo,
  type IpcChannel,
  type IpcContract,
  type IpcErrorCode,
  type IpcResult,
  type PromptDto,
  type QuitPlan,
  type SessionExportRequestDto,
  type UpdateStatus,
} from '../shared/ipc-contract.js';

export interface Services {
  engine: Engine | null;
  engineError: string | null;
  config: ConfigService | null;
  state: DesktopStateStore;
  index: SessionIndex | null;
  supervisor: SessionSupervisor | null;
  channels: SessionChannelService;
  windows: WindowManager;
  native: NativeBridge | null;
  log: LogSink;
  devServer: string | null;
  isPackaged: boolean;
  versions: { desktop: string; electron: string; node: string };
  /** Session cwd by id, remembered when a session is opened. */
  sessionCwds: Map<string, string>;
  /** Installed skills for a directory, via a throwaway engine process (no session needed). */
  listSkills(cwd: string): Promise<CatalogResult>;
  checkForUpdate(): Promise<UpdateStatus>;
  installUpdate(): boolean;
  skipUpdateVersion(version: string): UpdateStatus;
  /** The `update` section of desktop-state changed (enabled / feed override). */
  updatePrefsChanged(): void;
  /** The validated download address of the update on offer, or null. */
  updateDownloadUrl(): string | null;
  exportDiagnostics(window: BrowserWindow | null): Promise<string | null>;
  /** Save a rendered transcript; wired once the engine (redactor, secrets) is available. */
  exportSession(window: BrowserWindow | null, request: SessionExportRequestDto): Promise<IpcResult<{ path: string }>>;
  confirmQuit(stopServices: boolean): void;
  cancelQuit(): void;
  acknowledgeConfigWrite(revision: string): void;
  quitPlan(): QuitPlan;
  /**
   * Settles once the engine has loaded (or failed to). The window opens BEFORE that so the first
   * paint is fast, which means the renderer's first requests can arrive while `services.state`
   * is still the in-memory placeholder: it would read default preferences (language, recent
   * workspaces) and the app would start in a state that looks like another user's. Every handler
   * waits on this instead.
   */
  ready: Promise<void>;
}

type Handler<K extends IpcChannel> = (
  arg: IpcContract[K]['in'],
  context: { window: BrowserWindow | null; event: IpcMainInvokeEvent },
) => Promise<IpcResult<IpcContract[K]['out']>> | IpcResult<IpcContract[K]['out']>;

type HandlerMap = { [K in IpcChannel]: Handler<K> };

const ok = <T>(value: T): IpcResult<T> => ({ ok: true, value });
const fail = (code: IpcErrorCode, message: string): IpcResult<never> => ({ ok: false, code, message });
const engineMissing = (services: Services): IpcResult<never> =>
  fail('engine_unavailable', services.engineError ?? 'The engine is not available.');

function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

export function buildHandlers(services: Services): HandlerMap {
  const { windows } = services;
  // `services.state` is REPLACED once the engine has told us the home directory; capturing the
  // object here would pin every handler to the in-memory placeholder and the app would never see
  // the user's saved preferences (found by the E2E run: recent workspaces and language were lost).
  const state: Pick<DesktopStateStore, 'get' | 'patch'> = {
    get: () => services.state.get(),
    patch: (patch) => services.state.patch(patch),
  };
  const needEngine = <T>(run: (engine: Engine, config: ConfigService) => T): IpcResult<T> | IpcResult<never> =>
    services.engine && services.config ? ok(run(services.engine, services.config)) : engineMissing(services);

  return {
    'app:info': () => {
      const info: AppInfo = {
        versions: {
          desktop: services.versions.desktop,
          cli: services.engine?.versions.cli ?? 'unavailable',
          core: services.engine?.versions.core ?? 'unavailable',
          tui: services.engine?.versions.tui ?? 'unavailable',
          electron: services.versions.electron,
          node: services.versions.node,
        },
        platform: process.platform,
        homeRoot: services.engine?.paths.getHomeRoot() ?? '',
        overridden: services.engine?.paths.isHomeOverridden() ?? false,
        engineError: services.engineError,
        isPackaged: services.isPackaged,
        ...(services.state.corruptNotice ? { preferencesReset: true } : {}),
      };
      return ok(info);
    },

    'config:get': () => needEngine((_engine, config) => config.read()),
    'config:patch': (arg) => needEngine((_engine, config) => {
      const result = config.patch(arg.baseRevision, arg.patch);
      if (result.ok) {
        services.acknowledgeConfigWrite(result.revision);
        config.registerSecrets();
      }
      return result;
    }),
    'config:reveal-key': (arg) => needEngine((_engine, config) => {
      services.log.log('info', 'config', 'api key revealed', { provider: arg.provider });
      return { key: config.revealKey(arg.provider, arg.profileId) };
    }),
    'config:test-connection': async (arg) => (services.config
      ? ok(await services.config.testConnection(arg)) : engineMissing(services)),
    'config:discover-models': async (arg) => (services.config
      ? ok({ models: await services.config.discoverModels(arg) }) : engineMissing(services)),
    'config:open-in-editor': async () => {
      if (!services.config) return engineMissing(services);
      return ok({ opened: (await shell.openPath(services.config.path)) === '' });
    },
    'config:restore-backup': () => needEngine((_engine, config) => ({ restored: config.restoreBackup() })),

    'sessions:list': async (arg) => {
      if (!services.index) return engineMissing(services);
      return ok(services.index.list(arg?.query));
    },

    'sessions:open': async (arg, { window }) => {
      const { engine, supervisor, index } = services;
      if (!engine || !supervisor || !index) return engineMissing(services);
      if (!window) return fail('internal', 'No window to attach the session to.');
      if (!isDirectory(arg.cwd)) return fail('path_not_allowed', 'The working directory does not exist.');
      let id = arg.id;
      let resume = true;
      if (arg.branchOf) {
        const branched = engine.sessions.branchSession(arg.branchOf);
        if (!branched.ok) return fail('not_found', 'The session to branch could not be read.');
        id = branched.id;
      } else if (!id) {
        id = engine.sessions.reserveNewSession() ?? undefined;
        resume = false;
        if (!id) return fail('write_failed', 'A new session could not be created in the sessions folder.');
      } else if (!supervisor.statusOf(id)
        && engine.sessions.isLiveOwnedElsewhere(id, supervisor.ownPids())) {
        return fail('session_busy_elsewhere', 'This session is open in a terminal.');
      }
      if (!windows.claim(id, window.id)) {
        const owner = windows.ownerOf(id);
        if (owner) windows.focus(owner);
        return fail('session_busy_elsewhere', 'This session is already open in another window.');
      }
      const opened = supervisor.open(id, arg.cwd, resume);
      if (!opened.ok) return fail('host_unavailable', opened.message);
      services.sessionCwds.set(id, arg.cwd);
      state.patch({ recentWorkspaces: rememberWorkspace(state.get(), arg.cwd).recentWorkspaces });
      const proc = supervisor.processOf(id);
      if (!proc) return fail('host_unavailable', 'The session host is not running.');
      const channelToken = services.channels.connect(id, proc, window.webContents, window.id);
      supervisor.setAttached(id, true);
      supervisor.touch(id);
      void index.refresh();
      return ok({ sessionId: id, channelToken });
    },

    'sessions:close': async (arg) => {
      const closed = services.supervisor ? await services.supervisor.close(arg.id) : false;
      windows.release(arg.id);
      services.sessionCwds.delete(arg.id);
      return ok({ closed });
    },
    'sessions:park': async (arg) => ok({ parked: services.supervisor ? await services.supervisor.park(arg.id) : false }),
    'sessions:restart': async (arg) => ok({ restarted: services.supervisor ? await services.supervisor.restart(arg.id) : false }),
    'sessions:pin': async (arg) => {
      if (!services.engine) return engineMissing(services);
      const pinned = services.engine.sessions.pinSession(arg.id, arg.pinned);
      void services.index?.refresh();
      return pinned ? ok({ pinned: arg.pinned }) : fail('not_found', 'The session file could not be updated.');
    },
    'sessions:remove': async (arg) => {
      if (!services.engine) return engineMissing(services);
      if (!arg.confirm) return fail('invalid_argument', 'Deleting a session needs confirmation.');
      if (services.supervisor?.statusOf(arg.id)) await services.supervisor.close(arg.id);
      const removed = services.engine.sessions.removeSession(arg.id);
      void services.index?.refresh();
      return ok({ removed });
    },
    'sessions:branch': (arg) => {
      if (!services.engine) return engineMissing(services);
      const branched = services.engine.sessions.branchSession(arg.id);
      void services.index?.refresh();
      return branched.ok ? ok({ id: branched.id }) : fail('not_found', 'The session could not be branched.');
    },

    'workspace:pick': async (_arg, { window }) => ok({ path: services.native ? await services.native.pickFolder(window) : null }),
    'workspace:recent': () => ok(state.get().recentWorkspaces),

    'skills:list': async (arg) => {
      if (!services.engine) return engineMissing(services);
      const cwd = arg?.cwd ?? state.get().recentWorkspaces[0] ?? homedir();
      if (!isDirectory(cwd)) return fail('invalid_argument', 'That directory does not exist.');
      const result = await services.listSkills(cwd);
      return result.ok ? ok({ skills: result.skills }) : fail('host_unavailable', result.message);
    },

    'prompts:list': () => needEngine((engine) => {
      const library = engine.prompts.loadPromptLibrary();
      return library.prompts.map((prompt): PromptDto => ({
        id: prompt.id, title: prompt.title, content: prompt.content,
        ...(prompt.description ? { description: prompt.description } : {}),
        ...(prompt.tags ? { tags: [...prompt.tags] } : {}),
        ...(prompt.favorite ? { favorite: true } : {}),
        useCount: prompt.useCount, updatedAt: prompt.updatedAt,
      }));
    }),
    'prompts:create': (arg) => {
      if (!services.engine) return engineMissing(services);
      const result = services.engine.prompts.createPrompt(arg);
      return result.ok ? ok({ id: result.id ?? '' }) : fail('invalid_argument', `The prompt was not saved (${result.code}).`);
    },
    'prompts:update': (arg) => {
      if (!services.engine) return engineMissing(services);
      const result = services.engine.prompts.updatePrompt(arg.id, arg.patch);
      return result.ok ? ok({ ok: true as const }) : fail('invalid_argument', `The prompt was not saved (${result.code}).`);
    },
    'prompts:delete': (arg) => {
      if (!services.engine) return engineMissing(services);
      const result = services.engine.prompts.deletePrompt(arg.id);
      return result.ok ? ok({ ok: true as const }) : fail('not_found', 'The prompt could not be deleted.');
    },
    'prompts:favorite': (arg) => {
      if (!services.engine) return engineMissing(services);
      const result = services.engine.prompts.setPromptFavorite(arg.id, arg.favorite);
      return result.ok ? ok({ ok: true as const }) : fail('not_found', 'The prompt could not be updated.');
    },
    'prompts:use': (arg) => needEngine((engine) => {
      engine.prompts.recordPromptUse(arg.id);
      return { ok: true as const };
    }),

    'native:open-path': async (arg) => (services.native
      ? ok({ opened: await services.native.openPath(arg.sessionId, arg.relPath, arg.reveal === true) })
      : fail('internal', 'Native features are unavailable.')),
    'native:open-external': async (arg) => (services.native
      ? ok({ opened: await services.native.openExternal(arg.url) })
      : fail('internal', 'Native features are unavailable.')),
    'native:notify': (arg) => ok({ shown: services.native?.notify(arg.title, arg.body, arg.sessionId) ?? false }),

    'diagnostics:export': async (_arg, { window }) => ok({ savedTo: await services.exportDiagnostics(window) }),
    'session:export': (arg, { window }) => services.exportSession(window, arg),
    'native:activity': (arg, { window }) => ok({ applied: services.native?.setActivity(arg, window) ?? false }),
    'window:set-chrome': (arg, { window }) => ok({ applied: window ? services.windows.setChromeTheme(window, arg.theme) : false }),
    'update:check': async () => ok(await services.checkForUpdate()),
    'update:install': () => ok({ started: services.installUpdate() }),
    'update:skip-version': (arg) => ok(services.skipUpdateVersion(arg.version)),
    'update:open-download': async () => {
      const url = services.updateDownloadUrl();
      return ok({ opened: url !== null && services.native ? await services.native.openExternal(url) : false });
    },

    'desktop-state:get': () => ok(state.get()),
    'desktop-state:patch': (arg) => {
      // The renderer owns panel layout only; geometry stays whatever the main process last saw.
      const safe = 'windows' in arg
        ? { ...arg, windows: mergeRendererWindows(state.get().windows, arg.windows) as typeof arg.windows }
        : arg;
      const next = state.patch(safe);
      if ('update' in arg) services.updatePrefsChanged();
      return ok(next);
    },

    'app:quit-plan': () => ok(services.quitPlan()),
    'app:quit-confirmed': (arg) => { services.confirmQuit(arg.stopServices); return ok({ quitting: true as const }); },
    'app:cancel-quit': () => { services.cancelQuit(); return ok({ cancelled: true as const }); },
  };
}

/** Only our own windows, showing our own page, may call in. */
export function isTrustedSender(event: IpcMainInvokeEvent, devServer: string | null): boolean {
  const frame = event.senderFrame;
  if (!frame || frame.parent !== null) return false; // top-level frame only
  return isAllowedNavigation(frame.url, devServer);
}

export function registerIpc(ipc: IpcMain, services: Services): () => void {
  const handlers = buildHandlers(services);
  for (const channel of IPC_CHANNELS) {
    ipc.handle(channel, async (event, raw: unknown): Promise<IpcResult<unknown>> => {
      if (!isTrustedSender(event, services.devServer)) {
        services.log.log('warn', 'ipc', 'rejected an untrusted sender', { channel });
        return fail('invalid_argument', 'Request rejected.');
      }
      const validate = IPC_VALIDATORS[channel] as (value: unknown) => unknown;
      const arg = validate(raw);
      if (arg === INVALID) return fail('invalid_argument', `Invalid argument for ${channel}.`);
      try {
        await services.ready;
        const window = services.windows.fromWebContentsId(event.sender.id);
        return await (handlers[channel] as Handler<IpcChannel>)(arg as never, { window, event });
      } catch (error) {
        services.log.log('error', 'ipc', `${channel} threw`, { message: error instanceof Error ? error.message : String(error) });
        return fail('internal', 'The request failed unexpectedly.');
      }
    });
  }
  return () => { for (const channel of IPC_CHANNELS) ipc.removeHandler(channel); };
}
