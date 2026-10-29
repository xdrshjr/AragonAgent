/**
 * Hands a session's `MessagePort` pair to its host and to the window that opened it.
 *
 * A `MessagePort` is a transferable object: it cannot cross `contextBridge`, so the route is
 *   main --webContents.postMessage('session-port', {sessionId, token}, [port2])--> preload
 *        --window.postMessage({type, sessionId, token}, origin, [port])-->         page
 * and the page only adopts a port whose `token` it was given by `sessions:open`. Tokens are
 * one-time and short-lived, so a script injected into the page cannot receive a session's
 * port: it never held a valid token.
 *
 * Opening an already-live session (a window reload, a second `sessions:open`) simply issues
 * a fresh pair: the host replaces the old port and answers the new one with a snapshot.
 */

import { randomBytes } from 'node:crypto';
import { MessageChannelMain, type WebContents } from 'electron';
import { SESSION_PORT_CHANNEL } from '../shared/ipc-contract.js';
import type { HostProcess } from './session-supervisor.js';

export const TOKEN_TTL_MS = 30_000;

/** One-time, expiring tokens bound to a (session, window) pair. Pure; no Electron. */
export class TokenStore {
  private readonly tokens = new Map<string, { sessionId: string; windowId: number; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  issue(sessionId: string, windowId: number): string {
    this.sweep();
    const token = randomBytes(24).toString('base64url');
    this.tokens.set(token, { sessionId, windowId, expiresAt: this.now() + TOKEN_TTL_MS });
    return token;
  }

  /** Consume a token; true only for a live, matching, never-used one. */
  consume(token: string, sessionId: string, windowId: number): boolean {
    const entry = this.tokens.get(token);
    this.tokens.delete(token);
    return Boolean(entry && entry.expiresAt >= this.now() && entry.sessionId === sessionId && entry.windowId === windowId);
  }

  private sweep(): void {
    const now = this.now();
    for (const [token, entry] of this.tokens) if (entry.expiresAt < now) this.tokens.delete(token);
  }
}

export class SessionChannelService {
  readonly tokens = new TokenStore();

  /** Create a port pair; one end goes to the host, the other to the window. */
  connect(sessionId: string, proc: HostProcess, target: WebContents, windowId: number): string {
    const token = this.tokens.issue(sessionId, windowId);
    const { port1, port2 } = new MessageChannelMain();
    proc.postMessage({ v: 1, kind: 'port' }, [port1]);
    target.postMessage(SESSION_PORT_CHANNEL, { sessionId, token }, [port2]);
    return token;
  }
}
