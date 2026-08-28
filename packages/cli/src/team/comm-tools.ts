/**
 * `team_send` / `team_wait` and the `withMailboxTail` wrapper — the subagent
 * half of the team bus (team-subagents §3.6 / §4.2).
 *
 * ASCII ONLY: `src/team/**` is inside the glyph scanner's scope.
 *
 * REGISTERED ON CHILDREN ONLY. Neither tool ever reaches a lead, which is why
 * neither is in `HOST_TOOL_NAMES` (P2-5) and why both are in
 * `TEAM_SUBAGENT_TOOL_NAMES` — the `policyExempt` set that keeps the lead's
 * `allowed-tools` ceiling from refusing tools it has never heard of and
 * dead-ending the channel (§3.11).
 *
 * EVERY RESULT IS A NON-ERROR `textResult`, refusals included (D-7). An
 * `errorResult` reads as a malfunction and invites an immediate retry, which is
 * exactly the behaviour the rate limits exist to prevent.
 */

import { textResult, type AgentTool, type ToolResult } from '@aragon-agent/core';
import { TEAM_LIMITS } from './limits.js';
import { renderMailBlock, TeamBus, type WaitRefusal } from './bus.js';
import type { WatchdogPausable } from './human-queue.js';

const SEND_DESCRIPTION =
  'Message a teammate. Use it only when it changes what they should do - a finding they ' +
  'would otherwise duplicate, or a file you are about to change. You get ' +
  `${TEAM_LIMITS.messagesPerAgent} messages for this whole task and at most one every ` +
  `${Math.round(TEAM_LIMITS.minSendIntervalMs / 1000)} seconds; spending them on status updates means you cannot send ` +
  'the one that matters. Incoming messages are appended to your next tool result ' +
  'automatically; you do not need to poll.';

const WAIT_DESCRIPTION =
  'Block until a teammate messages you. Use this only when you genuinely cannot continue ' +
  'without an answer - it spends wall-clock time and your teammate may never reply. ' +
  'Messages you are simply expecting arrive on your next tool result without waiting.';

/**
 * `team_send`.
 *
 * The bus owns quota, interval and delivery; this tool owns only the wording,
 * because the wording is what the model acts on and it must name the limit that
 * was hit and what to do instead.
 */
export function makeTeamSend(bus: TeamBus, selfKey: string): AgentTool {
  return {
    name: 'team_send',
    label: 'Message teammate',
    description: SEND_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'A peer label, "lead", or "all".' },
        subject: { type: 'string', description: `<= ${TEAM_LIMITS.subjectChars} chars.` },
        body: { type: 'string', description: `<= ${TEAM_LIMITS.bodyChars} chars.` },
      },
      required: ['to', 'subject', 'body'],
    },
    async execute(_id, params): Promise<ToolResult> {
      const p = params as { to?: unknown; subject?: unknown; body?: unknown };
      const to = typeof p.to === 'string' ? p.to : '';
      const subject = typeof p.subject === 'string' ? p.subject : '';
      const body = typeof p.body === 'string' ? p.body : '';
      if (to.trim().length === 0 || subject.trim().length === 0) {
        return textResult('Not sent: team_send needs a "to" and a "subject".');
      }

      const verdict = bus.send(selfKey, to, subject, body);
      if (verdict.ok) {
        return textResult(
          `Delivered to ${verdict.delivered.join(', ')}. ${verdict.remaining} of ` +
            `${TEAM_LIMITS.messagesPerAgent} messages left.`,
        );
      }
      switch (verdict.reason) {
        case 'unknown_recipient':
          return textResult(
            `Not sent: no subagent labelled "${to.trim()}". Teammates: ` +
              `${verdict.recipients.filter((r) => r !== selfKey).join(', ')}.`,
          );
        case 'agent_quota':
          return textResult(
            `Not sent: message quota spent (${verdict.used}/${verdict.max}). Finish your work ` +
              'and put it in your final summary.',
          );
        case 'dispatch_quota':
          return textResult(
            `Not sent: the team has spent its message budget (${verdict.used}/${verdict.max}). ` +
              'Continue on your own and report what you found.',
          );
        case 'too_soon':
          return textResult(
            `Not sent: one message every ${Math.round(TEAM_LIMITS.minSendIntervalMs / 1000)}s. Try again in ` +
              `${verdict.retryInSeconds}s, or continue and report instead.`,
          );
      }
    },
  };
}

export interface TeamWaitDeps {
  /**
   * The child's own `Agent`, read LAZILY.
   *
   * The tool array has to exist before `new Agent(...)` can be constructed, so
   * there is a window in which this returns `null`. Resolving it eagerly would
   * capture that `null` for the life of the child and silently drop the
   * watchdog pause — the failure would only show up as a mysterious
   * `idle watchdog fired` during a legitimate wait.
   */
  getAgent: () => WatchdogPausable | null;
  /** Ceiling on any single wait: never longer than the child's own budget. */
  maxWaitMs: number;
}

/**
 * Label lists for a refusal sentence: joined with `and`, capped at three names.
 *
 * A 10-way dispatch must not produce a 200-character refusal - the child has to
 * read it, and the point of the sentence is what to do next, not a roll call.
 */
