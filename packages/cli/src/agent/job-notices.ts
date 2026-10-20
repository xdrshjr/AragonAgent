/**
 * JobNoticeRelay — the controller-side owner of "a job finished, and the model
 * has to be told exactly once" (long-task-jobs §4.6 / §4.6.1).
 *
 * ASCII ONLY: `src/agent/**` is inside the glyph scanner's scope.
 *
 * THREE CHANNELS, ONE QUEUE, AND A LEDGER. The queue guarantees "at most once"
 * because every channel takes from it with `drain()`. That alone is NOT enough,
 * and this file exists because of the exception: Core's steering queue has a
 * fourth consumer that DESTROYS rather than drains.
 *
 *   `fast/reviewer.ts` calls `clearAllQueues()` when `userSteerCount() === 0`,
 *   and its stated safety argument is "`AgentController.steer()` is the only
 *   other writer in the package". A job notice queued through
 *   `enqueueSteering(text, false)` returns no receipt id, never enters
 *   `pendingUserSteering`, and is therefore INVISIBLE to that counter. With
 *   `fast` on, the last notice of a run could be wiped with no log line, no UI
 *   change and no failing test.
 *
 * THE FIX IS A LEDGER, NOT A COUPLING. A notice that has been steered is held in
 * `pendingSteered` until a `steering_accepted` receipt proves the queue was
 * drained; anything still held at `turn_start` or at the end of a run is pushed
 * back into the queue. `JobNoticeQueue.push` is idempotent by id, so a re-queue
 * can only ever cause a DELAY, never a duplicate.
 *
 * NOTHING HERE IS PUSHED WHILE A TOOL BATCH IS OPEN. The controller owns the
 * batch count and calls `tryPush()` only from the one safe point; this class
 * re-checks the same condition so a future call site cannot forget it (I-5).
 */

import { renderJobNotices, type JobNotice, type JobNoticeQueue } from '../proc/notices.js';
import { isTerminalStatus, type JobKind, type ProcEvent, type ServiceStatus } from '../proc/types.js';

export interface JobNoticeRelayDeps {
  queue: JobNoticeQueue;
  /** `enqueueSteering(text, false)` - the existing receipt-less path (§4.6). */
  steer: (text: string) => void;
  /** `activeToolCalls === 0 && isRunning() && !abortRequested` (I-5). */
  isAtSafeSteerPoint: () => boolean;
  /**
   * `activeToolCalls === 0 && !abortRequested` - the FILL channel's precondition.
   *
   * DELIBERATELY NOT `isAtSafeSteerPoint()`, and the difference is one clause.
   * The fill channel runs immediately BEFORE `agent.prompt()` / `agent.continue()`,
   * where `isRunning()` is FALSE by contract (Core throws
   * `Agent is already running` if it were true), so reusing the push predicate
   * would make this channel dead - every stranded notice would wait for the next
   * tool batch instead of going out with the user's message.
   *
   * What I-5 protects is "never inject text while a tool batch is open", and
   * `activeToolCalls === 0` is exactly that clause; the `isRunning()` half of the
   * push predicate exists for a different reason (a push is worthless if no run
   * will ever drain it). Steering just before a run starts is the case the
   * `steering_accepted` receipt was designed for: the loop's first checkpoint is
   * the top of the loop, before any `tool_use` exists, so the text is merged into
   * history structurally safely.
   */
  canSteerBeforeTurn: () => boolean;
  /** `cfg.jobs.noticeSteer`, read LIVE: `false` disables the PUSH channel only. */
  steerEnabled: () => boolean;
}

/** A terminal id this session has already reported (RV-P2-7's third state). */
interface RecalledJob {
  kind: JobKind;
  status: ServiceStatus;
}

