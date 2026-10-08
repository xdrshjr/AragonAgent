/**
 * The session registry: every live desktop session, its child process, its
 * journal, and its index entry, in one place.
 *
 * One session = at most one `aragon exec` child, kept alive between turns (the
 * child's stdin reader buffers user frames, so a send can land before init).
 * A child is (re)spawned lazily:
 * - first open/send after create
 * - after an unexpected exit
 * - when the session's env fingerprint changes (model profile or cwd edited),
 *   resuming the CLI session so the conversation continues seamlessly.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ExecEvent } from '../../shared/exec-events.js';
import type {
  CreateSessionInput,
  RenameInput,
  SessionMeta,
  SessionOpenResult,
  SessionPhase,
} from '../../shared/protocol.js';
import { CHANNELS } from '../../shared/protocol.js';
import { hashString, newDesktopSessionId, titleFromMessage } from '../../shared/ids.js';
import { ExecChild, interactiveExecArgs } from './spawn.js';
import { SessionJournal } from './journal.js';
import { SessionIndexStore } from './index-store.js';
import type { SettingsStore } from '../settings/store.js';
import { buildProfileEnv } from '../settings/env-inject.js';

const CLOSE_GRACE_MS = 8000;
const META_FLUSH_MS = 600;
const UNTITLED = 'New chat';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The CLI-side session id for a context epoch. `--session-id` has upsert
 * semantics (resume if the file exists, create otherwise), so a NEW id is all
 * it takes to give the model a fresh context window.
 */
export function contextSessionId(meta: { id: string; contextEpoch: number }): string {
  return meta.contextEpoch <= 0 ? meta.id : `${meta.id}-e${meta.contextEpoch}`;
}

interface LiveSession {
  meta: SessionMeta;
  journal: SessionJournal;
  child: ExecChild | null;
  phase: SessionPhase;
  envHash: string;
  envOverrides: Record<string, string>;
  requestedEnd: boolean;
  closeTimer: NodeJS.Timeout | null;
  metaFlushTimer: NodeJS.Timeout | null;
}

export interface RegistryDeps {
  userDataDir: string;
  settings: SettingsStore;
  /** Broadcast to the renderer (main wires this to win.webContents.send). */
  send: (channel: string, ...args: unknown[]) => void;
  /** Electron binary path for ELECTRON_RUN_AS_NODE children. */
  execPath: string;
  /** Resolved CLI launcher path. */
  launcherPath: () => string;
}

export class SessionRegistry {
  private readonly sessionsDir: string;

  private readonly index: SessionIndexStore;

  private readonly live = new Map<string, LiveSession>();

  private readonly settings: SettingsStore;

  private readonly deps: RegistryDeps;

  constructor(deps: RegistryDeps) {
    this.deps = deps;
    this.sessionsDir = path.join(deps.userDataDir, 'sessions');
    this.index = new SessionIndexStore(this.sessionsDir);
    this.settings = deps.settings;
  }

  async list(): Promise<SessionMeta[]> {
    return this.index.list();
  }

  async create(input: CreateSessionInput): Promise<SessionMeta> {
    const meta: SessionMeta = {
      id: newDesktopSessionId(),
      title: input.title?.trim() || UNTITLED,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      cwd: input.cwd,
      profileId: input.profileId,
      sessionFile: null,
      contextEpoch: 0,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      cost: { amount: 0, known: false },
      messageCount: 0,
    };
    await this.index.upsert(meta);
    this.broadcastList();
    return meta;
  }

  async open(id: string): Promise<SessionOpenResult> {
    const meta = await this.index.get(id);
    if (!meta) throw new Error(`Unknown session: ${id}`);
    const journal = new SessionJournal(this.sessionsDir, id);
    const events = await journal.readAll();
    const entry = this.ensureLiveEntry(meta, journal);
    if (!entry.child) this.spawnChild(entry);
    return { meta: entry.meta, events, phase: entry.phase };
  }

