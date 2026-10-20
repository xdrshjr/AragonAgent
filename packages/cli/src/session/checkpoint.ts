/**
 * Session checkpoint writer (tui-session-id-resume §3.4 / D-2 / D-3 / D-4 /
 * D-21 / D-22 / D-23).
 *
 * ASCII ONLY - `src/session/**` is inside `glyphs.test.ts::inScope`.
 *
 * WHY THIS MODULE EXISTS AT ALL: a TUI conversation lives in memory
 * (`agent.state.messages`). Another terminal can only continue it if the process
 * has put it on disk, and the only serializer that exists (`saveSession`) is
 * written for explicit exports. So this is the one owner of three properties an
 * export never needed:
 *
 *   1. THE FILE ON DISK IS ALWAYS SENDABLE (D-3 / I-4). A checkpoint taken
 *      mid-tool would leave an assistant `tool_call` with no `tool_result`, and
 *      the next request of the branch that resumes it is an HTTP 400 - the very
 *      first thing `--resume` is for.
 *   2. THE REPLACEMENT IS ATOMIC (D-4). This is the repository's first "a writer
 *      and a reader coexist" session file: the parent TUI writes while another
 *      terminal reads. A truncated read says "corrupt session", and one false
 *      report is enough for a user to stop trusting the feature.
 *   3. NOTHING LIVE SURVIVES INTO THE FILE (D-22 / I-11). A `running` tool card
 *      that never settles keeps `ToolCard` spinning and keeps `Transcript`'s
 *      MONOTONIC settled boundary from ever moving past it, so every frame
 *      re-renders the tail. The settlement happens on the WRITE COPY, not on the
 *      load path, because `live-session.test.ts` pins the `/save` decision that
 *      a reloaded card keeps its status - and `/save` is an explicit export made
 *      with the user watching, while a checkpoint is not.
 *
 * NOTHING HERE MAY INTERRUPT A CONVERSATION (I-8): every filesystem failure is
 * swallowed, logged, and reported as a value.
 */

import { renameSync, statSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { validateHistory, type Message, type ModelRef } from '@aragon-agent/core';
import type { Entry, UsageTotal } from '../agent/reducer.js';
import type { TodoItem } from '../todo/types.js';
import type { CompactionIdentity } from '../compaction/memory-identity.js';
import { getSessionsDir } from '../config/app-paths.js';
import { getLogger } from '../logging/logger.js';
import { SESSION_CHECKPOINT_LIMITS } from './limits.js';
import { saveSession, type SessionMeta } from './persist.js';
import { tryAcquireSessionLock, type SessionLockHandle } from './store.js';

/** The literal text a repaired `tool_result` carries. Read by the MODEL next turn. */
const INTERRUPTED_TOOL_RESULT = 'interrupted before completion';
/** The literal `preview` a settled tool card carries. Rendered in the transcript. */
const INTERRUPTED_TOOL_PREVIEW = 'interrupted (session checkpoint)';

/**
 * What the view side can tell the writer: the identity, the transcript, and this
 * process's spend.
 *
 * A MINIMAL PORT RATHER THAN A REFERENCE TO `ViewState`. The writer must not know
 * what a reducer is, and `usageTotal` is here because `meta.usage` has no other
 * source (R-5): it is the cumulative value this process has spent, it is NEVER
 * read back (D-10), and it starts again from zero whenever the id changes.
 */
export interface LiveSessionView {
  id: string;
  entries: Entry[];
  /** This process's spend; the only source of `meta.usage` (R-5). Never read back. */
  usageTotal: UsageTotal;
}

export interface CheckpointDeps {
  /** `cli.tsx` injects `readSessionView`; `undefined` means "no identity here". */
  readView(): LiveSessionView | undefined;
  /** The controller's two live pieces; injected so the writer is unit-testable. */
  readHistory(): { messages: Message[]; compactionIdentity?: CompactionIdentity };
  readTodos(): TodoItem[];
  readModel(): ModelRef;
  /** `meta.cwd`; read at every write because `/cwd` can change it. */
  readCwd(): string;
  /** `meta.cli`. */
  version: string;
  /**
   * `meta.branchOf`. Read at write time rather than captured, because the App
   * can rotate the identity after `/resume` (D-15) and the lineage must follow.
   */
  readParentId?(): string | undefined;
  /** `--save <id>` starts the session pinned; `/session pin` sets it later. */
  startPinned?: boolean;
  now?(): number;
  /** The target path; injected so tests point at a temporary directory. */
  pathFor?(id: string): string;
  /**
   * The per-process claim on this id (S-7). Injected so a unit test can answer
   * `null` instead of creating a lock in the real sessions directory.
   */
  lockFor?(id: string): SessionLockHandle | null;
}

export interface CheckpointResultOk {
  ok: true;
  path: string;
  bytes: number;
  repaired: number;
  settled: number;
}

export type CheckpointResult =
  | CheckpointResultOk
  | { ok: false; reason: 'no-identity' | 'not-sendable' | 'write-failed'; message: string };

/**
 * `writeNow`'s switches.
 *
 * `force` skips the fingerprint short circuit and NOTHING ELSE (D-15 / I-7): an
 * unsendable history is still refused, the settle-and-repair pass still runs, and
 * the file it produces is still `loadSession()`-readable. It exists because
 * `Ctrl+L` spawns a process that reads this file immediately, and a short-
 * circuited write returns `bytes: 0` with the file's content being whatever the
 * last successful write left there - right after `aragon sessions rm <id>`, that
 * is "no file at all", and the branch would greet the user with
 * `No session "<id>"` (tui-branch-terminal-shortcut D-3).
 */
export interface CheckpointOptions {
  /** `/session pin` and `--save <id>`. */
  pin?: boolean;
  /** Ignore the fingerprint short circuit (D-15). */
  force?: boolean;
}

/**
 * Repair every `tool_call` that never received its `tool_result` (D-3).
 *
 * ON A COPY, AND THAT IS THE POINT (I-2). The live history belongs to the
 * engine; a host that edited it would change what the next request sends. Each
 * dangling call gets an `isError` result carrying one fixed sentence, and the
 * caller re-runs `validateHistory` afterwards: a repair that is still not
 * sendable means the file must not be written.
 */
export function closeDanglingToolCalls(messages: readonly Message[]): {
  messages: Message[];
  repaired: number;
} {
  const open = new Set<string>();
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const block of message.content) {
        if (block.type === 'tool_call') open.add(block.toolCallId);
      }
    } else if (message.role === 'tool_result') {
      open.delete(message.toolCallId);
    }
  }
  if (open.size === 0) return { messages: [...messages], repaired: 0 };
  const patched: Message[] = [...messages];
  for (const toolCallId of open) {
    patched.push({
      role: 'tool_result',
      toolCallId,
      isError: true,
      content: INTERRUPTED_TOOL_RESULT,
    });
  }
  return { messages: patched, repaired: open.size };
}

