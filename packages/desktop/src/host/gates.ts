/**
 * The four "a human must answer" channels, implemented over the data plane.
 *
 * Tool confirmation, skill-install approval, the ask-user wizard and plan review all end here
 * as a `req` sent to the window and a `res` coming back. THEY ALL FAIL CLOSED:
 *   - no window attached for 30 s  -> the answer is "no" (the terminal's `canPrompt() === false`);
 *   - the tool's own abort signal fires -> the request is withdrawn and answers "no";
 *   - a renderer answer that does not fit the request is "no" too, not a guess.
 * A request that is pending when the window reloads is NOT lost: `replayPending()` sends it
 * again to the new port, so a Ctrl+R during an approval cannot silently deny it.
 *
 * The renderer is untrusted. Every answer is re-validated here against the request the HOST
 * issued: question text comes from the host's own copy (never the reply), unknown question ids
 * are dropped, and free text and denial reasons are length-capped.
 */

import { randomUUID } from 'node:crypto';
import type { Answer, HumanRequest, HumanResponse } from '@aragon-agent/tui/model/tools/human-input';
import {
  ANSWER_LIMITS,
  UNATTENDED_REQUEST_TIMEOUT_MS,
  type HostRequest,
  type HostResponse,
} from '../shared/port-protocol.js';

export interface ConfirmInput {
  tool: string;
  summary: string;
  signal?: AbortSignal;
}

interface Pending {
  id: string;
  req: HostRequest;
  settle(response: HostResponse | null): void;
  unattendedTimer: ReturnType<typeof setTimeout> | null;
}

export interface GatesOptions {
  /** Send a request to the attached window; returns false when no window can receive it. */
  send(id: string, req: HostRequest): boolean;
  /** Called when the set of pending requests changes (drives the "waiting approval" status). */
  onPendingChange(count: number): void;
  /** Audit trail: one notice per fail-closed denial, so the transcript says why. */
  onDenied(reason: string): void;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

export class Gates {
  private readonly pending = new Map<string, Pending>();
  private readonly sessionAllowed = new Set<string>();
  private attached = false;

  constructor(private readonly options: GatesOptions) {}

  /** Whether a window is currently able to answer. */
  setAttached(attached: boolean): void {
    this.attached = attached;
    if (attached) {
      for (const entry of this.pending.values()) this.cancelUnattendedTimer(entry);
    } else {
      for (const entry of this.pending.values()) this.armUnattendedTimer(entry);
    }
  }

