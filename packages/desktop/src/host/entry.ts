/**
 * Entry point of a session host (`utilityProcess`). Runs with NO TTY and NO Electron API.
 *
 * Boot order is the contract with the main process:
 *   1. wait for `init` on `parentPort` (nothing is loaded or started before it);
 *   2. verify the home root the engine resolved equals the one the parent passed - the engine
 *      reads `ARAGON_HOME` once, when it is first imported, so a mismatch means this host
 *      would read and WRITE a different user's (or the real) data; it refuses to start;
 *   3. build the controller exactly as the terminal does (`makeController`) with the
 *      interactive gates, resolve or restore the session, and construct `SessionHost`;
 *   4. answer `ready`, then accept ports and control messages.
 * Any failure before `ready` is reported as `fatal` (with a stable code) so the supervisor can
 * show it instead of restarting into the same crash.
 */

import process from 'node:process';
import {
  applyRestoredSession,
  attachAgentEvents,
  attachTeamEvents,
  createSessionWriter,
  getHomeRoot,
  getLogger,
  installLogging,
  listInstalledSkills,
  listSlashCommands,
  makeController,
  openSession,
  readCliVersion,
  registerConfigSecrets,
  resolveStartupSession,
  type SessionIdentity,
} from '@aragon-agent/cli/dist/host/index.js';
import type { Entry } from '@aragon-agent/tui/model/agent/reducer';
import type {
  HostControlMsg,
  HostInit,
  MainControlMsg,
} from '../shared/port-protocol.js';
import { Heartbeat } from './heartbeat.js';
import { SessionHost, type PortLike } from './session-host.js';

interface ParentPort {
  on(event: 'message', listener: (event: { data: unknown; ports: unknown[] }) => void): void;
  postMessage(message: HostControlMsg): void;
}

interface ElectronPort {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
  on(event: 'close', listener: () => void): void;
  start(): void;
  close(): void;
}

const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;

function send(message: HostControlMsg): void {
  parentPort?.postMessage(message);
}

function fatal(code: string, message: string): never {
  send({ v: 1, kind: 'fatal', code, message });
  // Give the message a moment to leave the process before it exits.
  setTimeout(() => process.exit(1), 50);
  throw new Error(`${code}: ${message}`);
}

function wrapPort(port: ElectronPort): PortLike {
  return {
    postMessage: (message) => port.postMessage(message),
    onMessage: (listener) => port.on('message', (event) => listener(event.data)),
    onClose: (listener) => port.on('close', listener),
    start: () => port.start(),
    close: () => port.close(),
  };
}

interface Boot {
  host: SessionHost;
  heartbeat: Heartbeat;
}

function resolveSession(init: HostInit): {
  identity: SessionIdentity;
  entries: Entry[];
  saved: ReturnType<typeof openSession>;
  notice?: string;
} {
  if (init.resume && init.sessionId) {
    const saved = openSession(init.sessionId);
    if (!saved) fatal('session_not_found', `Session "${init.sessionId}" could not be read.`);
    const parentId = saved.meta?.branchOf;
    return {
      identity: { id: init.sessionId, kind: parentId ? 'branch' : 'named', ...(parentId ? { parentId } : {}), ...(saved.meta?.pinned ? { pinned: true } : {}) },
      entries: saved.entries,
      saved,
    };
  }
  // A new session arrives with its id already reserved by the main process (it keys the host
  // pool and the window's port by it); only a host started without one mints its own.
  if (init.sessionId) {
    return { identity: { id: init.sessionId, kind: 'fresh' }, entries: [], saved: null };
  }
  const startup = resolveStartupSession({ cwd: init.cwd });
  if (!startup.ok) fatal('session_unavailable', startup.message);
  return {
    identity: startup.identity,
    entries: startup.initialEntries,
    saved: null,
    ...(startup.notice ? { notice: startup.notice } : {}),
  };
}