  async send(id: string, text: string): Promise<void> {
    const entry = await this.entryForSend(id);
    const ok = entry.child?.writeFrame({ type: 'user', text }) ?? false;
    if (!ok) throw new Error('Agent process is not running; try again in a moment.');
  }

  async interrupt(id: string): Promise<void> {
    this.live.get(id)?.child?.writeFrame({ type: 'interrupt' });
  }

  async rename(input: RenameInput): Promise<void> {
    const entry = this.live.get(input.id);
    const title = input.title.trim().slice(0, 80) || UNTITLED;
    if (entry) {
      entry.meta.title = title;
      await this.flushMeta(entry, true);
      return;
    }
    const meta = await this.index.get(input.id);
    if (!meta) return;
    meta.title = title;
    await this.index.upsert(meta);
    this.broadcastList();
  }

  async setCwd(id: string, cwd: string): Promise<void> {
    const entry = this.live.get(id);
    if (entry) {
      // The cwd is baked into the child at spawn; the env-hash check in
      // entryForSend notices the change and respawns (resuming the session)
      // before the next message.
      entry.meta.cwd = cwd;
      await this.flushMeta(entry, true);
      return;
    }
    const meta = await this.index.get(id);
    if (!meta) return;
    meta.cwd = cwd;
    await this.index.upsert(meta);
    this.broadcastList();
  }

  /**
   * Switch the session to another model profile. Like setCwd this takes effect
   * on the next spawn, which entryForSend triggers through the env hash.
   */
  async setProfile(id: string, profileId: string): Promise<void> {
    const profile = this.settings.getProfile(profileId);
    if (!profile) return;
    const entry = this.live.get(id);
    if (entry) {
      entry.meta.profileId = profileId;
      await this.flushMeta(entry, true);
      return;
    }
    const meta = await this.index.get(id);
    if (!meta) return;
    meta.profileId = profileId;
    await this.index.upsert(meta);
    this.broadcastList();
  }

  /**
   * Clear the context window: retire the child, drop the CLI-side session
   * file of the current epoch, and move to the next epoch. The next message
   * spawns a child with a fresh CLI session id (fresh model context); the
   * desktop journal and the visible transcript keep the full history.
   */
  async clearContext(id: string): Promise<SessionMeta | null> {
    const meta = await this.index.get(id);
    if (!meta) return null;
    const entry = this.live.get(id);
    let next: SessionMeta;
    if (entry) {
      await this.retireChild(entry, { fast: true });
      next = entry.meta;
    } else {
      next = { ...meta };
    }
    next.contextEpoch = (next.contextEpoch || 0) + 1;
    if (next.sessionFile) {
      await fs.rm(next.sessionFile, { force: true });
    }
    next.sessionFile = null;
    next.updatedAt = Date.now();
    if (entry) {
      await this.flushMeta(entry, true);
    } else {
      await this.index.upsert(next);
      this.broadcastList();
    }
    return next;
  }

  /** Graceful close: settle, persist, exit. The meta and journal survive. */
  async close(id: string): Promise<void> {
    const entry = this.live.get(id);
    if (!entry) return;
    await this.retireChild(entry);
  }

  /** Close, then delete the journal, the CLI session file, and the index row. */
  async remove(id: string): Promise<void> {
    const entry = this.live.get(id);
    if (entry) {
      await this.retireChild(entry);
      await entry.journal.remove();
      if (entry.meta.sessionFile) {
        await fs.rm(entry.meta.sessionFile, { force: true });
      }
      this.live.delete(id);
    } else {
      const meta = await this.index.get(id);
      if (meta?.sessionFile) await fs.rm(meta.sessionFile, { force: true });
      await new SessionJournal(this.sessionsDir, id).remove();
    }
    await this.index.remove(id);
    this.broadcastList();
  }

  /** App shutdown path: best-effort graceful settle for every live child. */
  async shutdown(): Promise<void> {
    const closers = [...this.live.values()].map((entry) => this.retireChild(entry));
    await Promise.all(closers);
    for (const entry of this.live.values()) {
      if (entry.metaFlushTimer) clearTimeout(entry.metaFlushTimer);
      await entry.journal.flush();
    }
  }

