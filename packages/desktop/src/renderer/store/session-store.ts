/**
 * The renderer's mirror of every open session.
 *
 * The HOST holds the authoritative `ViewState`; this store holds a copy built from `snap`
 * (the whole state) and `act`/`acts` (host actions, applied with the very reducer the terminal
 * uses). Renderer-only actions (toasts, overlays, expanded cards, the thinking toggle) are
 * dispatched here and are never sent to the host; a `snap` replaces everything EXCEPT those
 * fields (`mergeSnapshot`), so a resync or a window reload cannot collapse a card the user
 * just opened.
 *
 * It is a plain subscribe/get store consumed through `useSyncExternalStore`, with per-session
 * selectors: a streaming token re-renders the components that read the transcript, not the
 * whole shell. `ViewState` is immutable, so an unchanged entry keeps its reference and a
 * memoised row skips its render.
 */

import { useSyncExternalStore } from 'react';
import { viewReducer, type ViewAction, type ViewState } from '@aragon-agent/tui/model/agent/reducer';
import { applyLocalAction, isLocalAction, mergeSnapshot } from '../../shared/action-classes.js';
import type {
  CommandResult,
  HostCommand,
  HostEvent,
  HostMsg,
  HostRequest,
  HostResponse,
  SessionMetaView,
  SessionRunStatus,
} from '../../shared/port-protocol.js';
import { SessionPort } from './port-client.js';
import {
  COMMAND_TIMEOUT_MS_WITH_ATTACHMENTS,
  type ImageMode,
  type SubmitResultValue,
} from '../../shared/attachments.js';
import { translate } from '../i18n/index.js';
import {
  restoreAttachmentDrafts,
  toSubmitAttachment,
  type AttachmentDraft,
} from '../composer/attachments/attachment-draft-store.js';
import { isWithdrawnValue, restoreWithdrawnAttachments } from '../composer/attachments/restore-withdrawn.js';

export type ConnectionPhase = 'connecting' | 'ready' | 'closed' | 'error';

export interface PendingRequest {
  id: string;
  req: HostRequest;
  /** When the card first appeared; the 400 ms accidental-press guard counts from here. */
  shownAt: number;
}

/**
 * A message the user has sent that the transcript does not show yet. Lives beside the mirror,
 * NOT in `ViewState`: it is renderer-only, never checkpointed, and must not touch the
 * `LOCAL_VIEW_KEYS` contract or advance `seq` (spec D-7).
 */
export interface PendingSend {
  localId: string;
  text: string;
  sentAt: number;
  state: 'sending' | 'failed';
  /**
   * The attachments that went with it (bytes included, in memory only). Kept so Retry resends
   * the same files and Edit can put them back in the composer.
   */
  attachments?: AttachmentDraft[];
  imageMode?: ImageMode;
  /** Why it failed (a ready-made sentence is built by the view from `code`). */
  error?: { code: string; message: string };
}

/** How long an accepted message may wait for its transcript entry before the bubble is dropped. */
export const PENDING_SEND_GRACE_MS = 3000;

export interface SessionMirror {
  id: string;
  phase: ConnectionPhase;
  error: string | null;
  view: ViewState | null;
  meta: SessionMetaView | null;
  epoch: number;
  lastSeq: number;
  requests: PendingRequest[];
  runStatus: SessionRunStatus;
  /** A config change is waiting for the current run to end (the model chip shows a dot). */
  configPending: boolean;
  /** Epoch ms of the last host checkpoint. */
  checkpointAt: number | null;
  /** True once the host has sent its first snapshot. */
  hydrated: boolean;
  pendingSends: PendingSend[];
}

const EMPTY_REQUESTS: PendingRequest[] = [];
const NO_PENDING: PendingSend[] = [];

/** `user` and `queued` entries are what a sent message turns into. */
function sentCount(view: ViewState | null): number {
  return view ? view.entries.filter((entry) => entry.kind === 'user' || entry.kind === 'queued').length : 0;
}

function blank(id: string): SessionMirror {
  return {
    id, phase: 'connecting', error: null, view: null, meta: null, epoch: 0, lastSeq: 0,
    requests: EMPTY_REQUESTS, runStatus: 'starting', configPending: false, checkpointAt: null, hydrated: false,
    pendingSends: NO_PENDING,
  };
}