/**
 * Settle every `running` tool card on a COPY (D-22 / I-11).
 *
 * `error` rather than `done`: the command did not finish, and a card that said
 * otherwise would claim a result nobody saw. The live tail is cleared for the
 * same reason `stripLiveToolOutput` clears it - it describes a process that died
 * with the session - and `preview` names WHY, so a resumed card is not a silent
 * lie. `pending` is left alone: `ToolCard` draws no spinner for it and
 * `Transcript.nowSecFor` never re-clocks it, so it settles by itself.
 */
export function settleRunningToolCards(entries: readonly Entry[]): {
  entries: Entry[];
  settled: number;
} {
  let settled = 0;
  const out = entries.map((entry) => {
    if (entry.kind !== 'tool' || entry.status !== 'running') return entry;
    settled += 1;
    return {
      ...entry,
      status: 'error' as const,
      isError: true,
      preview: INTERRUPTED_TOOL_PREVIEW,
      live: undefined,
      liveSeq: undefined,
      lastOutputAt: undefined,
    };
  });
  return { entries: out, settled };
}

/** What may reach the disk: nothing at all, or a history the engine can resend. */
export function isSendable(messages: readonly Message[]): boolean {
  if (messages.length === 0) return true;
  return validateHistory(messages).ok;
}

/** One write's inputs, so the private steps take a named shape rather than six args. */
interface WriteInput {
  view: LiveSessionView;
  messages: Message[];
  compactionIdentity?: CompactionIdentity;
  entries: Entry[];
  repaired: number;
  settled: number;
  reason: 'running' | 'exit' | 'signal';
}

/**
 * The checkpoint writer.
 *
 * ONE TIMER (I-10). Several `agent_end` events in a row - a todo follow-through
 * restarts the run without the user typing - are merged into one write, and the
 * timer is `unref`ed so a pending write can never hold the process open. Every
 * exit path calls `flushSync`, which is idempotent so the three of them
 * (`waitUntilExit().then()`, the signal hook and `process.on('exit')`) can
 * coexist without writing three times.
 */