function nameList(names: string[]): string {
  if (names.length === 0) return 'nobody';
  if (names.length === 1) return names[0]!;
  if (names.length <= 3) return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${names.slice(0, 3).join(', ')} and ${names.length - 3} others`;
}

/**
 * What the child is told instead of blocking (F-3).
 *
 * Following the refusal style `makeTeamSend` already uses: name the reason and
 * say what to do instead, never as an `errorResult` (D-7 / D-11).
 *
 * `unknown_sender` is its own reason rather than folded into `no_peers` (P1-2)
 * because it is the only one of the four the child can act on IN THIS TURN. The
 * other three say "give up on the message"; this one says "you asked for a name
 * nobody has, here are the names" - and telling a child in a five-way fan-out
 * that it is "the only subagent in this dispatch" is simply false.
 */
function refusalText(refusal: WaitRefusal): string {
  switch (refusal.reason) {
    case 'no_peers':
      return (
        'Nobody to wait for: you are the only subagent in this dispatch. Continue and put ' +
        'what you found in your final summary.'
      );
    case 'unknown_sender':
      return (
        `Nobody here is called "${refusal.asked}". Teammates: ${nameList(refusal.peers)}. ` +
        '(The lead never sends messages.) Continue, or wait again naming one of those.'
      );
    case 'all_finished':
      return (
        `Nobody can answer: ${nameList(refusal.who)} already finished. Continue without it ` +
        'and say so in your summary.'
      );
    case 'all_blocked':
      return (
        `Deadlock avoided: ${nameList(refusal.who)} is waiting for a message too, and cannot ` +
        'be released before your own deadline. Continue with what you have and report it.'
      );
  }
}

/**
 * `team_wait`.
 *
 * Runs with THAT CHILD'S idle watchdog paused, in a `try/finally` — the same
 * treatment `withHumanWait` gives an overlay and for the same reason: a
 * deliberate wait is not a wedged tool, and the child emits nothing while it is
 * blocked here (I-3, one level down).
 */
export function makeTeamWait(bus: TeamBus, selfKey: string, deps: TeamWaitDeps): AgentTool {
  return {
    name: 'team_wait',
    label: 'Wait for teammate',
    description: WAIT_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        from: {
          type: 'string',
          description: 'Only accept a message from this label. Omit for any.',
        },
        timeoutSeconds: {
          type: 'number',
          default: TEAM_LIMITS.waitDefaultSeconds,
          description: `${TEAM_LIMITS.waitMinSeconds}-${TEAM_LIMITS.waitMaxSeconds}.`,
        },
      },
    },
    async execute(_id, params, ctx): Promise<ToolResult> {
      const p = params as { from?: unknown; timeoutSeconds?: unknown };
      const from = typeof p.from === 'string' && p.from.trim().length > 0 ? p.from.trim() : undefined;
      const requested =
        typeof p.timeoutSeconds === 'number' && Number.isFinite(p.timeoutSeconds)
          ? p.timeoutSeconds
          : TEAM_LIMITS.waitDefaultSeconds;
      const seconds = Math.min(
        TEAM_LIMITS.waitMaxSeconds,
        Math.max(TEAM_LIMITS.waitMinSeconds, Math.round(requested)),
      );
      const timeoutMs = Math.min(seconds * 1000, deps.maxWaitMs);

      // `timeoutMs`, not a deadline: the bus owns the clock (P1-1). Checked
      // BEFORE the watchdog pause on purpose - the refusal path returns
      // synchronously, and a pause/resume pair around a synchronous return is a
      // needless state transition on the one object whose state is hardest to
      // reason about.
      const refusal = bus.checkWaitable(selfKey, {
        ...(from ? { from } : {}),
        timeoutMs,
      });
      if (refusal) {
        bus.recordBlockedWait(selfKey);
        return textResult(refusalText(refusal));
      }
      // Past the gate, `from` is known to name a real peer, so hand `wait()` the
      // CANONICAL label rather than what the model typed (P1-3). `wait()` and
      // `deliverToWaiter` compare exactly; this is the one line that makes them
      // agree with the gate that just permitted the call.
      const fromLabel = from ? bus.resolveLabel(from) : undefined;

      const agent = deps.getAgent();
      agent?.pauseIdleWatchdog();
      let message;
      try {
        message = await bus.wait(selfKey, {
          ...(fromLabel ? { from: fromLabel } : {}),
          timeoutMs,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
      } finally {
        agent?.resumeIdleWatchdog();
      }

      if (!message) {
        return textResult(
          `No message arrived within ${Math.round(timeoutMs / 1000)}s. Continue without it.`,
        );
      }
      return textResult(renderMailBlock([message]));
    },
  };
}

/**
 * Append anything queued for `key` to the tool's result, inside a `<team_mail>`
 * block.
 *
 * Same `{...tool, execute}` shape as `withConfirmation` / `withToolPolicy` /
 * `withPlanModeGate`, so nothing in the engine needs to know this happened. The
 * mailbox is drained EVEN WHEN the wrapped tool errored: a refused `bash` call
 * is still a delivery opportunity, and holding mail back until a successful call
 * would make delivery depend on whether the child happened to be doing well.
 */
export function withMailboxTail(tool: AgentTool, bus: TeamBus, key: string): AgentTool {
  const original = tool.execute;
  return {
    ...tool,
    async execute(id, params, ctx): Promise<ToolResult> {
      const result = await original(id, params, ctx);
      const mail = bus.drain(key);
      if (mail.length === 0) return result;
      return {
        ...result,
        content: [...result.content, { type: 'text', text: renderMailBlock(mail) }],
      };
    },
  };
}
