/**
 * One session: the controller, its authoritative `ViewState`, and the port to the window.
 *
 * THE HOST OWNS THE TRUTH (spec D-3). Every domain action is reduced here first and only then
 * mirrored to the renderer, which is what lets a checkpoint be written when the window has
 * crashed, lets a reloaded window be given the whole conversation back in one `snap`, and
 * keeps the renderer's copy a copy. Renderer-only actions (`ACTION_CLASSES[...] === 'local'`)
 * never enter this reducer: a host that tries to dispatch one gets it converted to a toast
 * event or dropped, because letting it through would make the host's state diverge from the
 * UI fields the renderer rebuilds on every snapshot.
 *
 * Everything the engine owns is injected (`SessionHostDeps`), so the unit tests drive this
 * class with a fake controller and a real `MessageChannel`; `entry.ts` supplies the real ones.
 */

import {
  initialViewState,
  viewReducer,
  type Entry,
  type ViewAction,
  type ViewState,
} from '@aragon-agent/tui/model/agent/reducer';
import type { HumanInputBridge } from '@aragon-agent/tui/model/tools/human-input';
import type { AgentController, ConfirmBridge } from '@aragon-agent/cli/dist/host/controller-factory.js';
import {
  ActionCoalescer,
  attachAgentChannel,
  attachCompactionChannel,
  attachContextUsageChannel,
  attachFastChannel,
  attachGovernanceChannel,
  attachProcChannel,
  attachTeamChannel,
  attachTodosChannel,
  attachToolOutputChannel,
  attachWaitChannel,
  makePatchSource,
  InteractionCoordinator,
  type SessionCheckpointWriter,
} from '@aragon-agent/cli/dist/host/index.js';
import { isLocalAction } from '../shared/action-classes.js';
import type {
  CommandResult,
  HostControlMsg,
  HostEvent,
  HostMsg,
  HostRequest,
  RendererMsg,
  SessionMetaView,
  SessionRunStatus,
  ToastLevel,
} from '../shared/port-protocol.js';
import { Gates } from './gates.js';
import { CommandRouter } from './command-router.js';

/** The slice of a message port the host needs; adapters wrap Electron's and Node's. */
export interface PortLike {
  postMessage(message: HostMsg): void;
  onMessage(listener: (data: unknown) => void): void;
  onClose(listener: () => void): void;
  start(): void;
  close(): void;
}

export interface SessionHostDeps {
  controller: AgentController;
  confirmBridge: ConfirmBridge;
  humanInputBridge: HumanInputBridge;
  sessionId: string;
  epoch: number;
  resumed: boolean;
  restoredAt?: number;
  initialEntries: Entry[];
  writer: SessionCheckpointWriter;
  /** `<home>`: the attachment staging area lives under it. */
  homeRoot?: string;
  /** Send a control-plane message to the main process. */
  control(message: HostControlMsg): void;
  slashCommands: { name: string; description: string; aliases?: string[] }[];
  version: string;
  /** Frame batching interval for `acts`; ~one render frame. */
  frameMs?: number;
}

const FRAME_MS = 16;

export class SessionHost {
  private state: ViewState;
  private seq = 0;
  private port: PortLike | null = null;
  private outbox: ViewAction[] = [];
  private frameTimer: ReturnType<typeof setTimeout> | null = null;
  private status: SessionRunStatus = 'starting';
  private pendingReload = false;
  private disposers: (() => void)[] = [];
  private disposed = false;
  private readonly gates: Gates;
  private readonly interaction: InteractionCoordinator;
  private readonly coalescer: ActionCoalescer;
  private readonly router: CommandRouter;

