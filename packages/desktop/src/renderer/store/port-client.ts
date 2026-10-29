/**
 * The renderer's end of a session's `MessagePort`.
 *
 * TWO JOBS, BOTH ABOUT NOT BEING FOOLED:
 *
 * 1. Receiving the port. The main process transfers it during `sessions:open`, i.e. BEFORE the
 *    invoke's reply (which carries the one-time token) reaches us - so the inbox below is
 *    installed at startup and buffers ports by token. A port is accepted only when the message
 *    came from this very window, from our own origin, carrying a token the main process issued
 *    for exactly this session. Anything else is dropped; a script injected into the page never
 *    held a valid token and so can never get a session.
 * 2. Commands. Every command gets an id and exactly one answer: the host's `ack`, a 15 s
 *    `timeout`, or `port_closed` if the port dies first. A command promise that can hang
 *    forever is how a UI ends up with a spinner nobody can dismiss, so none can.
 */

import {
  COMMAND_TIMEOUT_MS,
  type CommandResult,
  type HostCommand,
  type HostMsg,
  type HostResponse,
  type RendererMsg,
} from '../../shared/port-protocol.js';
import { SESSION_PORT_MESSAGE } from '../../shared/ipc-contract.js';

interface BufferedPort {
  port: MessagePort;
  sessionId: string;
  expiresAt: number;
}

const BUFFER_TTL_MS = 30_000;
const inbox = new Map<string, BufferedPort>();
const waiters = new Map<string, (port: MessagePort) => void>();
let installed = false;

/** Install the window-level listener once, as early as possible (called from `main.tsx`). */
export function installPortInbox(target: Window = window): void {
  if (installed) return;
  installed = true;
  target.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== target || event.origin !== target.location.origin) return;
    const data = event.data as { type?: unknown; sessionId?: unknown; token?: unknown } | null;
    if (!data || data.type !== SESSION_PORT_MESSAGE) return;
    if (typeof data.sessionId !== 'string' || typeof data.token !== 'string') return;
    if (event.ports.length !== 1) return;
    const port = event.ports[0]!;
    const waiter = waiters.get(data.token);
    if (waiter) {
      waiters.delete(data.token);
      waiter(port);
      return;
    }
    sweep();
    inbox.set(data.token, { port, sessionId: data.sessionId, expiresAt: Date.now() + BUFFER_TTL_MS });
  });
}

function sweep(): void {
  const now = Date.now();
  for (const [token, entry] of inbox) {
    if (entry.expiresAt < now) {
      try { entry.port.close(); } catch { /* already closed */ }
      inbox.delete(token);
    }
  }
}

/**
 * Take the port that belongs to `token` (and `sessionId`). One-time: the token is consumed
 * whether or not it matched, so a guessed token gets one try. Rejects after `timeoutMs`.
 */
export function takePort(sessionId: string, token: string, timeoutMs = 10_000): Promise<MessagePort> {
  sweep();
  const buffered = inbox.get(token);
  if (buffered) {
    inbox.delete(token);
    if (buffered.sessionId === sessionId) return Promise.resolve(buffered.port);
    try { buffered.port.close(); } catch { /* ignore */ }
    return Promise.reject(new Error('The session port did not match its token.'));
  }
  return new Promise<MessagePort>((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(token);
      reject(new Error('The session did not connect in time.'));
    }, timeoutMs);
    waiters.set(token, (port) => {
      clearTimeout(timer);
      resolve(port);
    });
  });
}

export interface SessionPortHandlers {
  onMessage(message: HostMsg): void;
  onClose(): void;
}

interface PendingCommand {
  resolve(result: CommandResult): void;
  timer: ReturnType<typeof setTimeout>;
}

export class SessionPort {
  private readonly pending = new Map<string, PendingCommand>();
  private closed = false;
  private nextId = 1;

  constructor(
    private readonly port: MessagePort,
    private readonly handlers: SessionPortHandlers,
    private readonly timeoutMs: number = COMMAND_TIMEOUT_MS,
  ) {
    port.onmessage = (event: MessageEvent) => this.receive(event.data);
    // Chromium fires `close` on a port whose peer went away (the host died or was parked).
    (port as EventTarget).addEventListener('close', () => this.close());
    port.start();
  }

  private receive(data: unknown): void {
    const message = data as HostMsg;
    if (!message || typeof message !== 'object' || message.v !== 1) return;
    if (message.t === 'ack') {
      const entry = this.pending.get(message.id);
      if (!entry) return; // already timed out
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      entry.resolve(message.result);
      return;
    }
    this.handlers.onMessage(message);
  }

  /** Send a command; always resolves (never rejects, never hangs). */
  command(cmd: HostCommand): Promise<CommandResult> {
    if (this.closed) return Promise.resolve({ ok: false, code: 'port_closed', message: 'The session is not connected.' });
    const id = `c${this.nextId++}`;
    return new Promise<CommandResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, code: 'timeout', message: 'The session did not answer in time.' });
      }, this.timeoutMs);
      this.pending.set(id, { resolve, timer });
      this.post({ v: 1, t: 'cmd', id, cmd });
    });
  }

  respond(id: string, res: HostResponse): void {
    this.post({ v: 1, t: 'res', id, res });
  }

  resync(): void {
    this.post({ v: 1, t: 'resync' });
  }

  private post(message: RendererMsg): void {
    if (this.closed) return;
    try {
      this.port.postMessage(message);
    } catch {
      this.close();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve({ ok: false, code: 'port_closed', message: 'The session is not connected.' });
      this.pending.delete(id);
    }
    try { this.port.close(); } catch { /* ignore */ }
    this.handlers.onClose();
  }
}