type Listener = () => void;

export class SessionStore {
  private readonly mirrors = new Map<string, SessionMirror>();
  private readonly ports = new Map<string, SessionPort>();
  private readonly listeners = new Set<Listener>();
  private order: string[] = [];
  private snapshotCache: readonly SessionMirror[] = [];
  /** Per pending send: the transcript's sent-entry count it is waiting to exceed, and whether the host accepted it. */
  private readonly sendTracking = new Map<string, { baseline: number; accepted: boolean }>();
  private sendCounter = 0;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private emit(): void {
    this.snapshotCache = this.order.map((id) => this.mirrors.get(id)!).filter(Boolean);
    for (const listener of [...this.listeners]) listener();
  }

  get(id: string): SessionMirror | undefined {
    return this.mirrors.get(id);
  }

  all = (): readonly SessionMirror[] => this.snapshotCache;

  private update(id: string, patch: Partial<SessionMirror>): void {
    const current = this.mirrors.get(id);
    if (!current) return;
    this.mirrors.set(id, { ...current, ...patch });
    this.emit();
  }

  /** Begin tracking a session; returns the mirror (connecting) immediately. */
  begin(id: string): void {
    if (!this.mirrors.has(id)) {
      this.mirrors.set(id, blank(id));
      this.order.push(id);
    } else {
      this.update(id, { phase: 'connecting', error: null });
    }
    this.emit();
  }

  /** Attach the port the main process delivered for this session. */
  attach(id: string, port: MessagePort): void {
    this.ports.get(id)?.close();
    const sessionPort = new SessionPort(port, {
      onMessage: (message) => this.receive(id, message),
      onClose: () => {
        if (this.ports.get(id) === sessionPort) {
          this.ports.delete(id);
          this.update(id, { phase: 'closed', requests: EMPTY_REQUESTS });
        }
      },
    });
    this.ports.set(id, sessionPort);
  }

  fail(id: string, message: string): void {
    this.update(id, { phase: 'error', error: message });
  }

  /** Forget a session entirely (closed by the user). */
  end(id: string): void {
    this.ports.get(id)?.close();
    this.ports.delete(id);
    for (const send of this.mirrors.get(id)?.pendingSends ?? []) this.sendTracking.delete(send.localId);
    this.mirrors.delete(id);
    this.order = this.order.filter((candidate) => candidate !== id);
    this.emit();
  }

  // ---- optimistic sends ----------------------------------------------------------------------

  /**
   * Send a message and show it at once as a grey "sending" bubble. The bubble is removed when the
   * host has accepted it AND its transcript entry has arrived (the ack can beat the entry: actions
   * are batched per frame), and turns into a retryable error when the host refuses or never
   * answers. Returns the host's answer for callers that want it; the bubble is the user-visible
   * outcome either way.
   */
  async sendMessage(
    id: string, text: string, attachments?: readonly AttachmentDraft[], imageMode?: ImageMode,
  ): Promise<CommandResult> {
    const mirror = this.mirrors.get(id);
    if (!mirror) return { ok: false, code: 'port_closed', message: 'The session is not connected.' };
    const localId = `ps${++this.sendCounter}`;
    const outstanding = mirror.pendingSends.filter((send) => send.state === 'sending').length;
    this.sendTracking.set(localId, { baseline: sentCount(mirror.view) + outstanding, accepted: false });
    const carried = attachments?.length ? { attachments: [...attachments], imageMode: imageMode ?? 'inline' } : {};
    this.update(id, {
      pendingSends: [...mirror.pendingSends, { localId, text, sentAt: Date.now(), state: 'sending', ...carried }],
    });
    return this.dispatchSend(id, localId, text);
  }

  /** Try a failed bubble again (same text, same bubble). */
  retrySend(id: string, localId: string): Promise<CommandResult> {
    const send = this.mirrors.get(id)?.pendingSends.find((candidate) => candidate.localId === localId);
    if (!send || send.state !== 'failed') return Promise.resolve({ ok: false, code: 'not_found', message: 'Nothing to retry.' });
    const mirror = this.mirrors.get(id)!;
    this.sendTracking.set(localId, { baseline: sentCount(mirror.view), accepted: false });
    this.patchSend(id, localId, { state: 'sending' });
    return this.dispatchSend(id, localId, send.text);
  }

