/// <reference lib="dom" />
/**
 * Sandboxed preload: the ONLY bridge between the page and the main process.
 *
 * It exposes exactly `window.aragon` (see `AragonApi`) and nothing else - no `ipcRenderer`, no
 * way to name an arbitrary channel. `invoke` and `on` re-check their channel against the same
 * allow-lists the main process registers from, so even a page that was talked into passing a
 * hostile channel string cannot reach a handler that is not on the list.
 *
 * Session ports take the other route: a `MessagePort` cannot cross `contextBridge`, so when
 * the main process hands one over, this script forwards it to the page with
 * `window.postMessage(..., [port])`. The page adopts it only if it carries the one-time token
 * `sessions:open` returned (see renderer `port-client`).
 *
 * Built by esbuild into one CommonJS file: a sandboxed preload can `require` almost nothing.
 */

import { contextBridge, ipcRenderer, webUtils } from 'electron';
import {
  BROADCAST_CHANNELS,
  IPC_CHANNELS,
  SESSION_PORT_CHANNEL,
  SESSION_PORT_MESSAGE,
  type AragonApi,
  type BroadcastChannel,
  type IpcChannel,
} from '../shared/ipc-contract.js';

const invokable = new Set<string>(IPC_CHANNELS);
const broadcast = new Set<string>(BROADCAST_CHANNELS);

const api: AragonApi = {
  invoke: ((channel: IpcChannel, arg?: unknown) => {
    if (!invokable.has(channel)) {
      return Promise.resolve({ ok: false, code: 'invalid_argument', message: `Unknown channel "${String(channel)}".` });
    }
    return ipcRenderer.invoke(channel, arg);
  }) as AragonApi['invoke'],

  on: ((channel: BroadcastChannel, listener: (payload: unknown) => void) => {
    if (!broadcast.has(channel)) return () => undefined;
    const handler = (_event: unknown, payload: unknown): void => listener(payload);
    ipcRenderer.on(channel, handler);
    return () => { ipcRenderer.removeListener(channel, handler); };
  }) as AragonApi['on'],

  platform: process.platform,

  // A sandboxed page has no `File.path`; the preload resolves it. Returns '' when the File is
  // not backed by a file on disk (for example content dragged out of a browser tab).
  pathForFile: (file: File): string => {
    try { return webUtils.getPathForFile(file); } catch { return ''; }
  },
};

contextBridge.exposeInMainWorld('aragon', api);

ipcRenderer.on(SESSION_PORT_CHANNEL, (event, payload: { sessionId?: unknown; token?: unknown }) => {
  if (typeof payload?.sessionId !== 'string' || typeof payload?.token !== 'string') return;
  window.postMessage(
    { type: SESSION_PORT_MESSAGE, sessionId: payload.sessionId, token: payload.token },
    window.location.origin,
    [...event.ports],
  );
});
