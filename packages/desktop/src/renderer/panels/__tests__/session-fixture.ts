/**
 * A session mirror without a host: the real `SessionStore` fed through a fake `MessagePort`,
 * with state built by the real `viewReducer`. Commands the panel sends are answered by the
 * test's handler, exactly as the host's `ack` would.
 */

import { initialViewState, viewReducer, type ViewAction, type ViewState } from '@aragon-agent/tui/model/agent/reducer';
import type { CommandResult, HostCommand, RendererMsg, SessionMetaView } from '../../../shared/port-protocol.js';
import { sessionStore } from '../../store/session-store.js';

export type CommandHandler = (cmd: HostCommand) => CommandResult | Promise<CommandResult>;

class FakePort {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  readonly commands: HostCommand[] = [];
  constructor(private readonly handler: CommandHandler) {}
  postMessage(message: RendererMsg): void {
    if (message.t !== 'cmd') return;
    this.commands.push(message.cmd);
    void Promise.resolve(this.handler(message.cmd)).then((result) => {
      this.onmessage?.({ data: { v: 1, t: 'ack', id: message.id, result } });
    });
  }
  addEventListener(): void { /* the real port reports a dead peer here */ }
  start(): void { /* messages flow as soon as onmessage is set */ }
  close(): void { /* nothing to release */ }
}

export interface MountedSession {
  id: string;
  /** Every command the UI has sent, in order. */
  commands: HostCommand[];
  /** Apply a host action, as the host would stream it. */
  push(...actions: ViewAction[]): void;
}

export const META: SessionMetaView = {
  sessionId: 's1', cwd: '/work', provider: 'anthropic', model: 'm', resumed: false,
  postureCycle: ['build'], governanceUnavailable: null, slashCommands: [],
  imageInput: { support: 'yes', source: 'catalog', tokenEstimate: 1600 },
};

export const run = (actions: ViewAction[], state: ViewState = initialViewState()): ViewState =>
  actions.reduce(viewReducer, state);

export function mountSession(
  id: string,
  state: ViewState,
  options: { handler?: CommandHandler; meta?: Partial<SessionMetaView> } = {},
): MountedSession {
  sessionStore.begin(id);
  const port = new FakePort(options.handler ?? (() => ({ ok: true })));
  sessionStore.attach(id, port as unknown as MessagePort);
  let seq = 0;
  port.onmessage?.({ data: { v: 1, t: 'snap', epoch: 1, seq, state, meta: { ...META, sessionId: id, ...options.meta } } });
  return {
    id, commands: port.commands,
    push: (...actions) => {
      seq += 1;
      port.onmessage?.({ data: { v: 1, t: 'acts', seq, actions } });
    },
  };
}

export function unmountSession(id: string): void {
  sessionStore.end(id);
}