  /**
   * Remove a bubble and hand back its text (the "Edit" action puts it in the composer). Its
   * attachments go straight back into the session's tray, so text and files return together.
   */
  takePendingSend(id: string, localId: string): string | null {
    const send = this.mirrors.get(id)?.pendingSends.find((candidate) => candidate.localId === localId);
    if (!send) return null;
    this.dropSend(id, localId);
    if (send.attachments?.length) restoreAttachmentDrafts(id, send.attachments);
    return send.text;
  }

  private async dispatchSend(id: string, localId: string, text: string): Promise<CommandResult> {
    const send = this.mirrors.get(id)?.pendingSends.find((candidate) => candidate.localId === localId);
    const files = send?.attachments;
    // No attachments: the command is byte-identical to what it was before attachments existed.
    const result = files?.length
      ? await this.command(id, {
        c: 'submit', text, attachments: files.map(toSubmitAttachment), imageMode: send?.imageMode ?? 'inline',
      }, { timeoutMs: COMMAND_TIMEOUT_MS_WITH_ATTACHMENTS })
      : await this.command(id, { c: 'submit', text });
    if (!this.mirrors.get(id)?.pendingSends.some((send) => send.localId === localId)) return result;
    if (!result.ok) {
      this.patchSend(id, localId, { state: 'failed', error: { code: result.code, message: result.message } });
      return result;
    }
    this.reportSubmitOutcome(id, result.value);
    const tracking = this.sendTracking.get(localId);
    if (tracking) tracking.accepted = true;
    if (!this.settleSends(id)) {
      // Accepted but no entry yet: wait for the next host action, and never leave a grey bubble behind.
      setTimeout(() => this.dropSend(id, localId), PENDING_SEND_GRACE_MS);
    }
    return result;
  }

  /** What the host did with the attachments: say so for every one that did not go as the user expects. */
  private reportSubmitOutcome(id: string, value: unknown): void {
    const outcome = value as Partial<SubmitResultValue> | undefined;
    for (const item of outcome?.dropped ?? []) {
      const name = outcome?.attachments?.find((meta) => meta.ref === item.ref)?.name ?? item.ref;
      this.dispatchLocal(id, {
        type: 'pushToast', level: 'warn',
        text: translate('chat.attach.droppedToast', { name, reason: translate(`chat.attach.reason.${item.reason}` as const) }),
      });
    }
    if (outcome?.downgraded?.length) {
      const names = outcome.downgraded.map((item) => outcome.attachments?.find((meta) => meta.ref === item.ref)?.name ?? item.ref);
      this.dispatchLocal(id, {
        type: 'pushToast', level: 'info', text: translate('chat.attach.downgradedToast', { name: names.join(', ') }),
      });
    }
  }

  private patchSend(id: string, localId: string, patch: Partial<PendingSend>): void {
    const mirror = this.mirrors.get(id);
    if (!mirror) return;
    const next = mirror.pendingSends.map((send) => {
      if (send.localId !== localId) return send;
      const { error: _discarded, ...rest } = send;
      return { ...rest, ...patch };
    });
    this.update(id, { pendingSends: next });
  }

  private dropSend(id: string, localId: string): void {
    this.sendTracking.delete(localId);
    const mirror = this.mirrors.get(id);
    if (!mirror || !mirror.pendingSends.some((send) => send.localId === localId)) return;
    const next = mirror.pendingSends.filter((send) => send.localId !== localId);
    this.update(id, { pendingSends: next.length === 0 ? NO_PENDING : next });
  }

  /** Remove every accepted bubble whose entry has arrived. Returns whether the session has none left waiting. */
  private settleSends(id: string): boolean {
    const mirror = this.mirrors.get(id);
    if (!mirror || mirror.pendingSends.length === 0) return true;
    const arrived = sentCount(mirror.view);
    const done = mirror.pendingSends.filter((send) => {
      const tracking = this.sendTracking.get(send.localId);
      return send.state === 'sending' && tracking?.accepted === true && arrived > tracking.baseline;
    });
    for (const send of done) this.dropSend(id, send.localId);
    return !mirror.pendingSends.some((send) =>
      send.state === 'sending' && this.sendTracking.get(send.localId)?.accepted === true
      && !done.includes(send));
  }