export class SessionCheckpointWriter {
  private readonly deps: CheckpointDeps;
  private readonly pathFor: (id: string) => string;
  private lastFingerprint: string | null = null;
  private lastWriteAt = 0;
  private createdAt: number | null = null;
  private pinned: boolean;
  private failureStreak = 0;
  private pending: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  private exited = false;
  /**
   * Whether the LAST WRITE FILE still says `live: true`.
   *
   * The fingerprint deliberately does not include the reason for the write, so
   * without this the exit flush would short-circuit as "nothing changed" and the
   * file would keep `live: true` forever - which is the flag `sessions prune`
   * reads as "a writer is still here" (T-10's sibling, and the reason
   * `flushSync` must be able to write a file whose CONTENT is unchanged but whose
   * METADATA is not).
   */
  private lastWroteLive = false;
  private lastResult: CheckpointResult | null = null;
  /**
   * THIS PROCESS'S CLAIM ON THE FILE IT WRITES (S-7).
   *
   * Without it, `meta.live` is a flag nobody can verify: `sessions prune` reads
   * the `.lock` payload to decide whether the writer is still alive, and the TUI
   * never took one - so `prune --origin tui --yes` deleted the checkpoint of a
   * session that was running at that moment. The lock is the same one `exec`
   * uses to keep two writers off one file; a killed process leaves a dead pid
   * behind and the existing staleness probe collects it.
   */
  private lock: SessionLockHandle | null = null;
  private lockedId: string | null = null;

  constructor(deps: CheckpointDeps) {
    this.deps = deps;
    this.pinned = deps.startPinned === true;
    this.pathFor = deps.pathFor ?? ((id: string) => join(getSessionsDir(), `${id}.json`));
  }

  /**
   * Write once now: after mount, so the id on screen is resumable immediately.
   *
   * THE `no-identity` ANSWER IS A TIMING ANSWER, NOT A PERMANENT ONE. `render()`
   * returns before `App` has run its first effects, so the session slot can still
   * be empty when this is called - and "the id on screen is not resumable until
   * the first turn" is exactly the failure D-2 exists to prevent (a zero-turn
   * session must already be a session). One deferred retry through the SAME
   * single timer (I-10) turns that window into the write; if the view was already
   * published, the first call succeeded and no timer is armed at all.
   */
  start(): CheckpointResult {
    const result = this.write('running');
    if (!result.ok && result.reason === 'no-identity') this.schedule();
    return result;
  }

  /** Subscribe to `agent_end`. The writer does not own the controller's lifetime. */
  attach(subscribe: (fn: () => void) => () => void): void {
    this.unsubscribe?.();
    this.unsubscribe = subscribe(() => this.onAgentEnd());
  }

  /** Write now, optionally pinning (`/session pin`) or forcing past the short circuit. */
  writeNow(opts: CheckpointOptions = {}): CheckpointResult {
    if (opts.pin) this.pinned = true;
    return this.write('running', opts.force === true);
  }

  /**
   * The exit-path write. Never throws, and after the first call it is a no-op
   * (I-10): all three exit paths run on a normal quit.
   */
  flushSync(reason: 'exit' | 'signal'): CheckpointResult {
    if (this.exited) return this.lastResult ?? noIdentity();
    this.exited = true;
    this.clearPending();
    const result = this.write(reason);
    // AFTER THE WRITE, BEFORE ANYONE ELSE LOOKS: the exit flush is the last
    // thing this process does to this file, and a lock left behind would make
    // `sessions prune` skip a session nobody is writing any more.
    this.releaseLock();
    return result;
  }

  dispose(): void {
    this.clearPending();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.releaseLock();
  }

  // -------------------------------------------------------------------------
  // Scheduling
  // -------------------------------------------------------------------------

  private onAgentEnd(): void {
    if (this.fingerprint() === this.lastFingerprint) return;
    this.schedule();
  }

  /**
   * Coalesce into one timer. `debounceMs` is the window; `minWriteIntervalMs`
   * keeps two consecutive run boundaries - which arrive closer together than a
   * human can type - from landing two full session writes back to back.
   */
  private schedule(): void {
    if (this.pending) return;
    const since = this.now() - this.lastWriteAt;
    const wait = Math.max(
      SESSION_CHECKPOINT_LIMITS.debounceMs,
      SESSION_CHECKPOINT_LIMITS.minWriteIntervalMs - since,
    );
    const timer = setTimeout(() => {
      this.pending = null;
      this.write('running');
    }, wait);
    // A checkpoint must never be the reason `aragon` does not exit.
    timer.unref?.();
    this.pending = timer;
  }

