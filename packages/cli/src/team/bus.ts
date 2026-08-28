/**
 * TeamBus — the subagent message channel (team-subagents §3.6).
 *
 * ASCII ONLY: `src/team/**` is inside the glyph scanner's scope.
 *
 * The requirement asks for "lei si ren lei jiao liu de dian hua ji zhi, dan bu
 * neng tai pin fan" — a real telephone, used sparingly. This module takes both
 * halves literally: there IS a channel, and it is expensive on purpose. The rate
 * limits in `TEAM_LIMITS` are the requirement, not a compromise (R-9).
 *
 * DELIVERY IS PIGGY-BACKED, NEVER PUSHED (D-4). A message for child B is
 * appended to B's NEXT TOOL RESULT by `withMailboxTail`. `Agent.steer()` looks
 * like the natural push channel and is the wrong answer: the core agent loop
 * treats steering that arrives mid-batch by pushing "Tool execution skipped due
 * to steering interrupt." for EVERY REMAINING TOOL CALL in that batch, so a
 * chatty peer would cancel its colleague's work as a side effect of saying
 * hello. Piggy-backing costs zero extra turns, cannot interfere with the loop,
 * and is guaranteed to be seen by any child that is doing anything at all.
 *
 * EVERY REFUSAL IS A NON-ERROR (D-7). An `errorResult` reads to a model as a
 * malfunction and invites an immediate retry, which is precisely the "tai pin
 * fan" behaviour being designed out. The verdicts below carry a `reason` the
 * caller renders as ordinary text.
 */

import { TEAM_LIMITS } from './limits.js';
import type { TeamMessage } from './types.js';

/** The lead's stable address. Subagents are addressed by their `label`. */
export const LEAD_KEY = 'lead';
/** Broadcast address: every other participant, the lead included. */
export const ALL_KEY = 'all';

export type SendVerdict =
  | { ok: true; delivered: string[]; spent: number; remaining: number }
  | { ok: false; reason: 'unknown_recipient'; recipients: string[] }
  | { ok: false; reason: 'agent_quota'; used: number; max: number }
  | { ok: false; reason: 'dispatch_quota'; used: number; max: number }
  | { ok: false; reason: 'too_soon'; retryInSeconds: number };

interface Waiter {
  key: string;
  from?: string;
  /**
   * When this wait gives up, on THIS BUS'S CLOCK (P1-1).
   *
   * Stamped from `this.now()` rather than from `Date.now()` at the call site,
   * because `checkWaitable` derives the caller's deadline the same way and the
   * two are compared. Every existing `team-bus.test.ts` construction site passes
   * a fake clock; a caller-computed deadline would compare a real timestamp with
   * a fake one and make the mutual-wait rules untestable.
   */
  deadlineAt: number;
  settle: (message: TeamMessage | null) => void;
}

/** Why `team_wait` was refused before it ever blocked (F-3). */
export type WaitRefusal =
  | { reason: 'no_peers' }
  | { reason: 'unknown_sender'; asked: string; peers: string[] }
  | { reason: 'all_finished'; who: string[] }
  | { reason: 'all_blocked'; who: string[] };

export interface TeamBusOptions {
  /** Injectable clock so the interval rule is testable without real waiting. */
  now?: () => number;
  /** Called once per delivered message, for the `TeamEvent` stream and the log. */
  onMessage?: (message: TeamMessage) => void;
  /**
   * Whether `label` still has a loop that could call `team_send`.
   *
   * Optional and defaulting to `() => true`, so every existing construction site
   * and every existing test keeps its current behaviour exactly. `TeamRuntime`
   * supplies the real answer from its live handles, and it is a NEGATIVE
   * predicate over TERMINAL phases: a `queued` child has not started yet and
   * will, so "the phase is running" - the obvious implementation - would refuse
   * a wait on children 4 and 5 of a five-way dispatch at the shipped defaults.
   */
  canSend?: (label: string) => boolean;
}

export class TeamBus {
  private readonly labels: string[];
  private readonly mailboxes = new Map<string, TeamMessage[]>();
  private readonly waiters = new Set<Waiter>();
  private readonly sentBy = new Map<string, number>();
  private readonly lastSentAt = new Map<string, number>();
  private readonly blocked = new Map<string, number>();
  private readonly lead: TeamMessage[] = [];
  private readonly now: () => number;
  private readonly onMessage?: (message: TeamMessage) => void;
  private readonly canSend: (label: string) => boolean;
  private total = 0;
  private last?: TeamMessage;