  private receive(id: string, message: HostMsg): void {
    const mirror = this.mirrors.get(id);
    if (!mirror) return;
    switch (message.t) {
      case 'snap': {
        // A larger epoch means the host restarted (seq starts again); never read that as a gap.
        const view = mergeSnapshot(mirror.view, message.state);
        this.update(id, {
          view, meta: message.meta, epoch: message.epoch, lastSeq: message.seq,
          phase: 'ready', hydrated: true, error: null,
        });
        return;
      }
      case 'act':
      case 'acts': {
        if (!mirror.view) return;
        if (message.seq !== mirror.lastSeq + 1) {
          this.ports.get(id)?.resync();
          return;
        }
        const actions = message.t === 'act' ? [message.action] : message.actions;
        let view = mirror.view;
        for (const action of actions) if (!isLocalAction(action)) view = viewReducer(view, action);
        this.update(id, { view, lastSeq: message.seq });
        this.settleSends(id);
        return;
      }
      case 'req':
        if (mirror.requests.some((entry) => entry.id === message.id)) return;
        this.update(id, { requests: [...mirror.requests, { id: message.id, req: message.req, shownAt: Date.now() }] });
        return;
      case 'evt':
        this.onEvent(id, mirror, message.evt);
        return;
      case 'ack':
        return; // consumed by the port itself
    }
  }

  private onEvent(id: string, _mirror: SessionMirror, evt: HostEvent): void {
    switch (evt.e) {
      case 'toast':
        this.dispatchLocal(id, { type: 'pushToast', level: evt.level, text: evt.text });
        return;
      case 'status':
        this.update(id, { runStatus: evt.status });
        return;
      case 'config.stale':
        this.update(id, { configPending: evt.pendingReload });
        return;
      case 'config.applied':
        this.update(id, { configPending: false });
        return;
      case 'checkpoint.saved':
        this.update(id, { checkpointAt: evt.at });
        return;
      case 'pong':
        return;
    }
  }

  private toastCounter = 0;

  /** Apply a renderer-only action to this session's mirror. Host actions are refused. */
  dispatchLocal(id: string, action: ViewAction): void {
    const mirror = this.mirrors.get(id);
    if (!mirror?.view || !isLocalAction(action)) return;
    const view = applyLocalAction(mirror.view, action, viewReducer, () => `lt${++this.toastCounter}`);
    this.update(id, { view });
  }

  command(id: string, cmd: HostCommand, options?: { timeoutMs?: number }): Promise<CommandResult> {
    const port = this.ports.get(id);
    if (!port) return Promise.resolve({ ok: false, code: 'port_closed', message: 'The session is not connected.' });
    const answer = port.command(cmd, options?.timeoutMs);
    // A withdrawn queued message returns with its files: rebuild the chips as a side effect, so
    // every caller of `queue.cancel` gets the attachments back without knowing about them.
    if (cmd.c === 'queue.cancel') void answer.then((result) => this.restoreWithdrawn(id, result));
    return answer;
  }

  private async restoreWithdrawn(id: string, result: CommandResult): Promise<void> {
    if (!result.ok || !isWithdrawnValue(result.value)) return;
    const failed = await restoreWithdrawnAttachments(id, result.value, (attachmentId) =>
      this.command(id, { c: 'attachment.read', id: attachmentId }));
    if (failed > 0) {
      this.dispatchLocal(id, { type: 'pushToast', level: 'warn', text: translate('chat.attach.restoreFailed', { n: failed }) });
    }
  }

  /** Answer a pending approval/question and remove its card. */
  answer(id: string, requestId: string, response: HostResponse): void {
    const mirror = this.mirrors.get(id);
    if (!mirror) return;
    this.ports.get(id)?.respond(requestId, response);
    this.update(id, { requests: mirror.requests.filter((entry) => entry.id !== requestId) });
  }
}

export const sessionStore = new SessionStore();

/** Subscribe a component to one slice of one session. `select` must return a stable value. */
export function useSession<T>(id: string | null, select: (mirror: SessionMirror | undefined) => T): T {
  return useSyncExternalStore(
    sessionStore.subscribe,
    () => select(id ? sessionStore.get(id) : undefined),
    () => select(undefined),
  );
}

export function useSessionList(): readonly SessionMirror[] {
  return useSyncExternalStore(sessionStore.subscribe, sessionStore.all, sessionStore.all);
}