  constructor(private readonly deps: SessionHostDeps) {
    const { controller } = deps;
    const seeded = initialViewState({ thinkingVisible: controller.getConfig().showThinking });
    this.state = deps.initialEntries.length > 0
      ? viewReducer(seeded, { type: 'restoreEntries', entries: deps.initialEntries })
      : seeded;

    this.gates = new Gates({
      send: (id, req) => this.sendRequest(id, req),
      onPendingChange: () => this.refreshStatus(),
      onDenied: (reason) => this.dispatch({ type: 'notice', level: 'warn', text: reason }),
    });
    this.interaction = new InteractionCoordinator({
      controller,
      dispatch: (action) => this.dispatch(action),
      notify: (level, text) => this.dispatch({ type: 'notice', level, text }),
    });
    this.coalescer = new ActionCoalescer((action) => this.dispatch(action), () => 33);
    this.router = new CommandRouter({
      controller,
      interaction: this.interaction,
      dispatch: (action) => this.dispatch(action),
      readState: () => this.state,
      cwd: () => controller.getCwd(),
      reloadConfig: () => this.applyConfigChange(true),
      writer: deps.writer,
      sessionId: deps.sessionId,
      ...(deps.homeRoot ? { homeRoot: deps.homeRoot } : {}),
    });
    this.wire();
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  private wire(): void {
    const { controller, confirmBridge, humanInputBridge } = this.deps;
    const dispatch = (action: ViewAction): void => this.dispatch(action);

    // Interactive gates: the controller reads these handlers live on every call.
    confirmBridge.handler = (request) => this.gates.confirmTool({
      tool: request.tool, summary: request.summary,
      ...(request.signal ? { signal: request.signal } : {}),
    });
    humanInputBridge.handler = (request, signal) => this.gates.humanInput(request, signal);
    humanInputBridge.cancelPending = () => this.gates.cancelAll('The request was withdrawn.');

    this.disposers.push(
      attachAgentChannel(controller, {
        dispatch, coalescer: this.coalescer, patchSource: makePatchSource(controller),
        hooks: {
          beforeEvent: (event) => {
            if (event.type === 'agent_start') {
              this.interaction.onAgentStart();
              this.setStatus('running');
            }
          },
          afterAgentEnd: () => {
            // No approval outlives the run that asked for it.
            this.gates.cancelAll('The run ended before the request was answered.');
            this.interaction.onAgentEnd();
            this.setStatus('idle');
            if (this.pendingReload) this.applyConfigChange(false);
          },
        },
      }),
      attachProcChannel(controller, dispatch, () => this.refreshStatus()),
      attachTeamChannel(controller, dispatch),
      attachGovernanceChannel(controller, dispatch),
      attachTodosChannel(controller, dispatch),
      attachFastChannel(controller, dispatch),
      attachContextUsageChannel(controller, dispatch),
      attachCompactionChannel(controller, dispatch),
      attachToolOutputChannel(controller, this.coalescer),
    );
    const waitDisposer = attachWaitChannel(controller, this.coalescer);
    if (waitDisposer) this.disposers.push(waitDisposer);

    // The posture the session started in, so `--plan`-style defaults show on the first frame.
    const posture = controller.getPostureState();
    this.dispatch({
      type: 'setAgentMode', mode: controller.getAgentMode(), pending: null,
      posture: posture.effective, pendingPosture: posture.pending,
    });

    this.deps.writer.start();
    this.deps.writer.attach((onAgentEnd) =>
      controller.subscribe((event) => {
        if (event.type === 'agent_end') {
          onAgentEnd();
          this.emit({ e: 'checkpoint.saved', at: Date.now() });
        }
      }),
    );
  }

  // -------------------------------------------------------------------------
  // State and mirroring
  // -------------------------------------------------------------------------

  getState(): ViewState {
    return this.state;
  }

  /** The single entry for every domain action: reduce, then mirror. */
  dispatch(action: ViewAction): void {
    if (this.disposed) return;
    if (isLocalAction(action)) {
      // A UI-only action from the host side: a toast becomes an event, anything else is dropped.
      if (action.type === 'pushToast') this.emit({ e: 'toast', level: action.level as ToastLevel, text: action.text });
      return;
    }
    this.state = viewReducer(this.state, action);
    if (!this.port) return;
    this.outbox.push(action);
    if (!this.frameTimer) {
      this.frameTimer = setTimeout(() => this.flushOutbox(), this.deps.frameMs ?? FRAME_MS);
    }
  }

  private flushOutbox(): void {
    this.frameTimer = null;
    if (!this.port || this.outbox.length === 0) { this.outbox = []; return; }
    const actions = this.outbox;
    this.outbox = [];
    this.seq += 1;
    this.send(actions.length === 1
      ? { v: 1, t: 'act', seq: this.seq, action: actions[0]! }
      : { v: 1, t: 'acts', seq: this.seq, actions });
  }

  private meta(): SessionMetaView {
    const { controller } = this.deps;
    const config = controller.getConfig();
    return {
      sessionId: this.deps.sessionId,
      cwd: controller.getCwd(),
      provider: config.provider,
      model: config.model,
      resumed: this.deps.resumed,
      ...(this.deps.restoredAt === undefined ? {} : { restoredAt: this.deps.restoredAt }),
      postureCycle: [...controller.getPostureCycle()],
      governanceUnavailable: controller.getGovernanceUnavailableText(),
      slashCommands: this.deps.slashCommands,
      imageInput: this.imageInput(),
    };
  }

  private imageInput(): SessionMetaView['imageInput'] {
    const { controller } = this.deps;
    // A controller without the capability (older host or a test double) reads as "cannot tell".
    const found = controller.getImageSupport?.();
    return found
      ? { support: found.support, source: found.source, tokenEstimate: found.tokenEstimate }
      : { support: 'unknown', source: 'heuristic', tokenEstimate: 1600 };
  }

  private sendSnapshot(): void {
    this.coalescer.flush();
    if (this.frameTimer) clearTimeout(this.frameTimer);
    this.frameTimer = null;
    this.outbox = []; // the snapshot already contains them
    this.seq += 1;
    this.send({ v: 1, t: 'snap', epoch: this.deps.epoch, seq: this.seq, state: this.state, meta: this.meta() });
  }

  private send(message: HostMsg): void {
    try { this.port?.postMessage(message); } catch { /* a closing port; onClose handles it */ }
  }

  private emit(evt: HostEvent): void {
    this.send({ v: 1, t: 'evt', evt });
  }

  private sendRequest(id: string, req: HostRequest): boolean {
    if (!this.port) return false;
    this.send({ v: 1, t: 'req', id, req });
    return true;
  }

  // -------------------------------------------------------------------------
  // Port lifecycle
  // -------------------------------------------------------------------------

  /** Adopt a (new) window port: replace the old one, send the whole state, replay requests. */
  attach(port: PortLike): void {
    const previous = this.port;
    this.port = port;
    port.onMessage((data) => this.onRendererMessage(data));
    port.onClose(() => {
      if (this.port === port) {
        this.port = null;
        this.gates.setAttached(false);
      }
    });
    port.start();
    try { previous?.close(); } catch { /* already closed */ }
    this.gates.setAttached(true);
    this.sendSnapshot();
    this.gates.replayPending();
  }

  /** The main process says whether any window can currently answer (window hidden, etc.). */
  setAttached(attached: boolean): void {
    this.gates.setAttached(attached && this.port !== null);
  }

  private onRendererMessage(data: unknown): void {
    const message = data as RendererMsg;
    if (!message || typeof message !== 'object' || (message as { v?: unknown }).v !== 1) return;
    switch (message.t) {
      case 'resync':
        this.sendSnapshot();
        break;
      case 'res':
        this.gates.answer(message.id, message.res);
        break;
      case 'cmd':
        void this.runCommand(message.id, message.cmd);
        break;
    }
  }

  private async runCommand(id: string, cmd: Extract<RendererMsg, { t: 'cmd' }>['cmd']): Promise<void> {
    let result: CommandResult;
    try {
      result = await this.router.run(cmd);
    } catch (error) {
      result = { ok: false, code: 'internal', message: error instanceof Error ? error.message : String(error) };
    }
    this.send({ v: 1, t: 'ack', id, result });
  }

  // -------------------------------------------------------------------------
  // Status and configuration
  // -------------------------------------------------------------------------

  private setStatus(status: SessionRunStatus): void {
    this.status = status;
    this.refreshStatus();
  }

  private refreshStatus(): void {
    const effective: SessionRunStatus = this.gates.pendingCount > 0 ? 'waiting-approval' : this.status;
    this.deps.control({ v: 1, kind: 'status', status: effective, services: this.deps.controller.liveServiceCount() });
    this.emit({ e: 'status', status: effective });
  }

  /**
   * The main process saw `config.json` change. NEVER swap the model mid-answer: while a run,
   * a compaction or a queued message is live the reload is only marked pending and the window
   * is told (a dot on the model chip); `agent_end` applies it.
   */
  onConfigChanged(): void {
    this.applyConfigChange(false);
  }

  private applyConfigChange(force: boolean): CommandResult {
    const { controller } = this.deps;
    const busy = controller.isRunning() || controller.isCompactionBusy?.() === true
      || controller.hasPendingUserMessages() || this.interaction.phase !== 'idle';
    if (busy && !force) {
      this.pendingReload = true;
      this.emit({ e: 'config.stale', pendingReload: true });
      return { ok: true, value: { applied: false } };
    }
    if (busy) {
      return { ok: false, code: 'busy', message: 'Wait for the current run to finish before reloading settings.' };
    }
    this.pendingReload = false;
    const result = controller.reloadModelSettings();
    if (!result.ok) {
      return { ok: false, code: 'rejected', message: `Settings could not be applied (${result.code ?? result.status}).` };
    }
    this.emit({ e: 'config.applied', revision: '' });
    this.dispatchModelChange();
    return { ok: true, value: { applied: true } };
  }

  private dispatchModelChange(): void {
    this.coalescer.flush();
    this.sendSnapshot(); // model, thinking and window changed: one snapshot refreshes every chip
  }

  // -------------------------------------------------------------------------
  // Shutdown
  // -------------------------------------------------------------------------

  /** Flush the checkpoint, stop everything, release the session lock. Idempotent. */
  async dispose(flush: boolean): Promise<void> {
    if (this.disposed) return;
    this.gates.cancelAll('The session is closing.');
    const { controller, writer } = this.deps;
    try {
      if (controller.isRunning()) controller.abort();
    } catch { /* closing anyway */ }
    this.coalescer.flush();
    if (flush) {
      try { writer.flushSync('exit'); } catch { /* a failed flush must not block quitting */ }
    }
    this.disposed = true;
    if (this.frameTimer) clearTimeout(this.frameTimer);
    this.interaction.dispose();
    for (const dispose of this.disposers.splice(0)) {
      try { dispose(); } catch { /* ignore */ }
    }
    try { controller.dispose(); } catch { /* ignore */ }
    try { this.port?.close(); } catch { /* ignore */ }
    this.port = null;
  }

  /** Test seam: the gate set, to answer a request without a renderer. */
  get gateSet(): Gates {
    return this.gates;
  }
}