  constructor(labels: string[], options: TeamBusOptions = {}) {
    this.labels = [...labels];
    this.now = options.now ?? (() => Date.now());
    if (options.onMessage) this.onMessage = options.onMessage;
    this.canSend = options.canSend ?? ((): boolean => true);
    for (const label of this.labels) this.mailboxes.set(label, []);
  }

  /** Every addressable participant, in dispatch order, with the lead last. */
  participants(): string[] {
    return [...this.labels, LEAD_KEY];
  }

  /** Sibling labels for the `<subagent_role>` block. */
  peersOf(label: string): string[] {
    return this.labels.filter((l) => l !== label);
  }

  /** Messages addressed to `lead`, for the report's own section (§3.7). */
  leadMail(): TeamMessage[] {
    return [...this.lead];
  }

  messageCount(): number {
    return this.total;
  }

  lastMessage(): TeamMessage | undefined {
    return this.last;
  }

  sentCount(label: string): number {
    return this.sentBy.get(label) ?? 0;
  }

  /**
   * Canonical label for a model-supplied `from`, or `undefined` (P1-3).
   *
   * PUBLIC, because `makeTeamWait` has to hand the SAME string to
   * `checkWaitable` and to `wait()`. `wait()` and `deliverToWaiter` compare
   * `m.from === opts.from` EXACTLY, so a caller that gate-checks `"A2"`
   * case-insensitively and then passes `"A2"` down would wait the full timeout
   * for a message the delivery filter can never match.
   */
  resolveLabel(raw: string): string | undefined {
    const t = raw.trim().toLowerCase();
    return this.labels.find((l) => l.toLowerCase() === t);
  }

  /** `team_wait` calls refused as unanswerable, per label (F-3). */
  recordBlockedWait(label: string): void {
    this.blocked.set(label, this.blockedWaitCount(label) + 1);
  }

  blockedWaitCount(label: string): number {
    return this.blocked.get(label) ?? 0;
  }

  // -------------------------------------------------------------------------
  // Send
  // -------------------------------------------------------------------------

  /**
   * Spend quota and deliver.
   *
   * Refusal ORDER is deliberate: the permanent conditions are reported before
   * the temporary one. Telling a child to "try again in 9s" when its quota is
   * already spent sends it back for a second refusal it cannot act on.
   */
  send(from: string, to: string, subjectRaw: string, bodyRaw: string): SendVerdict {
    const target = to.trim().toLowerCase();
    const cost = target === ALL_KEY ? TEAM_LIMITS.broadcastCost : 1;
    const recipients = this.resolveRecipients(from, target);
    if (recipients.length === 0) {
      return { ok: false, reason: 'unknown_recipient', recipients: this.participants() };
    }

    const used = this.sentCount(from);
    if (used + cost > TEAM_LIMITS.messagesPerAgent) {
      return { ok: false, reason: 'agent_quota', used, max: TEAM_LIMITS.messagesPerAgent };
    }
    if (this.total + cost > TEAM_LIMITS.messagesPerDispatch) {
      return {
        ok: false,
        reason: 'dispatch_quota',
        used: this.total,
        max: TEAM_LIMITS.messagesPerDispatch,
      };
    }

    const last = this.lastSentAt.get(from);
    const now = this.now();
    if (last !== undefined && now - last < TEAM_LIMITS.minSendIntervalMs) {
      return {
        ok: false,
        reason: 'too_soon',
        retryInSeconds: Math.max(1, Math.ceil((TEAM_LIMITS.minSendIntervalMs - (now - last)) / 1000)),
      };
    }

    // Clamped, never rejected: an over-long subject is a formatting slip, and
    // refusing the whole message for it would spend a turn to convey nothing.
    const subject = subjectRaw.trim().slice(0, TEAM_LIMITS.subjectChars);
    const body = bodyRaw.trim().slice(0, TEAM_LIMITS.bodyChars);

    this.sentBy.set(from, used + cost);
    this.lastSentAt.set(from, now);
    this.total += cost;

    for (const recipient of recipients) {
      const message: TeamMessage = { from, to: recipient, subject, body, at: now };
      this.last = message;
      this.onMessage?.(message);
      if (recipient === LEAD_KEY) {
        // The lead is blocked inside `task` for the whole dispatch (§1.3), so
        // its mail is COLLECTED rather than delivered: it reaches the model in
        // the report, and the panel shows it live. Injecting it into the lead's
        // history mid-tool is what §1.3 rules out.
        this.lead.push(message);
        continue;
      }
      if (!this.deliverToWaiter(recipient, message)) {
        this.mailboxes.get(recipient)?.push(message);
      }
    }

    return {
      ok: true,
      delivered: recipients,
      spent: cost,
      remaining: Math.max(0, TEAM_LIMITS.messagesPerAgent - (used + cost)),
    };
  }

