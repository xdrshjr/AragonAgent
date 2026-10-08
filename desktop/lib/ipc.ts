/**
 * Renderer-side typed client over the preload bridge.
 *
 * `window.aragon` exists only inside Electron; the web fallback throws lazily
 * so a stray `next dev` browser tab fails loudly at call time, not at import
 * time (the shell renders a setup hint instead).
 */

import type { ExecEvent } from '@shared/exec-events';
import type {
  AppInfo,
  CreateSessionInput,
  ProfileDraftInput,
  RenameInput,
  SaveSettingsInput,
  SaveSettingsResult,
  SessionMeta,
  SessionOpenResult,
  SessionPhase,
  SettingsSnapshot,
  TestOutcome,
  TestProgressStep,
} from '@shared/protocol';

export interface AragonBridge {
  sessions: {
    list(): Promise<SessionMeta[]>;
    create(input: CreateSessionInput): Promise<SessionMeta>;
    open(id: string): Promise<SessionOpenResult>;
    send(id: string, text: string): Promise<void>;
    interrupt(id: string): Promise<void>;
    close(id: string): Promise<void>;
    remove(id: string): Promise<void>;
    rename(input: RenameInput): Promise<void>;
    setCwd(id: string, cwd: string): Promise<void>;
    setProfile(id: string, profileId: string): Promise<void>;
    clearContext(id: string): Promise<SessionMeta | null>;
  };
  settings: {
    get(): Promise<SettingsSnapshot>;
    save(input: SaveSettingsInput): Promise<SaveSettingsResult>;
    test(draft: ProfileDraftInput): Promise<TestOutcome>;
  };
  dialogs: { pickDirectory(): Promise<string | null> };
  shell: { openPath(path: string): Promise<string> };
  app: { info(): Promise<AppInfo> };
  onSessionEvent(cb: (sessionId: string, event: ExecEvent) => void): () => void;
  onSessionPhase(cb: (sessionId: string, phase: SessionPhase) => void): () => void;
  onSessionListChanged(cb: (sessions: SessionMeta[]) => void): () => void;
  onTestProgress(cb: (step: TestProgressStep) => void): () => void;
}

export function bridge(): AragonBridge {
  const api = (window as { aragon?: AragonBridge }).aragon;
  if (!api) {
    throw new Error('window.aragon is unavailable - open this app through the Electron shell.');
  }
  return api;
}

export function hasBridge(): boolean {
  return typeof window !== 'undefined' && (window as { aragon?: unknown }).aragon !== undefined;
}
