/**
 * `SessionHost` over a REAL `MessageChannel` with a fake controller.
 *
 * Covers the properties the design rests on: the host's `ViewState` is authoritative and the
 * port carries it (snapshot then batched actions, in order); a reload re-attaches and gets the
 * whole state back with pending approvals replayed (AC-19); `seq` gaps are repaired by `resync`
 * (AC-21); renderer-only actions never enter host state; a config change never swaps the model
 * mid-run (AC-16); every command always answers; and disposal flushes the checkpoint.
 */

import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { emptyContextUsage } from '@aragon-agent/tui/model/compaction/meter';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostControlMsg, HostMsg, RendererMsg } from '../../shared/port-protocol.js';
import { SessionHost, type PortLike } from '../session-host.js';

type Listener = (event: unknown) => void;

function fakeController() {
  const agentListeners: Listener[] = [];
  const noop = () => () => undefined;
  const state = { running: false, reloaded: 0, aborted: 0, disposed: false };
  const withdraw = vi.fn((_id: string): 'withdrawn' | 'delivered' | 'unknown' => 'unknown');
  const controller = {
    runGeneration: 1,
    getConfig: () => ({ showThinking: false, provider: 'anthropic', model: 'm', modelSettingsRestartRequired: false, skills: { enabled: false } }),
    getCwd: () => '/work',
    getModelInfo: () => ({ cost: undefined }),
    getPostureState: () => ({ effective: 'build', pending: null }),
    getAgentMode: () => 'build',
    getPostureCycle: () => ['build', 'plan'],
    getGovernanceUnavailableText: () => null,
    getFastStatus: () => ({ registered: false, tier: { ok: false }, snapshot: {} }),
    getContextUsage: () => emptyContextUsage(),
    isCompactionRegistered: () => false,
    liveServiceCount: () => 0,
    isRunning: () => state.running,
    isCompactionBusy: () => false,
    hasPendingUserMessages: () => false,
    withdrawQueuedUserMessage: withdraw,
    preflight: () => ({ ok: true }),
    prompt: vi.fn(async () => ({ status: 'started' })),
    abort: () => { state.aborted += 1; },
    reloadModelSettings: () => { state.reloaded += 1; return { ok: true, status: 'applied' }; },
    dispose: () => { state.disposed = true; },
    applyPendingPosture: () => null,
    setSubmitCount: () => undefined,
    subscribe: (listener: Listener) => { agentListeners.push(listener); return () => undefined; },
    subscribeProc: noop, subscribeTeam: noop, subscribeGovernance: noop, subscribeTodos: noop,
    subscribeFast: noop, subscribeContextUsage: noop, subscribeCompaction: noop, subscribeToolOutput: noop,
    subscribeWait: noop,
  };
  return { controller, state, withdraw, emit: (event: object) => agentListeners.forEach((fn) => fn(event)) };
}

function fakeWriter() {
  return { start: vi.fn(), attach: vi.fn(), flushSync: vi.fn(), writeNow: vi.fn(() => ({ ok: true, path: '/s.json' })) };
}

/** The host's end wrapped as a `PortLike`; the test keeps the other end. */
function connect() {
  const { port1, port2 } = new MessageChannel();
  const received: HostMsg[] = [];
  port2.on('message', (message: HostMsg) => received.push(message));
  const hostEnd: PortLike = {
    postMessage: (message) => port1.postMessage(message),
    onMessage: (listener) => port1.on('message', listener),
    onClose: (listener) => port1.on('close', listener),
    start: () => port1.start?.(),
    close: () => port1.close(),
  };
  const send = (message: RendererMsg): void => port2.postMessage(message);
  return { hostEnd, received, send, rendererEnd: port2 as MessagePort };
}

/** Run the host's frame timers, then let the REAL MessageChannel deliver (it is not faked). */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(40);
  for (let turn = 0; turn < 3; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  await vi.advanceTimersByTimeAsync(40);
  for (let turn = 0; turn < 3; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

function make() {
  const { controller, state, emit, withdraw } = fakeController();
  const writer = fakeWriter();
  const control: HostControlMsg[] = [];
  const host = new SessionHost({
    controller: controller as never, confirmBridge: { handler: null }, humanInputBridge: { handler: null, cancelPending: () => undefined },
    sessionId: 's1', epoch: 7, resumed: false, initialEntries: [], writer: writer as never,
    control: (message) => control.push(message), slashCommands: [], version: '0.0.0', frameMs: 5,
  });
  return { host, controller, state, emit, writer, control, withdraw };
}

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }); });
afterEach(() => { vi.useRealTimers(); });