  private resolveRecipients(from: string, target: string): string[] {
    if (target === ALL_KEY) return this.participants().filter((p) => p !== from);
    if (target === LEAD_KEY) return [LEAD_KEY];
    const match = this.labels.find((l) => l.toLowerCase() === target);
    if (!match || match === from) return [];
    return [match];
  }

  // -------------------------------------------------------------------------
  // Receive
  // -------------------------------------------------------------------------

  private waiterFor(label: string): Waiter | undefined {
    for (const w of this.waiters) if (w.key === label) return w;
    return undefined;
  }

  /**
   * Decide whether waiting could possibly pay off (F-3).
   *
   * TAKES `timeoutMs`, NOT `deadlineAt` (P1-1). The deadline is derived here,
   * from the one clock this class has, so it is comparable with every registered
   * `Waiter.deadlineAt`.
   *
   * PURE: no counters, no mutation, no waiter registration. `makeTeamWait`
   * records the refusal, because a predicate with a counter inside it is a
   * predicate people stop trusting (D-6).
   *
   * BIASED TOWARD PERMITTING (D-16). Every branch that cannot be decided returns
   * `null`. A wait that should have been refused costs the child seconds it can
   * see; a refusal that should have been a wait destroys a result the child
   * cannot see was ever possible. The asymmetry is total, so the bias is total.
   */
  checkWaitable(key: string, opts: { from?: string; timeoutMs: number }): WaitRefusal | null {
    const peers = this.peersOf(key);
    if (peers.length === 0) return { reason: 'no_peers' };

    let acceptable = peers;
    let want: string | undefined;
    if (opts.from !== undefined) {
      const canonical = this.resolveLabel(opts.from);
      // Covers a typo, `lead` (which never sends - its mail is collected for the
      // report and there is no `team_send` on a lead), and the caller's own
      // label. All three are "this wait can never be satisfied", and none of
      // them is "you have no teammates" (P1-2).
      if (canonical === undefined || canonical === key) {
        return { reason: 'unknown_sender', asked: opts.from.trim(), peers };
      }
      acceptable = [canonical];
      want = canonical;
    }

    // Something is already in the mailbox: `wait()` will return it synchronously,
    // so this is never a pointless wait however dead the peers are. Matched with
    // the SAME canonical label `wait()` will use (P1-3).
    const queued = this.mailboxes.get(key) ?? [];
    if (queued.some((m) => want === undefined || m.from === want)) return null;

    const deadlineAt = this.now() + Math.max(0, opts.timeoutMs);
    const finished = (p: string): boolean => !this.canSend(p);
    const blockedPast = (p: string): boolean => {
      const w = this.waiterFor(p);
      return w !== undefined && w.deadlineAt >= deadlineAt;
    };

    const stuck: string[] = [];
    for (const peer of acceptable) {
      if (finished(peer) || blockedPast(peer)) {
        stuck.push(peer);
        continue;
      }
      return null; // this one could still send in time
    }

    const cannotAct = new Set<string>([key, ...peers.filter(finished), ...stuck]);
    this.closeCannotAct(cannotAct, key, finished);
    if (acceptable.some((p) => !cannotAct.has(p))) return null;

    const dead = acceptable.filter(finished);
    if (dead.length === acceptable.length) return { reason: 'all_finished', who: dead };
    return { reason: 'all_blocked', who: acceptable };
  }