  // ---- internals ----

  private async entryForSend(id: string): Promise<LiveSession> {
    const meta = await this.index.get(id);
    if (!meta) throw new Error(`Unknown session: ${id}`);
    const entry = this.ensureLiveEntry(meta, new SessionJournal(this.sessionsDir, id));
    const desiredHash = await this.envHashFor(meta);
    const needsRespawn =
      entry.child === null ||
      entry.phase === 'closed' ||
      entry.phase === 'error' ||
      entry.envHash !== desiredHash;
    if (needsRespawn) {
      if (entry.child) await this.retireChild(entry);
      this.spawnChild(entry);
    }
    return entry;
  }

  private ensureLiveEntry(meta: SessionMeta, journal: SessionJournal): LiveSession {
    const existing = this.live.get(meta.id);
    if (existing) return existing;
    const entry: LiveSession = {
      meta: { ...meta },
      journal,
      child: null,
      phase: 'closed',
      envHash: '',
      envOverrides: {},
      requestedEnd: false,
      closeTimer: null,
      metaFlushTimer: null,
    };
    this.live.set(meta.id, entry);
    return entry;
  }

  private async envHashFor(meta: SessionMeta): Promise<string> {
    const overrides = await this.envOverridesFor(meta.profileId);
    return hashString(JSON.stringify({ overrides, cwd: meta.cwd }));
  }

  private async envOverridesFor(profileId: string): Promise<Record<string, string>> {
    const profile = this.settings.getProfile(profileId);
    if (!profile) {
      throw new Error(
        `The model profile used by this session no longer exists. Pick another profile in Settings.`,
      );
    }
    const key = this.settings.decryptKey(profile.id);
    return buildProfileEnv({
      mode: profile.mode,
      model: profile.model,
      baseUrl: profile.baseUrl,
      thinking: profile.thinking,
      apiKey: key,
    });
  }

  private spawnChild(entry: LiveSession): void {
    this.envOverridesFor(entry.meta.profileId)
      .then((envOverrides) => {
        entry.envOverrides = envOverrides;
        entry.envHash = hashString(JSON.stringify({ overrides: envOverrides, cwd: entry.meta.cwd }));
        entry.requestedEnd = false;
        const child = new ExecChild({
          launcherPath: this.deps.launcherPath(),
          args: interactiveExecArgs(contextSessionId(entry.meta)),
          cwd: entry.meta.cwd,
          envOverrides,
          execPath: this.deps.execPath,
          onEvent: (event) => this.onEvent(entry, event),
          onStderrLine: () => undefined,
          onExit: (code) => this.onChildExit(entry, code),
        });
        entry.child = child;
        this.setPhase(entry, 'starting');
        child.start();
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.deps.send(CHANNELS.sessionEvent, entry.meta.id, {
          type: 'error',
          sessionId: entry.meta.id,
          fatal: true,
          code: 'desktop_config_error',
          message,
        } satisfies ExecEvent);
        this.setPhase(entry, 'error');
      });
  }

  private onEvent(entry: LiveSession, event: ExecEvent): void {
    entry.journal.append(event);
    this.deps.send(CHANNELS.sessionEvent, entry.meta.id, event);
    this.applyEventToMeta(entry, event);
    this.applyEventToPhase(entry, event);
  }

  private applyEventToMeta(entry: LiveSession, event: ExecEvent): void {
    let dirty = false;
    if (event.type === 'system' && event.subtype === 'init') {
      if (event.sessionFile && event.sessionFile !== entry.meta.sessionFile) {
        entry.meta.sessionFile = event.sessionFile;
        dirty = true;
      }
      if (entry.phase === 'starting') this.setPhase(entry, 'idle');
    }
    if (event.type === 'user' && event.source === 'caller') {
      entry.meta.messageCount += 1;
      if (entry.meta.title === UNTITLED) {
        entry.meta.title = titleFromMessage(event.text);
      }
      dirty = true;
    }
    if (event.type === 'result') {
      entry.meta.usage.inputTokens += event.usage.inputTokens;
      entry.meta.usage.outputTokens += event.usage.outputTokens;
      entry.meta.usage.totalTokens += event.usage.totalTokens;
      entry.meta.cost.amount += event.usage.totalTokens > 0 ? event.cost.amount : 0;
      entry.meta.cost.known = entry.meta.cost.known || event.cost.known;
      dirty = true;
    }
    if (dirty) {
      entry.meta.updatedAt = Date.now();
      this.scheduleMetaFlush(entry);
    }
  }