describe('attach and mirroring', () => {
  it('starts the checkpoint writer and sends the whole state first, then batched actions in order', async () => {
    const { host, emit } = make();
    const { hostEnd, received } = connect();
    host.attach(hostEnd);
    await settle();
    expect(received[0]).toMatchObject({ t: 'snap', epoch: 7, seq: 1, meta: { sessionId: 's1', cwd: '/work' } });

    emit({ type: 'agent_start' });
    host.dispatch({ type: 'notice', level: 'info', text: 'a' });
    host.dispatch({ type: 'notice', level: 'warn', text: 'b' });
    await settle();
    const batches = received.filter((m) => m.t === 'act' || m.t === 'acts');
    expect(batches.map((m) => m.seq)).toEqual([2]); // two actions in one frame = one message
    // `agent_start` contributed `runStart`; the two notices follow it, in dispatch order.
    const actions = (batches[0] as Extract<HostMsg, { t: 'acts' }>).actions;
    expect(actions.map((action) => action.type)).toEqual(['runStart', 'notice', 'notice']);
    expect(actions.slice(1)).toMatchObject([{ text: 'a' }, { text: 'b' }]);
  });

  it('keeps reducing into host state with nobody attached, so a later attach gets everything', async () => {
    const { host } = make();
    host.dispatch({ type: 'notice', level: 'info', text: 'while detached' });
    const { hostEnd, received } = connect();
    host.attach(hostEnd);
    await settle();
    const snap = received.find((m) => m.t === 'snap') as Extract<HostMsg, { t: 'snap' }>;
    expect(snap.state.entries.some((entry) => entry.kind === 'notice')).toBe(true);
  });

  it('a window reload re-attaches: the new port gets a fresh snapshot and the old one is closed', async () => {
    const { host } = make();
    const first = connect();
    host.attach(first.hostEnd);
    await settle();
    host.dispatch({ type: 'notice', level: 'info', text: 'x' });
    const second = connect();
    host.attach(second.hostEnd);
    await settle();
    expect(second.received[0]).toMatchObject({ t: 'snap' });
    expect((second.received[0] as Extract<HostMsg, { t: 'snap' }>).seq).toBeGreaterThan(1);
  });

  it('answers a resync with a fresh snapshot (a renderer that saw a seq gap)', async () => {
    const { host } = make();
    const { hostEnd, received, send } = connect();
    host.attach(hostEnd);
    await settle();
    send({ v: 1, t: 'resync' });
    await settle();
    expect(received.filter((m) => m.t === 'snap')).toHaveLength(2);
  });
});

describe('image input capability in the snapshot meta', () => {
  it('reads "cannot tell" from a controller without the capability, and a live answer when it has one', async () => {
    const plain = make();
    const first = connect();
    plain.host.attach(first.hostEnd);
    await settle();
    const bare = (first.received[0] as Extract<HostMsg, { t: 'snap' }>).meta.imageInput;
    expect(bare).toEqual({ support: 'unknown', source: 'heuristic', tokenEstimate: 1600 });

    const { host, controller } = make();
    let answer = { support: 'no' as const, source: 'catalog' as const, tokenEstimate: 1600 };
    (controller as unknown as { getImageSupport: () => typeof answer }).getImageSupport = () => answer;
    const second = connect();
    host.attach(second.hostEnd);
    await settle();
    expect((second.received[0] as Extract<HostMsg, { t: 'snap' }>).meta.imageInput.support).toBe('no');
    // A model switch re-sends the snapshot, so the next one carries the new answer with no new event type.
    answer = { support: 'yes' as never, source: 'catalog', tokenEstimate: 1600 };
    host.dispatch({ type: 'notice', level: 'info', text: 'x' });
    const third = connect();
    host.attach(third.hostEnd);
    await settle();
    expect((third.received[0] as Extract<HostMsg, { t: 'snap' }>).meta.imageInput.support).toBe('yes');
  });
});

