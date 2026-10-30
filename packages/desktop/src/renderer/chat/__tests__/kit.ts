/**
 * Test kit: a fake host behind the REAL session store.
 *
 * The store is driven exactly as in production (a `MessagePort`-shaped object receives `snap` /
 * `act` / `req` messages and answers commands with `ack`), so the components under test run
 * against the real reducer, selectors and answer path. Only the far end of the port is fake.
 */

import { act } from '@testing-library/react';
import { initialViewState, viewReducer, type ViewAction, type ViewState } from '@aragon-agent/tui/model/agent/reducer';
import type { CommandResult, HostCommand, HostMsg, HostRequest, RendererMsg, SessionMetaView } from '../../../shared/port-protocol.js';
import { sessionStore } from '../../store/session-store.js';

export type Responder = (command: HostCommand) => CommandResult | Promise<CommandResult>;

const DEFAULT_META: SessionMetaView = {
  sessionId: 's1', cwd: '/work/repo', provider: 'anthropic', model: 'test-model', resumed: false,
  postureCycle: ['build', 'plan'], governanceUnavailable: 'Governance is off.', slashCommands: [],
  imageInput: { support: 'yes', source: 'catalog', tokenEstimate: 1600 },
};

export class FakeHost {
  readonly sent: RendererMsg[] = [];
  readonly commands: HostCommand[] = [];
  private seq = 0;
  private handler: ((event: MessageEvent) => void) | null = null;
  view: ViewState;
  respond: Responder = () => ({ ok: true });

  readonly port = {
    start: (): void => undefined,
    close: (): void => undefined,
    addEventListener: (): void => undefined,
    postMessage: (message: RendererMsg): void => {
      this.sent.push(message);
      if (message.t !== 'cmd') return;
      this.commands.push(message.cmd);
      void Promise.resolve(this.respond(message.cmd)).then((result) => {
        act(() => this.deliverRaw({ v: 1, t: 'ack', id: message.id, result }));
      });
    },
  };

  constructor(readonly id: string, view: ViewState, private readonly meta: SessionMetaView) {
    this.view = view;
    // Accessors on an object literal bind `this` to the literal, not to this host: define them here.
    Object.defineProperty(this.port, 'onmessage', {
      configurable: true,
      set: (handler: ((event: MessageEvent) => void) | null) => { this.handler = handler; },
      get: () => this.handler,
    });
  }

  private deliverRaw(message: HostMsg): void {
    this.handler?.({ data: message } as MessageEvent);
  }

  /** Deliver a host message inside `act`, as a real port event would be. */
  deliver(message: HostMsg): void {
    act(() => this.deliverRaw(message));
  }

  snapshot(view: ViewState = this.view): void {
    this.view = view;
    this.seq += 1;
    this.deliver({ v: 1, t: 'snap', epoch: 1, seq: this.seq, state: view, meta: this.meta });
  }

  /** Apply host actions to the authoritative view and send them as one `acts` message. */
  dispatch(...actions: ViewAction[]): void {
    for (const action of actions) this.view = viewReducer(this.view, action);
    this.seq += 1;
    this.deliver({ v: 1, t: 'acts', seq: this.seq, actions });
  }

  request(id: string, req: HostRequest): void {
    this.deliver({ v: 1, t: 'req', id, req });
  }

  /** Every `res` the renderer answered with. */
  get answers(): Array<{ id: string; res: unknown }> {
    return this.sent.flatMap((message) => (message.t === 'res' ? [{ id: message.id, res: message.res }] : []));
  }

  commandsOf(name: HostCommand['c']): HostCommand[] {
    return this.commands.filter((command) => command.c === name);
  }
}

export function reduce(actions: ViewAction[], from: ViewState = initialViewState()): ViewState {
  return actions.reduce(viewReducer, from);
}

/** Open a hydrated session in the real store, backed by a fake host. */
export function mountSession(options: { id?: string; view?: ViewState; meta?: Partial<SessionMetaView> } = {}): FakeHost {
  const id = options.id ?? 's1';
  sessionStore.end(id);
  const host = new FakeHost(id, options.view ?? initialViewState(), { ...DEFAULT_META, sessionId: id, ...options.meta });
  sessionStore.begin(id);
  sessionStore.attach(id, host.port as unknown as MessagePort);
  host.snapshot();
  return host;
}

export function unmountSession(id = 's1'): void {
  sessionStore.end(id);
}