export class JobNoticeRelay {
  /**
   * Notices that have been steered but not yet proven delivered, keyed by
   * `${id}:${status}:${at}` - the same identity `JobNoticeQueue` uses.
   */
  private readonly pendingSteered = new Map<string, JobNotice>();
  /**
   * Terminal ids this session has seen, so `job_wait` can answer "it finished and
   * was reclaimed, do not re-run it" instead of "no such job".
   *
   * Bounded by `maxNotices`, oldest out: it answers a question about the recent
   * past, and an unbounded map in a long session is a leak with a helpful name.
   */
  private readonly recalled = new Map<string, RecalledJob>();
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly deps: JobNoticeRelayDeps) {}

  /** Subscribe to the supervisor's stream. Returns the release function. */
  attach(subscribe: (listener: (event: ProcEvent) => void) => () => void): void {
    this.unsubscribe?.();
    this.unsubscribe = subscribe((event) => this.onProcEvent(event));
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /** Terminal ids this session has already reported, for `job_wait`'s message. */
  terminalRecord(id: string): RecalledJob | undefined {
    return this.recalled.get(id);
  }

  /**
   * Move everything queued into the steering queue, if this is a safe moment.
   *
   * Returns whether anything was pushed. Called from exactly one place in the
   * controller - the `tool_execution_end` listener, after the batch count reaches
   * zero.
   */
  tryPush(): boolean {
    if (!this.deps.steerEnabled()) return false;
    if (!this.deps.isAtSafeSteerPoint()) return false;
    return this.steerQueued();
  }

  /**
   * Deliver the queue just BEFORE a run starts (the FILL channel, §4.6).
   *
   * TWO DIFFERENCES FROM `tryPush()`, both deliberate:
   *
   *  - the precondition is `canSteerBeforeTurn()` (no `isRunning()` term), because
   *    this runs before `agent.prompt()` / `agent.continue()`, where the engine is
   *    not running yet - see the dep's own comment;
   *  - `noticeSteer` does NOT gate it. That key switches the PUSH channel only
   *    ("noticeSteer=false is not a notification off switch", §6.5), so a user who
   *    declines mid-turn interruptions must still learn that the job finished
   *    before their next message is sent.
   */
  flushForTurn(): boolean {
    if (!this.deps.canSteerBeforeTurn()) return false;
    return this.steerQueued();
  }

  /** The shared half: take the queue, record the ledger, steer one block. */
  private steerQueued(): boolean {
    const notices = this.deps.queue.drain();
    if (notices.length === 0) return false;
    for (const notice of notices) this.pendingSteered.set(noticeKey(notice), notice);
    this.deps.steer(renderJobNotices(notices));
    return true;
  }

  /**
   * A receipt means Core accepted a batch of steering text, which means the queue
   * it came from has been drained.
   *
   * Notices carry no receipt id (`steer(text, id?)`'s `id` is optional and the
   * receipt-less path passes none), so an arriving receipt is the only available
   * proof. Treating "a receipt arrived" as "everything we steered was delivered"
   * is correct in the only direction that matters: an over-eager release costs a
   * MISSING notice, so the release is deferred to the next `steering_accepted`
   * cycle rather than assumed at `steer()` time.
   */
  onSteeringAccepted(): void {
    this.pendingSteered.clear();
  }

  /**
   * Put undelivered notices back at `turn_start` and at the end of a run.
   *
   * THIS IS WHAT TURNS "swallowed by clearAllQueues()" INTO "delivered one turn
   * later". `push` deduplicates by id, so a notice that WAS delivered and is also
   * re-queued can only be re-rendered once - and it is not re-queued at all,
   * because a delivered notice was released by its receipt.
   */
  requeueUndelivered(): void {
    if (this.pendingSteered.size === 0) return;
    const stranded = [...this.pendingSteered.values()];
    this.pendingSteered.clear();
    for (const notice of stranded) this.deps.queue.push(notice);
  }

  /**
   * Drain for the PULL channel.
   *
   * NOTHING IS RECORDED HERE, and that is the point: `drain()` hands ownership to
   * the tool result that is about to carry the block, so there is no pending
   * state to reconcile - the text is in the conversation as soon as the result
   * returns.
   */
  drainForTail(): JobNotice[] {
    return this.deps.queue.drain();
  }

  private onProcEvent(event: ProcEvent): void {
    const job = event.service;
    if (!isTerminalStatus(job.status)) return;
    const kind: JobKind = job.kind;
    this.recalled.set(job.id, { kind, status: job.status });
    while (this.recalled.size > 32) {
      const oldest = this.recalled.keys().next();
      if (oldest.done === true) break;
      this.recalled.delete(oldest.value);
    }
    // One notice per terminal transition. `exited`/`stopped` are single events per
    // job (the supervisor's own guards enforce that), so no de-duplication is
    // needed here beyond the queue's own.
    if (job.status !== 'exited' && job.status !== 'failed' && job.status !== 'stopped') return;
    this.deps.queue.push({
      id: job.id,
      kind,
      status: job.status,
      exitCode: job.exitCode,
      signal: job.signal,
      elapsedMs: (job.endedAt ?? Date.now()) - job.startedAt,
      ...(job.progress?.text ? { progressText: job.progress.text } : {}),
      // A FAILURE EARNS A TAIL; a clean exit does not (the block stays bounded).
      tailRows:
        job.status === 'failed' || (job.exitCode !== null && job.exitCode !== 0)
          ? job.rows.slice(-2)
          : [],
      at: Date.now(),
    });
  }
}

function noticeKey(notice: JobNotice): string {
  return `${notice.id}:${notice.status}:${notice.at}`;
}