  /**
   * Shrink `cannotAct` to its fixpoint, in place (P0-3).
   *
   * Everyone acceptable being stuck is NOT yet a deadlock proof, because a
   * blocked peer can be released EARLY by a third party: `a` waits on `b`, `b`
   * waits on `c`, `c` messages `b` at t=10, `b` resumes and messages `a`. A
   * deadline comparison alone refuses `a` at t=0 and throws that outcome away.
   *
   * So a blocked peer stays in the set only while everyone who could wake it is
   * also in it (or is the caller, who is about to block). If growth stops with
   * an acceptable peer outside the set, that peer can still be woken and the
   * wait must be permitted.
   *
   * Terminates because each pass either removes at least one member or stops. At
   * ten participants the worst case is a hundred set lookups, once per
   * `team_wait`, and `team_wait` is itself rate-limited by the message budget.
   */
  private closeCannotAct(
    cannotAct: Set<string>,
    key: string,
    finished: (p: string) => boolean,
  ): void {
    for (;;) {
      let shrank = false;
      for (const p of [...cannotAct]) {
        if (p === key || finished(p)) continue;
        const w = this.waiterFor(p);
        // Not blocked at all -> free to send whenever it likes.
        if (w === undefined) {
          cannotAct.delete(p);
          shrank = true;
          continue;
        }
        // Who could release `p`? Its own acceptable senders - and `peersOf`, NOT
        // `participants`, because the lead is never a sender. Using
        // `participants` here would put `lead` in every from-less waiter's waker
        // set, `lead` is never in `cannotAct`, and `all_blocked` would become
        // unreachable for exactly the from-less waits it was written for.
        const wakers = w.from ? [w.from] : this.peersOf(p);
        if (wakers.some((x) => x !== p && !cannotAct.has(x))) {
          cannotAct.delete(p);
          shrank = true;
        }
      }
      if (!shrank) return;
    }
  }

  /** Take everything queued for `key`. Called by `withMailboxTail` (§3.6). */
  drain(key: string): TeamMessage[] {
    const box = this.mailboxes.get(key);
    if (!box || box.length === 0) return [];
    return box.splice(0, box.length);
  }

  /**
   * Block until a matching message arrives, the signal aborts, or the deadline
   * elapses. Resolves `null` on both non-delivery paths — from the model's point
   * of view an abandoned wait and an expired one want the same guidance.
   *
   * THE CALLER PAUSES THE CHILD'S IDLE WATCHDOG around this (see
   * `comm-tools.ts`). A deliberate wait is not a wedged agent, and the child
   * emits nothing while it is here.
   */
  wait(
    key: string,
    opts: { from?: string; timeoutMs: number; signal?: AbortSignal },
  ): Promise<TeamMessage | null> {
    const queued = this.mailboxes.get(key) ?? [];
    const index = queued.findIndex((m) => !opts.from || m.from === opts.from);
    if (index >= 0) return Promise.resolve(queued.splice(index, 1)[0] ?? null);

    return new Promise<TeamMessage | null>((resolve) => {
      let done = false;
      const waiter: Waiter = {
        key,
        ...(opts.from ? { from: opts.from } : {}),
        // On THIS bus's clock, so `checkWaitable` can compare deadlines (P1-1).
        deadlineAt: this.now() + Math.max(0, opts.timeoutMs),
        settle: (message) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          opts.signal?.removeEventListener('abort', onAbort);
          this.waiters.delete(waiter);
          resolve(message);
        },
      };
      const onAbort = (): void => waiter.settle(null);
      const timer = setTimeout(() => waiter.settle(null), Math.max(0, opts.timeoutMs));
      // `unref` keeps a pending wait from holding the process open on exit; it
      // does not exist on the browser timer type, hence the guard.
      (timer as unknown as { unref?: () => void }).unref?.();
      this.waiters.add(waiter);
      if (opts.signal?.aborted) {
        waiter.settle(null);
        return;
      }
      opts.signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Settle every outstanding wait with `null`. Called on abort and dispose. */
  cancelAllWaits(): void {
    for (const waiter of [...this.waiters]) waiter.settle(null);
  }

  private deliverToWaiter(key: string, message: TeamMessage): boolean {
    for (const waiter of this.waiters) {
      if (waiter.key !== key) continue;
      if (waiter.from && waiter.from !== message.from) continue;
      waiter.settle(message);
      return true;
    }
    return false;
  }
}

/** Render queued mail as the `<team_mail>` block appended to a tool result. */
export function renderMailBlock(messages: TeamMessage[]): string {
  const lines = ['<team_mail>'];
  for (const m of messages) {
    lines.push(`from ${m.from}: ${m.subject}`);
    if (m.body.length > 0) lines.push(m.body);
  }
  lines.push('</team_mail>');
  return lines.join('\n');
}
