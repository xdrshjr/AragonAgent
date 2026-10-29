/**
 * Typed access to `window.aragon`, the preload's whole API.
 *
 * `ipc()` returns the raw `IpcResult` (callers that want to branch on `code` use it);
 * `ipcValue()` unwraps or throws an `IpcError`, for call sites that just want the value and
 * let an error boundary or a toast handle the failure.
 */

import type {
  AragonApi,
  BroadcastChannel,
  BroadcastContract,
  IpcChannel,
  IpcContract,
  IpcErrorCode,
  IpcResult,
  PlatformName,
} from '../shared/ipc-contract.js';

declare global {
  interface Window {
    aragon: AragonApi;
  }
}

export class IpcError extends Error {
  constructor(readonly code: IpcErrorCode, message: string) {
    super(message);
    this.name = 'IpcError';
  }
}

export function hasBridge(): boolean {
  return typeof window !== 'undefined' && typeof window.aragon?.invoke === 'function';
}

export function platform(): PlatformName {
  return hasBridge() ? window.aragon.platform : 'win32';
}

export async function ipc<K extends IpcChannel>(
  channel: K,
  ...arg: IpcContract[K]['in'] extends void ? [] : [IpcContract[K]['in']]
): Promise<IpcResult<IpcContract[K]['out']>> {
  if (!hasBridge()) return { ok: false, code: 'internal', message: 'The desktop bridge is not available.' };
  try {
    return await window.aragon.invoke(channel, arg[0] as IpcContract[K]['in']);
  } catch (error) {
    return { ok: false, code: 'internal', message: error instanceof Error ? error.message : String(error) };
  }
}

export async function ipcValue<K extends IpcChannel>(
  channel: K,
  ...arg: IpcContract[K]['in'] extends void ? [] : [IpcContract[K]['in']]
): Promise<IpcContract[K]['out']> {
  const result = await (ipc as (c: K, ...a: unknown[]) => Promise<IpcResult<IpcContract[K]['out']>>)(channel, ...arg);
  if (!result.ok) throw new IpcError(result.code, result.message);
  return result.value;
}

export function onBroadcast<K extends BroadcastChannel>(
  channel: K,
  listener: (payload: BroadcastContract[K]) => void,
): () => void {
  return hasBridge() ? window.aragon.on(channel, listener) : () => undefined;
}