function boot(init: HostInit): Boot {
  const actualHome = getHomeRoot();
  if (actualHome !== init.homeRoot) {
    fatal('home_mismatch', `Host resolved home "${actualHome}" but was told "${init.homeRoot}".`);
  }
  installLogging();
  registerConfigSecrets();

  const { controller, confirmBridge, humanInputBridge } = makeController({ cwd: init.cwd }, { interactive: true });
  const logger = getLogger();
  attachAgentEvents(logger, controller);
  attachTeamEvents(logger, controller);

  const session = resolveSession(init);
  if (session.saved) applyRestoredSession(controller, session.saved);
  if (controller.getCwd() !== init.cwd) controller.setCwd(init.cwd);
  void controller.refreshModelMetadata();

  let hostRef: SessionHost | undefined;
  const writer = createSessionWriter({
    controller,
    readView: () => hostRef
      ? { id: session.identity.id, entries: hostRef.getState().entries, usageTotal: hostRef.getState().usageTotal }
      : undefined,
    readParentId: () => session.identity.parentId,
    startPinned: session.identity.pinned === true,
  });
  const host = new SessionHost({
    controller, confirmBridge, humanInputBridge,
    sessionId: session.identity.id,
    epoch: init.epoch,
    resumed: session.saved !== null,
    ...(session.saved?.meta?.updatedAt ? { restoredAt: session.saved.meta.updatedAt } : {}),
    initialEntries: session.entries,
    writer,
    control: send,
    slashCommands: listSlashCommands({ skills: controller.getSkillService() }),
    version: readCliVersion(),
  });
  hostRef = host;
  if (session.notice) host.dispatch({ type: 'notice', level: 'info', text: session.notice });
  const heartbeat = new Heartbeat({
    hasWork: () => controller.liveServiceCount() > 0 || controller.isRunning(),
    send,
  });
  send({ v: 1, kind: 'ready', sessionId: session.identity.id, pid: process.pid });
  return { host, heartbeat };
}

let booted: Boot | null = null;
let pendingPorts: ElectronPort[] = [];

function onControl(message: MainControlMsg, ports: unknown[]): void {
  const raw = message as { kind?: string };
  if (raw.kind === 'port') {
    const port = ports[0] as ElectronPort | undefined;
    if (!port) return;
    if (booted) booted.host.attach(wrapPort(port));
    else pendingPorts.push(port); // a port can beat `init`'s boot to completion
    return;
  }
  if (!booted) return;
  switch (message.kind) {
    case 'ping': booted.heartbeat.pong(); break;
    case 'config-changed': booted.host.onConfigChanged(); break;
    case 'attached': booted.host.setAttached(message.attached); break;
    case 'quit':
      void booted.host.dispose(message.flush).finally(() => process.exit(0));
      break;
  }
}

/**
 * `--catalog`: a throwaway process that answers ONE question - which skills are installed for a
 * directory - and exits. Skills belong to the user and the project, not to a session, so the
 * Settings page must be able to ask with no session open; and the main process cannot answer
 * itself because the engine only exists here (it is not in the app bundle).
 */
const CATALOG_MODE = process.argv.includes('--catalog');

function answerCatalog(message: MainControlMsg): void {
  if (message.kind !== 'skills-query') return;
  try {
    send({ v: 1, kind: 'skills', skills: listInstalledSkills(message.cwd) });
  } catch (error) {
    send({ v: 1, kind: 'fatal', code: 'catalog_failed', message: error instanceof Error ? error.message : String(error) });
  }
  setTimeout(() => process.exit(0), 50);
}

parentPort?.on('message', (event) => {
  const data = event.data as HostInit | MainControlMsg;
  if (CATALOG_MODE) {
    answerCatalog(data as MainControlMsg);
    return;
  }
  if ((data as HostInit).kind === 'init') {
    try {
      booted = boot(data as HostInit);
      for (const port of pendingPorts.splice(0)) booted.host.attach(wrapPort(port));
    } catch (error) {
      send({ v: 1, kind: 'fatal', code: 'boot_failed', message: error instanceof Error ? error.message : String(error) });
      setTimeout(() => process.exit(1), 50);
    }
    return;
  }
  onControl(data as MainControlMsg, event.ports);
});

// A host with no parent has nobody to answer: exit rather than linger as an orphan.
if (!parentPort) {
  process.stderr.write('aragon session host must be started by the desktop app.\n');
  process.exit(2);
}