  private clearPending(): void {
    if (!this.pending) return;
    clearTimeout(this.pending);
    this.pending = null;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  // -------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------

  /**
   * The full write, in the one order that keeps the file honest: read, repair,
   * gate, settle, write to a temporary file, replace.
   *
   * `force` is ONE switch with ONE effect (D-15 / I-7): it skips the fingerprint
   * short circuit below. Everything after it - the dangling-call repair, the
   * sendable gate, the settle pass, the atomic replace - runs unchanged, because a
   * forced write still has to produce a file `loadSession()` can read back.
   */
  private write(reason: 'running' | 'exit' | 'signal', force = false): CheckpointResult {
    const view = this.deps.readView();
    if (!view) {
      this.lastResult = noIdentity();
      return this.lastResult;
    }
    const fingerprint = this.fingerprint();
    const wantsLive = reason === 'running';
    if (!force && fingerprint === this.lastFingerprint && wantsLive === this.lastWroteLive) {
      // No change: not touching the file is the answer, not a failure (T-11).
      // `force` skips exactly this branch and nothing else (D-15 / I-7).
      this.lastResult = {
        ok: true,
        path: this.pathFor(view.id),
        bytes: 0,
        repaired: 0,
        settled: 0,
      };
      return this.lastResult;
    }
    const history = this.deps.readHistory();
    const repaired = closeDanglingToolCalls(history.messages);
    if (!isSendable(repaired.messages)) {
      // SKIPPED, NOT WRITTEN (D-3). An orphan `tool_result` cannot be repaired
      // host-side - inventing the `tool_call` it belongs to would forge a call
      // the engine never made - so the previous good file stays, and the reason
      // goes to the log rather than into the user's conversation (I-8).
      const verdict = validateHistory(repaired.messages);
      const why = verdict.ok ? 'unknown' : verdict.reason;
      getLogger().warn('session', 'checkpoint_not_sendable', { reason: why });
      this.lastResult = { ok: false, reason: 'not-sendable', message: why };
      return this.lastResult;
    }
    const settled = settleRunningToolCards(view.entries);
    this.lastResult = this.persist({
      view,
      messages: repaired.messages,
      ...(history.compactionIdentity ? { compactionIdentity: history.compactionIdentity } : {}),
      entries: settled.entries,
      repaired: repaired.repaired,
      settled: settled.settled,
      reason,
    });
    if (this.lastResult.ok) {
      this.lastFingerprint = fingerprint;
      this.lastWroteLive = wantsLive;
      this.lastWriteAt = this.now();
      this.failureStreak = 0;
      if (this.createdAt === null) this.createdAt = this.lastWriteAt;
    }
    return this.lastResult;
  }

  /** Serialize to `<id>.json.tmp-<uuid>` and rename over the real file (D-4). */
  private persist(input: WriteInput): CheckpointResult {
    this.holdLock(input.view.id);
    const path = this.pathFor(input.view.id);
    const tmp = `${path}.tmp-${randomUUID()}`;
    const data = {
      model: this.deps.readModel(),
      messages: input.messages,
      ...(input.compactionIdentity ? { compactionIdentity: input.compactionIdentity } : {}),
      entries: input.entries,
      todos: this.deps.readTodos(),
      meta: this.buildMeta(input),
    };
    try {
      saveSession(tmp, data);
      const bytes = replaceFile(tmp, path, () => saveSession(path, data));
      if (input.repaired > 0) {
        getLogger().info('session', 'checkpoint_repaired_tool_calls', { repaired: input.repaired });
      }
      if (input.settled > 0) {
        getLogger().info('session', 'checkpoint_settled_tool_cards', { settled: input.settled });
      }
      return {
        ok: true,
        path,
        bytes,
        repaired: input.repaired,
        settled: input.settled,
      };
    } catch (error) {
      unlinkQuietly(tmp);
      return this.fail(error);
    }
  }

  /**
   * `meta`, field by field (§6.1). Two of these are easy to get subtly wrong:
   * `createdAt` is frozen at the first write (re-reading it every time would
   * make the field a second `updatedAt`), and `turns` counts assistant messages
   * IN THE FILE - a quantity a reader can verify, unlike "what this cost".
   */
  private buildMeta(input: WriteInput): SessionMeta {
    const model = this.deps.readModel();
    const parentId = this.deps.readParentId?.();
    return {
      id: input.view.id,
      cwd: this.deps.readCwd(),
      createdAt: this.createdAt ?? this.now(),
      updatedAt: this.now(),
      turns: input.messages.filter((message) => message.role === 'assistant').length,
      cli: this.deps.version,
      provider: model.providerId,
      model: model.modelId,
      usage: {
        inputTokens: input.view.usageTotal.inputTokens,
        outputTokens: input.view.usageTotal.outputTokens,
      },
      origin: 'tui',
      ...(this.pinned ? { pinned: true as const } : {}),
      // Omitted by the exit flush: `live` means "a writer believes a process is
      // still here", and both exit paths know better.
      ...(input.reason === 'running' ? { live: true as const } : {}),
      ...(parentId ? { branchOf: parentId } : {}),
    };
  }

  /**
   * Take, or move, this process's lock on the id being written (S-7).
   *
   * BEST EFFORT, AND NEVER FATAL: a checkpoint must not fail because someone
   * else holds the lock - the write is atomic and the file is this id's own, so
   * the worst case is a `live` flag that `prune` declines to trust.
   */
  private holdLock(id: string): void {
    if (this.lockedId === id && this.lock) return;
    this.releaseLock();
    this.lockedId = id;
    try {
      this.lock = (this.deps.lockFor ?? tryAcquireSessionLock)(id);
    } catch (error) {
      // An id the lock refuses is an id that could not be a file name either; the
      // write below reports that on its own terms.
      this.lock = null;
      getLogger().debug('session', 'checkpoint_lock_skipped', {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private releaseLock(): void {
    this.lock?.release();
    this.lock = null;
    this.lockedId = null;
  }

  /** A failed write is a log line and a return value, never an exception (I-8). */
  private fail(error: unknown): CheckpointResult {
    this.failureStreak += 1;
    const message = error instanceof Error ? error.message : String(error);
    const data = { reason: message, streak: this.failureStreak };
    if (this.failureStreak >= SESSION_CHECKPOINT_LIMITS.loudFailureStreak) {
      getLogger().error('session', 'checkpoint_write_failed', data);
    } else {
      getLogger().warn('session', 'checkpoint_write_failed', data);
    }
    return { ok: false, reason: 'write-failed', message };
  }

  /**
   * A cheap content fingerprint: identity, message count, last message shape,
   * entry count, last entry id, todo count and the pin flag.
   *
   * SHORT AND STRUCTURAL ON PURPOSE. Hashing the whole conversation would cost
   * as much as writing it (K-1), and the question this answers is only "did
   * anything settle since the last write".
   */
  private fingerprint(): string {
    const view = this.deps.readView();
    if (!view) return 'none';
    const { messages } = this.deps.readHistory();
    const last = messages[messages.length - 1];
    const lastShape =
      last === undefined
        ? '-'
        : last.role === 'assistant'
          ? `a:${last.stopReason ?? '-'}:${last.content.length}`
          : last.role === 'tool_result'
            ? `t:${last.toolCallId}`
            : 'u';
    const lastEntry = view.entries[view.entries.length - 1]?.id ?? '-';
    return [
      view.id,
      messages.length,
      lastShape,
      view.entries.length,
      lastEntry,
      this.deps.readTodos().length,
      this.pinned ? 'pin' : '-',
    ].join('|');
  }
}

function noIdentity(): CheckpointResult {
  return {
    ok: false,
    reason: 'no-identity',
    message: 'This process has no session identity, so nothing was checkpointed.',
  };
}

/**
 * Replace `path` with `tmp`, retrying while Windows refuses (D-4 / K-2).
 *
 * `EPERM`/`EEXIST` here means a reader has the file open, which is the NORMAL
 * case for this feature rather than an error. Three short synchronous waits
 * cover a reader finishing a read; if all of them fail, `degrade()` writes the
 * payload in place and says so in the log - a checkpoint that records its own
 * degradation beats a conversation that was never saved at all.
 */
function replaceFile(tmp: string, path: string, degrade: () => void): number {
  let lastError: unknown;
  for (let attempt = 0; attempt < SESSION_CHECKPOINT_LIMITS.renameAttempts; attempt += 1) {
    try {
      renameSync(tmp, path);
      return sizeOf(path);
    } catch (error) {
      lastError = error;
      sleepSync(SESSION_CHECKPOINT_LIMITS.renameRetryMs);
    }
  }
  getLogger().warn('session', 'checkpoint_write_degraded', {
    reason: 'rename-failed',
    error: lastError instanceof Error ? lastError.message : String(lastError),
  });
  degrade();
  unlinkQuietly(tmp);
  return sizeOf(path);
}

/** The only synchronous sleep available without a native dependency. */
function sleepSync(ms: number): void {
  const cell = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(cell, 0, 0, ms);
}

function sizeOf(path: string): number {
  try {
    // Measured AFTER the rename, so the number reported describes the file a
    // reader would find rather than the buffer that was written.
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function unlinkQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone, or a handle still open. Neither is worth failing a run for.
  }
}