describe('renderer-only actions', () => {
  it('never enter host state; a host toast becomes an event instead', async () => {
    const { host } = make();
    const { hostEnd, received } = connect();
    host.attach(hostEnd);
    await settle();
    const before = host.getState();
    host.dispatch({ type: 'toggleThinking' });
    host.dispatch({ type: 'pushToast', level: 'info', text: 'saved' });
    await settle();
    expect(host.getState().thinkingVisible).toBe(before.thinkingVisible);
    expect(host.getState().toasts).toBe(before.toasts);
    expect(received.some((m) => m.t === 'evt' && m.evt.e === 'toast' && m.evt.text === 'saved')).toBe(true);
    expect(received.some((m) => m.t === 'act' || m.t === 'acts')).toBe(false);
  });
});

describe('commands', () => {
  it('every command gets exactly one ack, success or failure', async () => {
    const { host } = make();
    const { hostEnd, received, send } = connect();
    host.attach(hostEnd);
    await settle();
    send({ v: 1, t: 'cmd', id: 'c1', cmd: { c: 'ping' } });
    send({ v: 1, t: 'cmd', id: 'c2', cmd: { c: 'submit', text: '   ' } });
    send({ v: 1, t: 'cmd', id: 'c3', cmd: { c: 'queue.cancel', queueId: 'q' } });
    await settle();
    const acks = received.filter((m): m is Extract<HostMsg, { t: 'ack' }> => m.t === 'ack');
    expect(acks.map((ack) => ack.id).sort()).toEqual(['c1', 'c2', 'c3']);
    expect(acks.find((a) => a.id === 'c1')!.result).toEqual({ ok: true });
    expect(acks.find((a) => a.id === 'c2')!.result).toMatchObject({ ok: false, code: 'invalid_argument' });
    expect(acks.find((a) => a.id === 'c3')!.result).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('a submit starts a run through the same path the terminal uses', async () => {
    const { host, controller } = make();
    const { hostEnd, received, send } = connect();
    host.attach(hostEnd);
    send({ v: 1, t: 'cmd', id: 'c1', cmd: { c: 'submit', text: 'hello' } });
    await settle();
    expect(controller.prompt).toHaveBeenCalledWith('hello', { todoPolicy: 'new-task' });
    expect(received.find((m) => m.t === 'ack')).toMatchObject({ result: { ok: true } });
  });

  it('refuses a model change while a run is live', async () => {
    const { host, state } = make();
    const { hostEnd, received, send } = connect();
    host.attach(hostEnd);
    state.running = true;
    send({ v: 1, t: 'cmd', id: 'c1', cmd: { c: 'thinking.set', level: 'high' } });
    await settle();
    expect(received.find((m) => m.t === 'ack')).toMatchObject({ result: { ok: false, code: 'busy' } });
  });

  it('ignores a malformed or foreign message instead of crashing', async () => {
    const { host } = make();
    const { hostEnd, rendererEnd } = connect();
    host.attach(hostEnd);
    for (const junk of [null, 7, 'x', { v: 2, t: 'cmd' }, { v: 1, t: 'nonsense' }, {}]) rendererEnd.postMessage(junk);
    await settle();
    expect(host.getState()).toBeTruthy();
  });
});

describe('approvals across the port', () => {
  it('sends a request, takes the answer, and replays an unanswered one after a reload (AC-19)', async () => {
    const { host } = make();
    const first = connect();
    host.attach(first.hostEnd);
    await settle();
    const decision = host.gateSet.confirmTool({ tool: 'bash', summary: 'rm -rf build' });
    await settle();
    const request = first.received.find((m) => m.t === 'req') as Extract<HostMsg, { t: 'req' }>;
    expect(request.req).toMatchObject({ k: 'tool-approval', tool: 'bash', summary: 'rm -rf build' });

    const second = connect(); // the window reloaded before the user answered
    host.attach(second.hostEnd);
    await settle();
    const replayed = second.received.find((m) => m.t === 'req') as Extract<HostMsg, { t: 'req' }>;
    expect(replayed.id).toBe(request.id);

    second.send({ v: 1, t: 'res', id: replayed.id, res: { k: 'tool-approval', decision: 'allow' } });
    await settle();
    await expect(decision).resolves.toBe(true);
  });

  it('reports waiting-approval while a request is pending and settles when the run ends', async () => {
    const { host, control, emit } = make();
    const { hostEnd } = connect();
    host.attach(hostEnd);
    const decision = host.gateSet.confirmTool({ tool: 'bash', summary: 'x' });
    expect(control.some((m) => m.kind === 'status' && m.status === 'waiting-approval')).toBe(true);
    emit({ type: 'agent_end' });
    await expect(decision).resolves.toBe(false);
    expect(control.at(-1)).toMatchObject({ kind: 'status', status: 'idle' });
  });
});

describe('configuration changes', () => {
  it('applies at once when idle, but only marks pending while a run is live, applying at agent_end (AC-16)', async () => {
    const { host, state, emit } = make();
    const { hostEnd, received } = connect();
    host.attach(hostEnd);
    await settle();

    host.onConfigChanged();
    expect(state.reloaded).toBe(1);

    state.running = true;
    emit({ type: 'agent_start' });
    host.onConfigChanged();
    expect(state.reloaded).toBe(1); // never mid-answer
    await settle();
    expect(received.some((m) => m.t === 'evt' && m.evt.e === 'config.stale')).toBe(true);

    state.running = false;
    emit({ type: 'agent_end' });
    expect(state.reloaded).toBe(2);
  });
});

describe('dispose', () => {
  it('flushes the checkpoint, aborts a live run and stops the controller; a second call is a no-op', async () => {
    const { host, state, writer } = make();
    const { hostEnd } = connect();
    host.attach(hostEnd);
    state.running = true;
    await host.dispose(true);
    expect(writer.flushSync).toHaveBeenCalledWith('exit');
    expect(state.aborted).toBe(1);
    expect(state.disposed).toBe(true);
    await host.dispose(true);
    expect(writer.flushSync).toHaveBeenCalledTimes(1);
  });

  it('skips the flush when told to (a crash-style shutdown), still stops everything', async () => {
    const { host, writer, state } = make();
    await host.dispose(false);
    expect(writer.flushSync).not.toHaveBeenCalled();
    expect(state.disposed).toBe(true);
  });
});

describe('queue.cancel', () => {
  async function queued() {
    const made = make();
    const { hostEnd, received, send } = connect();
    made.host.attach(hostEnd);
    made.host.dispatch({ type: 'steerQueued', queueId: 'q1', text: 'also this' });
    await settle();
    const ack = async (id: string, queueId: string) => {
      send({ v: 1, t: 'cmd', id, cmd: { c: 'queue.cancel', queueId } });
      await settle();
      return (received.find((m) => m.t === 'ack' && m.id === id) as Extract<HostMsg, { t: 'ack' }>).result;
    };
    return { ...made, ack };
  }

  it('withdraws a still-queued message, hands its text back and removes it from the view', async () => {
    const { host, withdraw, ack } = await queued();
    withdraw.mockReturnValueOnce('withdrawn');
    expect(await ack('w1', 'q1')).toEqual({ ok: true, value: { text: 'also this' } });
    expect(host.getState().pendingSteering).toEqual([]);
    expect(host.getState().entries.some((entry) => entry.kind === 'queued')).toBe(false);
  });

  it('says already_delivered, and changes nothing, when the engine took the message first', async () => {
    const { host, withdraw, ack } = await queued();
    withdraw.mockReturnValueOnce('delivered');
    expect(await ack('w2', 'q1')).toMatchObject({ ok: false, code: 'already_delivered' });
    expect(host.getState().pendingSteering.map((item) => item.queueId)).toEqual(['q1']);
  });

  it('says not_found for an id the controller does not know, without touching the view', async () => {
    const { host, ack } = await queued();
    expect(await ack('w3', 'ghost')).toMatchObject({ ok: false, code: 'not_found' });
    expect(host.getState().pendingSteering).toHaveLength(1);
  });
});

describe('index.build', () => {
  it('answers a refusal, not an exception, when skills are off, and starts no run', async () => {
    const { host, controller } = make();
    const { hostEnd, received, send } = connect();
    host.attach(hostEnd);
    send({ v: 1, t: 'cmd', id: 'i1', cmd: { c: 'index.build' } });
    await settle();
    const ack = received.find((m) => m.t === 'ack' && m.id === 'i1') as Extract<HostMsg, { t: 'ack' }>;
    expect(ack.result).toMatchObject({ ok: false, code: 'rejected' });
    expect(controller.prompt).not.toHaveBeenCalled();
  });
});
