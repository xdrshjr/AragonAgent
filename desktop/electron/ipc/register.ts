/**
 * IPC surface: wires renderer invokes to the session registry and settings
 * store. Every handler is registered here so the channel names in
 * `shared/protocol.ts` stay the single source of truth.
 */

import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import type { SessionRegistry } from '../agent/registry';
import type { SettingsStore } from '../settings/store';
import type { ProfileDraftInput, SaveSettingsInput } from '../../shared/protocol';
import { CHANNELS } from '../../shared/protocol';
import { runProfileTest } from '../settings/test-connection';
import { resolveRuntime } from '../agent/runtime';

export interface IpcDeps {
  getWindow: () => BrowserWindow | null;
  registry: SessionRegistry;
  settings: SettingsStore;
  launcherPath: () => string;
}

export function registerIpc(deps: IpcDeps): void {
  const send = (channel: string, ...args: unknown[]): void => {
    const win = deps.getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
  };

  ipcMain.handle(CHANNELS.sessionsList, () => deps.registry.list());
  ipcMain.handle(
    CHANNELS.sessionsCreate,
    (_event, input: { cwd: string; profileId: string; title?: string }) => deps.registry.create(input),
  );
  ipcMain.handle(CHANNELS.sessionsOpen, (_event, id: string) => deps.registry.open(id));
  ipcMain.handle(CHANNELS.sessionsSend, (_event, id: string, text: string) => deps.registry.send(id, text));
  ipcMain.handle(CHANNELS.sessionsInterrupt, (_event, id: string) => deps.registry.interrupt(id));
  ipcMain.handle(CHANNELS.sessionsClose, (_event, id: string) => deps.registry.close(id));
  ipcMain.handle(CHANNELS.sessionsRemove, (_event, id: string) => deps.registry.remove(id));
  ipcMain.handle(
    CHANNELS.sessionsRename,
    (_event, input: { id: string; title: string }) => deps.registry.rename(input),
  );
  ipcMain.handle(
    CHANNELS.sessionsSetCwd,
    (_event, id: string, cwd: string) => deps.registry.setCwd(id, cwd),
  );
  ipcMain.handle(
    CHANNELS.sessionsSetProfile,
    (_event, id: string, profileId: string) => deps.registry.setProfile(id, profileId),
  );
  ipcMain.handle(
    CHANNELS.sessionsClearContext,
    (_event, id: string) => deps.registry.clearContext(id),
  );

  ipcMain.handle(CHANNELS.settingsGet, () => deps.settings.snapshot());
  ipcMain.handle(CHANNELS.settingsSave, (_event, input: SaveSettingsInput) => deps.settings.save(input));
  ipcMain.handle(CHANNELS.settingsTest, (_event, draft: ProfileDraftInput) =>
    runProfileTest(
      {
        settings: deps.settings,
        launcherPath: deps.launcherPath,
        execPath: process.execPath,
        send,
      },
      draft,
    ),
  );

  ipcMain.handle(CHANNELS.dialogPickDir, async () => {
    const win = deps.getWindow();
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  /**
   * Open a directory in the OS file manager. Only directories are accepted -
   * the renderer only ever passes a session cwd, and keeping the check here
   * means a compromised renderer cannot use this to launch arbitrary files.
   */
  ipcMain.handle(CHANNELS.shellOpenPath, async (_event, target: string) => {
    try {
      const stat = await fs.stat(target);
      if (!stat.isDirectory()) return 'not_a_directory';
    } catch {
      return 'not_found';
    }
    return shell.openPath(target);
  });

  ipcMain.handle(CHANNELS.appInfo, () => {
    const runtime = resolveRuntime();
    return {
      version: app.getVersion(),
      runtimeSource: runtime.source,
      cliPath: runtime.launcherPath,
      platform: process.platform,
      homeDir: os.homedir(),
    };
  });
}