  get isAttached(): boolean {
    return this.attached;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /** Re-send every unanswered request (after a reload attached a fresh port). */
  replayPending(): void {
    for (const entry of this.pending.values()) this.options.send(entry.id, entry.req);
  }

  // -------------------------------------------------------------------------
  // The four channels
  // -------------------------------------------------------------------------

  /** `confirmBridge.handler`: resolves `true` only on an explicit allow. */
  confirmTool(input: ConfirmInput): Promise<boolean> {
    if (this.sessionAllowed.has(input.tool)) return Promise.resolve(true);
    const req: HostRequest = {
      k: 'tool-approval', tool: input.tool, summary: input.summary, sessionAllowKey: input.tool,
    };
    return this.ask(req, input.signal).then((response) => {
      if (response?.k !== 'tool-approval' || response.decision === 'deny') {
        return false;
      }
      if (response.decision === 'allow-session') this.sessionAllowed.add(input.tool);
      return true;
    });
  }

  /** The reason a denied tool call should be reported with, when the user typed one. */
  lastDenyReason: string | null = null;

  /** `approval.request` for skill installation: `false` unless approved. */
  confirmSkillInstall(input: { source: string; targetPath: string; summary: string; signal?: AbortSignal }): Promise<boolean> {
    return this.ask({ k: 'skill-install', source: input.source, targetPath: input.targetPath, summary: input.summary }, input.signal)
      .then((response) => response?.k === 'skill-install' && response.approved === true);
  }

  /** `humanInputBridge.handler`: questions and plan review. `null` means cancelled. */
  humanInput(req: HumanRequest, signal?: AbortSignal): Promise<HumanResponse | null> {
    if (req.kind === 'questions') {
      return this.ask({ k: 'ask-user', questions: req.questions }, signal).then((response) => {
        if (response?.k !== 'ask-user') return null;
        return this.shapeAnswers(req, response);
      });
    }
    return this.ask({ k: 'plan-review', plan: req.plan }, signal).then((response) => {
      if (response?.k !== 'plan-review') return null;
      const decision = response.decision;
      if (decision !== 'approved' && decision !== 'revise' && decision !== 'dismissed') return null;
      return { kind: 'planDecision', decision, feedback: response.feedback.slice(0, ANSWER_LIMITS.planFeedback) };
    });
  }

  /** Whether any window could ever answer (the terminal's live `canPrompt()` probe). */
  canPrompt(): boolean {
    return true;
  }

  /** Resolve everything with "no": the run ended or the session is closing. */
  cancelAll(reason: string): void {
    for (const entry of [...this.pending.values()]) {
      this.options.onDenied(reason);
      entry.settle(null);
    }
  }

  /** Feed a renderer's answer to the request it belongs to. */
  answer(id: string, response: HostResponse): void {
    const entry = this.pending.get(id);
    if (!entry) return; // already settled (timeout, abort, reload) - a late answer is ignored
    if (response.k !== entry.req.k) {
      entry.settle(null);
      return;
    }
    if (response.k === 'tool-approval') {
      this.lastDenyReason = response.decision === 'deny' && response.reason
        ? response.reason.slice(0, ANSWER_LIMITS.denyReason) : null;
    }
    entry.settle(response);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private ask(req: HostRequest, signal?: AbortSignal): Promise<HostResponse | null> {
    return new Promise((resolve) => {
      if (signal?.aborted) {
        resolve(null);
        return;
      }
      const id = randomUUID();
      const entry: Pending = {
        id, req, unattendedTimer: null,
        settle: (response) => {
          if (!this.pending.has(id)) return;
          this.pending.delete(id);
          this.cancelUnattendedTimer(entry);
          signal?.removeEventListener('abort', onAbort);
          this.options.onPendingChange(this.pending.size);
          resolve(response);
        },
      };
      const onAbort = (): void => entry.settle(null);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, entry);
      this.options.onPendingChange(this.pending.size);
      if (this.attached) this.options.send(id, req);
      else this.armUnattendedTimer(entry);
    });
  }

  private armUnattendedTimer(entry: Pending): void {
    if (entry.unattendedTimer) return;
    entry.unattendedTimer = (this.options.setTimer ?? setTimeout)(() => {
      entry.unattendedTimer = null;
      if (this.attached) return;
      this.options.onDenied('No window was attached to answer a request for 30 s; it was refused.');
      entry.settle(null);
    }, UNATTENDED_REQUEST_TIMEOUT_MS);
    (entry.unattendedTimer as { unref?: () => void }).unref?.();
  }

  private cancelUnattendedTimer(entry: Pending): void {
    if (entry.unattendedTimer) (this.options.clearTimer ?? clearTimeout)(entry.unattendedTimer);
    entry.unattendedTimer = null;
  }

  /** Rebuild `Answer[]` from the host's OWN questions; the reply contributes only choices. */
  private shapeAnswers(
    req: Extract<HumanRequest, { kind: 'questions' }>,
    response: Extract<HostResponse, { k: 'ask-user' }>,
  ): HumanResponse {
    if (response.cancelled) return { kind: 'answers', answers: [], cancelled: true };
    const answers: Answer[] = [];
    for (const question of req.questions) {
      const given = response.answers.find((candidate) => candidate.id === question.id);
      if (!given) continue; // an unanswered question stays unanswered; never invent one
      const labels = new Set(question.options.map((option) => option.label));
      const other = question.options.find((option) => option.isOther)?.label;
      let selected = given.selected.filter((label) => labels.has(label));
      if (!question.allowMultiple) selected = selected.slice(0, 1);
      const custom = other !== undefined && selected.includes(other)
        ? (given.custom ?? '').slice(0, ANSWER_LIMITS.freeText) : null;
      if (selected.length === 0) continue;
      answers.push({ id: question.id, question: question.question, selected, custom });
    }
    return { kind: 'answers', answers, cancelled: false };
  }
}