  private applyEventToPhase(entry: LiveSession, event: ExecEvent): void {
    if (event.type === 'turn_state') {
      // `result` only fires when the WHOLE run ends (end frame / exit) - see
      // exec/index.ts: emitter.result runs after drive() returns. In an
      // interactive session the per-turn completion signal is turn_state:
      // started -> running, completed/failed/cancelled -> idle. Mapping only
      // `result` left the phase stuck at 'running' after every turn.
      this.setPhase(entry, event.phase === 'started' ? 'running' : 'idle');
      return;
    }
    if (event.type === 'result') {
      this.setPhase(entry, 'idle');
    }
  }

  private onChildExit(entry: LiveSession, code: number | null): void {
    if (entry.closeTimer) {
      clearTimeout(entry.closeTimer);
      entry.closeTimer = null;
    }
    const wasRequested = entry.requestedEnd;
    entry.child = null;
    this.setPhase(entry, wasRequested || code === 0 ? 'closed' : 'error');
    void entry.journal.flush().then(() => this.flushMeta(entry, true));
  }

  private async retireChild(entry: LiveSession, opts: { fast?: boolean } = {}): Promise<void> {
    entry.requestedEnd = true;
    const child = entry.child;
    if (!child) {
      this.setPhase(entry, 'closed');
      return;
    }
    this.setPhase(entry, 'closing');
    if (opts.fast) {
      // Discard path (context clear): the epoch's session file is deleted
      // anyway, so a settle is worthless - drain briefly, then hard-kill.
      child.kill();
      await this.waitForChildGone(entry, 1500);
      return;
    }
    child.requestEnd();
    // Prefer the settle signal (result => persisted); fall back to the grace
    // timer because this CLI build can linger after the end frame.
    await Promise.race([child.settled().then(() => sleep(250)), sleep(CLOSE_GRACE_MS)]);
    if (entry.child !== null) child.kill();
    await this.waitForChildGone(entry, 2000);
  }

  private async waitForChildGone(entry: LiveSession, budgetMs: number): Promise<void> {
    const started = Date.now();
    while (entry.child !== null && Date.now() - started < budgetMs) {
      await sleep(80);
    }
    if (entry.child !== null) {
      entry.child = null;
      this.setPhase(entry, 'closed');
      void entry.journal.flush().then(() => this.flushMeta(entry, true));
    }
  }

  private setPhase(entry: LiveSession, phase: SessionPhase): void {
    if (entry.phase === phase) return;
    entry.phase = phase;
    this.deps.send(CHANNELS.sessionPhase, entry.meta.id, phase);
  }

  private scheduleMetaFlush(entry: LiveSession): void {
    if (entry.metaFlushTimer) return;
    entry.metaFlushTimer = setTimeout(() => {
      entry.metaFlushTimer = null;
      void this.flushMeta(entry, false);
    }, META_FLUSH_MS);
  }

  private async flushMeta(entry: LiveSession, immediate: boolean): Promise<void> {
    if (entry.metaFlushTimer && immediate) {
      clearTimeout(entry.metaFlushTimer);
      entry.metaFlushTimer = null;
    }
    if (!immediate && entry.metaFlushTimer) return;
    await this.index.upsert(entry.meta);
    this.broadcastList();
  }

  private broadcastList(): void {
    void this.index.list().then((list) => this.deps.send(CHANNELS.sessionListChanged, list));
  }
}
