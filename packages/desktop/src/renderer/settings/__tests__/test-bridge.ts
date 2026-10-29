/**
 * A fake `window.aragon` for component tests: each channel gets a handler that returns an
 * `IpcResult`; an unhandled channel answers with a loud failure rather than hanging.
 */

import { vi } from 'vitest';
import type { BroadcastChannel, BroadcastContract, IpcChannel, IpcErrorCode, IpcResult } from '../../../shared/ipc-contract.js';

export const ok = <T,>(value: T): IpcResult<T> => ({ ok: true, value });
export const fail = (code: IpcErrorCode, message: string): IpcResult<never> => ({ ok: false, code, message });

type Handler = (arg: never) => IpcResult<unknown> | Promise<IpcResult<unknown>>;

export interface TestBridge {
  invoke: ReturnType<typeof vi.fn>;
  /** The arguments of every call to a channel, in order. */
  calls(channel: IpcChannel): unknown[];
  emit<K extends BroadcastChannel>(channel: K, payload: BroadcastContract[K]): void;
  set(channel: IpcChannel, handler: Handler): void;
}

export function installBridge(initial: Partial<Record<IpcChannel, Handler>> = {}, platform = 'win32'): TestBridge {
  const handlers = new Map<string, Handler>(Object.entries(initial) as Array<[string, Handler]>);
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const log: Array<{ channel: string; arg: unknown }> = [];
  const invoke = vi.fn(async (channel: string, arg: unknown) => {
    log.push({ channel, arg });
    const handler = handlers.get(channel);
    if (!handler) return fail('internal', `unhandled channel ${channel}`);
    return handler(arg as never);
  });
  const on = (channel: string, listener: (payload: unknown) => void): (() => void) => {
    const set = listeners.get(channel) ?? new Set();
    set.add(listener);
    listeners.set(channel, set);
    return () => { set.delete(listener); };
  };
  Object.defineProperty(window, 'aragon', { value: { invoke, on, platform }, configurable: true, writable: true });
  return {
    invoke,
    calls: (channel) => log.filter((entry) => entry.channel === channel).map((entry) => entry.arg),
    emit: (channel, payload) => { for (const listener of listeners.get(channel) ?? []) listener(payload); },
    set: (channel, handler) => { handlers.set(channel, handler); },
  };
}

export function removeBridge(): void {
  Reflect.deleteProperty(window, 'aragon');
}
