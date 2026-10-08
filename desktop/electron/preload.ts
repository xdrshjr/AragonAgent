/**
 * Preload bridge: the ONLY renderer-visible native surface.
 *
 * contextIsolation + sandbox: the renderer gets a typed `window.aragon` object
 * and nothing else - no ipcRenderer, no Node. Push channels subscribe through
 * `on*` helpers that return an unsubscribe function.
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { ExecEvent } from '../shared/exec-events';
import type {
  AppInfo,
  CreateSessionInput,
  RenameInput,
  SaveSettingsInput,
  SaveSettingsResult,
  SessionMeta,
  SessionOpenResult,
  SessionPhase,
  SettingsSnapshot,
  TestOutcome,
  TestProgressStep,
} from '../shared/protocol';
import { CHANNELS } from '../shared/protocol';

type SessionEventCallback = (sessionId: string, event: ExecEvent) => void;
type SessionPhaseCallback = (sessionId: string, phase: SessionPhase) => void;
type SessionListCallback = (sessions: SessionMeta[]) => void;
type TestProgressCallback = (step: TestProgressStep) => void;

const api = {
  sessions: {
    list: (): Promise<SessionMeta[]> => ipcRenderer.invoke(CHANNELS.sessionsList),
    create: (input: CreateSessionInput): Promise<SessionMeta> =>
      ipcRenderer.invoke(CHANNELS.sessionsCreate, input),
    open: (id: string): Promise<SessionOpenResult> => ipcRenderer.invoke(CHANNELS.sessionsOpen, id),
    send: (id: string, text: string): Promise<void> => ipcRenderer.invoke(CHANNELS.sessionsSend, id, text),
    interrupt: (id: string): Promise<void> => ipcRenderer.invoke(CHANNELS.sessionsInterrupt, id),
    close: (id: string): Promise<void> => ipcRenderer.invoke(CHANNELS.sessionsClose, id),
    remove: (id: string): Promise<void> => ipcRenderer.invoke(CHANNELS.sessionsRemove, id),
    rename: (input: RenameInput): Promise<void> => ipcRenderer.invoke(CHANNELS.sessionsRename, input),
    setCwd: (id: string, cwd: string): Promise<void> =>
      ipcRenderer.invoke(CHANNELS.sessionsSetCwd, id, cwd),
    setProfile: (id: string, profileId: string): Promise<void> =>
      ipcRenderer.invoke(CHANNELS.sessionsSetProfile, id, profileId),
    clearContext: (id: string): Promise<SessionMeta | null> =>
      ipcRenderer.invoke(CHANNELS.sessionsClearContext, id),
  },
  settings: {
    get: (): Promise<SettingsSnapshot> => ipcRenderer.invoke(CHANNELS.settingsGet),
    save: (input: SaveSettingsInput): Promise<SaveSettingsResult> =>
      ipcRenderer.invoke(CHANNELS.settingsSave, input),
    test: (draft: unknown): Promise<TestOutcome> => ipcRenderer.invoke(CHANNELS.settingsTest, draft),
  },
  dialogs: {
    pickDirectory: (): Promise<string | null> => ipcRenderer.invoke(CHANNELS.dialogPickDir),
  },
  shell: {
    openPath: (path: string): Promise<string> => ipcRenderer.invoke(CHANNELS.shellOpenPath, path),
  },
  app: {
    info: (): Promise<AppInfo> => ipcRenderer.invoke(CHANNELS.appInfo),
  },
  onSessionEvent: (callback: SessionEventCallback): (() => void) => {
    const listener = (_e: unknown, sessionId: string, event: ExecEvent): void =>
      callback(sessionId, event);
    ipcRenderer.on(CHANNELS.sessionEvent, listener);
    return () => ipcRenderer.removeListener(CHANNELS.sessionEvent, listener);
  },
  onSessionPhase: (callback: SessionPhaseCallback): (() => void) => {
    const listener = (_e: unknown, sessionId: string, phase: SessionPhase): void =>
      callback(sessionId, phase);
    ipcRenderer.on(CHANNELS.sessionPhase, listener);
    return () => ipcRenderer.removeListener(CHANNELS.sessionPhase, listener);
  },
  onSessionListChanged: (callback: SessionListCallback): (() => void) => {
    const listener = (_e: unknown, sessions: SessionMeta[]): void => callback(sessions);
    ipcRenderer.on(CHANNELS.sessionListChanged, listener);
    return () => ipcRenderer.removeListener(CHANNELS.sessionListChanged, listener);
  },
  onTestProgress: (callback: TestProgressCallback): (() => void) => {
    // Main sends (testId, step); the renderer today only needs the step.
    const listener = (_e: unknown, _testId: string, step: TestProgressStep): void => callback(step);
    ipcRenderer.on(CHANNELS.testProgress, listener);
    return () => ipcRenderer.removeListener(CHANNELS.testProgress, listener);
  },
};

export type AragonApi = typeof api;

contextBridge.exposeInMainWorld('aragon', api);
