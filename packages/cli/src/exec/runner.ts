/**
 * Stream translation, budgets and interrupts for `aragon exec`
 * (cli-integration-surface section 3.3 / 3.5 / 3.6).
 *
 * ASCII ONLY - `src/exec/**` is inside the glyph scanner's scope.
 *
 * IT NEVER TOUCHES STDOUT. Everything it wants to say goes through the
 * `ExecEmitter` it was handed, which is the only object in this feature that
 * holds a stdout stream (R-2). The one exception is `stderr`, used for the
 * caller-facing notices `-p` already writes there.
 *
 * IT DOES NOT EMIT `result` EITHER, and that is deliberate (D-2). `run()`
 * RETURNS the parameters; `exec/index.ts` persists the session first and emits
 * second, because a caller that reads `result` and immediately respawns with the
 * same `--session-id` must not race the writer of the file it is about to read.
 */

import type {
  AgentEvent,
  AssistantMessage,
  StreamEvent,
  TokenUsage,
  ToolResult,
} from '@aragon-agent/core';
import { formatStreamError } from '../agent/reducer.js';
import type { HeadlessController } from '../agent/headless.js';
import type { TeamEvent } from '../team/types.js';
import { setSignalTerminator } from '../logging/install.js';
import {
  advanceBudget,
  decideFollowThrough,
  emptyBudget,
  type FollowThroughMode,
} from '../todo/follow-through.js';
import type { ExecEmitter } from './emitter.js';
import type { ExecEvent, ExecStopReason } from './events.js';

/**
 * The controller surface the runner needs.
 *
 * IT EXTENDS `HeadlessController` RATHER THAN NAMING `AgentController`, for the
 * reason that interface records about itself: it is deliberately minimal so a
 * test can satisfy it with an OBJECT LITERAL. `abort` is required here and not
 * there because a budget with no way to stop the run is not a budget.
 */
export interface ExecRunnerController extends HeadlessController {
  abort(): void;
  /** `cost.known` (P2-3). Optional so a stub need not model pricing. */
  isPricedModel?(ref: { providerId: string; modelId: string }): boolean;
}

/** Where the caller's messages come from. One turn, or an NDJSON stdin stream. */
export interface ExecPromptSource {
  /** The next caller message, or `null` when the caller is done. */
  next(): Promise<string | null>;
}

export function singlePrompt(text: string): ExecPromptSource {
  let served = false;
  return {
    next: async (): Promise<string | null> => {
      if (served) return null;
      served = true;
      return text;
    },
  };
}

/** Replaceable so a unit test can assert the mechanism, not just the outcome. */
export interface ExecSignalPort {
  setTerminator(fn: (signo: number) => void): void;
  exit(code: number): void;
}

const DEFAULT_SIGNAL_PORT: ExecSignalPort = {
  setTerminator: setSignalTerminator,
  exit: (code: number) => process.exit(code),
};

/** A second signal inside this window stops waiting for a graceful settle. */
const SECOND_SIGNAL_WINDOW_MS = 2000;

export interface ExecRunnerOptions {
  emitter: ExecEmitter;
  sessionId: string;
  maxTurns?: number;
  maxDurationMs?: number;
  partialMessages?: boolean;
  includeThinking?: boolean;
  followThrough?: FollowThroughMode;
  quiet?: boolean;
  stderr?: NodeJS.WritableStream;
  now?: () => number;
  signals?: ExecSignalPort;
  /** Turns already spent by earlier invocations of a resumed session. */
  priorTurns?: number;
}

export interface ExecRunStats {
  turns: number;
  usage: TokenUsage;
  lastAssistantText: string;
  errored: boolean;
  stopReason: ExecStopReason;
  errorCode: string | null;
  errorMessage: string | null;
  signalNumber: number | null;
}

export class ExecRunner {
  private readonly emitter: ExecEmitter;
  private readonly sessionId: string;
  private readonly opts: ExecRunnerOptions;
  private readonly signals: ExecSignalPort;
  private readonly now: () => number;

  private controller: ExecRunnerController | null = null;
  private unsubscribers: (() => void)[] = [];

  private turns = 0;
  private readonly usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  private lastAssistantText = '';
  private errored = false;
  private sawTurnEnd = false;
  private stopReason: ExecStopReason = 'end_turn';
  private errorCode: string | null = null;
  private errorMessage: string | null = null;
  private signalNumber: number | null = null;

  private thinkingBuffer = '';
  private budgetTimer: NodeJS.Timeout | null = null;
  private timerStarted = false;
  private detached = false;
  private lastSignalAt = 0;

  constructor(options: ExecRunnerOptions) {
    this.emitter = options.emitter;
    this.sessionId = options.sessionId;
    this.opts = options;
    this.signals = options.signals ?? DEFAULT_SIGNAL_PORT;
    this.now = options.now ?? Date.now;
  }

  // -----------------------------------------------------------------------
  // Attach / detach
  // -----------------------------------------------------------------------

  /**
   * Subscribe to all four streams.
   *
   * TEXT MODE CALLS THIS TOO, WITH A `TextEmitter` THAT WRITES NOTHING (section
   * 3.2). The listener is what counts `turn_end` and accumulates usage for
   * `SessionMeta`; byte-equality with `runHeadless` is a property of what is
   * WRITTEN, not of how many listeners exist, and `runHeadless` already tolerates
   * multiple subscribers.
   */
  attach(controller: ExecRunnerController): void {
    this.controller = controller;
    this.unsubscribers.push(controller.subscribe((event) => this.onAgentEvent(event)));
    const team = controller.subscribeTeam?.((event) => {
      if (event.type === 'usage') {
        this.usage.inputTokens += event.usage.inputTokens;
        this.usage.outputTokens += event.usage.outputTokens;
        return;
      }
      this.emitTeam(event);
    });
    if (team) this.unsubscribers.push(team);
    const todos = controller.subscribeTodos?.((event) => {
      if (event.type !== 'updated') return;
      const { total, doneCount, activeIndex, items } = event.snapshot;
      this.emit({
        type: 'todo',
        sessionId: this.sessionId,
        total,
        done: doneCount,
        activeIndex,
        items: items.map((item) => ({ content: item.content, status: item.status })),
      });
    });
    if (todos) this.unsubscribers.push(todos);
    const fast = controller.subscribeFast?.((event) => {
      if (event.type === 'usage') {
        this.usage.inputTokens += event.usage.inputTokens;
        this.usage.outputTokens += event.usage.outputTokens;
        return;
      }
      if (event.type !== 'review_end' || !event.review.text) return;
      this.emit({
        type: 'fast_review',
        sessionId: this.sessionId,
        turn: event.review.turn,
        model: event.review.model,
        text: event.review.text,
      });
    });
    if (fast) this.unsubscribers.push(fast);
    // Context compaction (context-auto-compaction §4.6). Usage is folded into the
    // run's totals for the reason the team and fast branches above give: a
    // summarization is real spend, and `result.usage` is the only cost readout a
    // wrapper gets.
    const compaction = controller.subscribeCompaction?.((event) => {
      if (event.type === 'usage') {
        this.usage.inputTokens += event.usage.inputTokens;
        this.usage.outputTokens += event.usage.outputTokens;
        return;
      }
      if (event.type === 'compaction_start') {
        this.emit({
          type: 'compaction',
          sessionId: this.sessionId,
          turn: this.turns,
          subtype: 'start',
          trigger: event.trigger,
        });
        return;
      }
      if (event.type !== 'compaction_end') return;
      const r = event.record;
      this.emit({
        type: 'compaction',
        sessionId: this.sessionId,
        turn: this.turns,
        subtype: 'end',
        trigger: r.trigger,
        applied: r.applied,
        mode: r.mode,
        ...(r.reason !== undefined ? { reason: r.reason } : {}),
        messagesBefore: r.messagesBefore,
        messagesAfter: r.messagesAfter,
        tokensBefore: r.tokensBefore,
        tokensAfter: r.tokensAfter,
        ...(r.tailRelief ? { tailRelief: r.tailRelief } : {}),
        durationMs: r.durationMs,
      });
    });
    if (compaction) this.unsubscribers.push(compaction);
    this.installTerminator();
  }

  /**
   * Drop the subscriptions and the timer.
   *
   * IDEMPOTENT, and it clears the wall-clock timer even though that timer is
   * `unref`d: `unref` only stops it holding the event loop open, it does not stop
   * it firing and calling `abort()` on a controller the caller has since
   * disposed (R-10).
   */
  detach(): void {
    if (this.detached) return;
    this.detached = true;
    for (const off of this.unsubscribers.splice(0)) {
      try {
        off();
      } catch {
        // A subscription that was already torn down is not a reason to leave the
        // rest attached.
      }
    }
    if (this.budgetTimer) {
      clearTimeout(this.budgetTimer);
      this.budgetTimer = null;
    }
  }

  stats(): ExecRunStats {
    return {
      turns: this.turns,
      usage: { ...this.usage },
      lastAssistantText: this.lastAssistantText,
      errored: this.errored,
      stopReason: this.stopReason,
      errorCode: this.errorCode,
      errorMessage: this.errorMessage,
      signalNumber: this.signalNumber,
    };
  }

  /**
   * `0` success | `1` agent error | `3` budget | `128 + signo` for a signal.
   *
   * `3` IS ITS OWN CODE RATHER THAN `0` OR `1` (D-6). Both alternatives lose
   * information a shell script needs and cannot recover without parsing JSON:
   * `0` claims a complete answer that does not exist, `1` claims a malfunction
   * that did not happen.
   */
  exitCode(): number {
    if (this.stopReason === 'interrupted') return 128 + (this.signalNumber ?? 2);
    if (this.stopReason === 'max_turns' || this.stopReason === 'timeout') return 3;
    return this.errored ? 1 : 0;
  }

  // -----------------------------------------------------------------------
  // The run loop
  // -----------------------------------------------------------------------

  /**
   * Drive the conversation until the source is exhausted or a budget fires.
   *
   * The inner loop is the todo follow-through continuation of `runHeadless`,
   * with the IDENTICAL policy - both call `decideFollowThrough`, which is why
   * the two faces cannot drift about what "unfinished" means.
   */
  async run(source: ExecPromptSource): Promise<void> {
    const controller = this.controller;
    if (!controller) throw new Error('ExecRunner.run() before attach()');
    const followThrough = this.opts.followThrough ?? 'notify';

    for (;;) {
      const next = await source.next();
      // THE SOURCE IS POLLED BEFORE THE EXHAUSTION CHECK, SO A RUN THAT ENDS ON
      // ITS OWN TERMS IS NEVER MISREPORTED (IF-3). `next === null` first is what makes
      // that true: a conversation of exactly `--max-turns` turns whose caller has
      // nothing more to say exits 0 with `end_turn`, not 3 with `max_turns`.
      if (next === null) break;
      if (this.turnBudgetExhausted()) {
        this.stopReason = 'max_turns';
        break;
      }
      const finished = await this.runFollowThroughChain(controller, next, followThrough);
      if (finished) break;
    }
  }

  /** One caller message plus every auto-continuation it produces. */
  private async runFollowThroughChain(
    controller: ExecRunnerController,
    initial: string,
    followThrough: FollowThroughMode,
  ): Promise<boolean> {
    let budget = emptyBudget();
    let wasAutoContinuation = false;
    let message = initial;
    let source: 'caller' | 'todo_continue' = 'caller';

    for (;;) {
      // PER-ITERATION RESET, exactly as `runHeadless` does it: `sawTurnEnd` is
      // the silent-failure detector, and left sticky a swallowed throw on
      // iteration 2 is invisible because iteration 1 set the flag.
      this.sawTurnEnd = false;
      this.emit({
        type: 'user',
        sessionId: this.sessionId,
        turn: this.turns + 1,
        text: message,
        source,
      });
      this.startBudgetTimer();
      await controller.prompt(message);
      if (this.stopReason !== 'end_turn') return true;

      const snapshot = controller.getTodoSnapshot?.() ?? null;
      budget = advanceBudget(budget, snapshot, wasAutoContinuation);
      wasAutoContinuation = false;
      const decision = decideFollowThrough({
        mode: followThrough,
        snapshot,
        // `aborted` is false here for the same structural reason `-p` gives: an
        // interrupt sets `stopReason` and returns above, so this branch is only
        // reached by a run that ended on its own terms.
        runEnd: { aborted: false, errored: this.errored },
        budget,
        interactive: false,
      });

      if (decision.kind === 'none') return false;
      if (decision.kind === 'notify') {
        this.note(`[todo] ${decision.text}`);
        return false;
      }
      // A CLI-generated continuation is still a turn the caller is paying for,
      // so the ceiling binds here exactly as it does on a caller message.
      if (this.turnBudgetExhausted()) {
        this.stopReason = 'max_turns';
        return true;
      }
      // CHARGED BEFORE THE RE-PROMPT. Headless has no grace timer, so without
      // this line `maxAutoContinuesPerList` would never bind in the one
      // environment with no human to press Esc.
      budget = { ...budget, used: budget.used + 1 };
      wasAutoContinuation = true;
      this.note(`[todo] ${decision.notice}`);
      message = decision.message;
      source = 'todo_continue';
    }
  }

  // -----------------------------------------------------------------------
  // Budgets (section 3.5)
  // -----------------------------------------------------------------------

  /**
   * The wall clock starts at the FIRST `prompt()`, not at process start: the
   * caller is bounding the run, and config resolution plus a skills scan are not
   * part of what they asked to bound.
   */
  private startBudgetTimer(): void {
    if (this.timerStarted || this.opts.maxDurationMs === undefined) return;
    this.timerStarted = true;
    this.budgetTimer = setTimeout(() => {
      this.stopReason = 'timeout';
      this.controller?.abort();
    }, this.opts.maxDurationMs);
    // `unref` so it can never hold the event loop open, and it is cleared in
    // `detach()` so it can never fire against a disposed controller (R-10).
    this.budgetTimer.unref?.();
  }

  private turnBudgetExhausted(): boolean {
    return this.opts.maxTurns !== undefined && this.turns >= this.opts.maxTurns;
  }

  /**
   * Enforced at `turn_start`, NOT at `turn_end` (implementation finding IF-3).
   *
   * The design said "count `turn_end`; on reaching `n`, abort", and the counting
   * half is right - `turns` is exactly that count. Acting on it at `turn_end` is
   * not: a run that COMPLETES in exactly `n` turns would trip the budget it
   * never exceeded and report `stopReason: "max_turns"` with exit 3, so a CI
   * script running `aragon exec --max-turns 20 ... || fail` would fail on a
   * successful twenty-turn run. That is the single most likely way to make a
   * safety ceiling unusable as a safety ceiling.
   *
   * A turn that is STARTING when the count already sits at `n` is, by contrast,
   * unambiguous: the model asked for turn `n + 1` and the caller said no. AC-16
   * is satisfied either way - "a model that would take five turns" with
   * `--max-turns 2` still exits 3 with the partial answer in `result.result`.
   */
  private checkTurnBudget(): void {
    if (!this.turnBudgetExhausted()) return;
    if (this.stopReason !== 'end_turn') return;
    this.stopReason = 'max_turns';
    // THE EXISTING ABORT PATH, the same one `Esc` uses, so subagents are torn
    // down and the engine settles normally rather than being abandoned mid-turn.
    this.controller?.abort();
  }

  // -----------------------------------------------------------------------
  // Interrupts (section 3.6 / P0-1 / D-15)
  // -----------------------------------------------------------------------

  /**
   * EXEC REPLACES THE TERMINATOR; IT DOES NOT ADD A LISTENER.
   *
   * `logging/install.ts` registers the `SIGINT` / `SIGTERM` / `SIGHUP` listeners
   * once, for EVERY invocation, and its default terminator exits. A listener
   * added here would be later in EventEmitter order and would never run - the
   * process is already gone - so the run would vanish with no `result` line,
   * which is precisely the "the wrapper has to time out to learn the run ended"
   * outcome this whole section exists to prevent (P0-1 / R-15).
   *
   * FIRST SIGNAL: abort, record the reason, and RETURN WITHOUT EXITING. The run
   * settles through the normal path - session persisted, `result` emitted,
   * `process.exitCode = 128 + signo`.
   *
   * SECOND SIGNAL WITHIN 2s: exit immediately. That escape is what makes
   * returning safe: a wedged settle is always one more Ctrl-C away from ending.
   *
   * AFTER `detach()`: exit immediately as well, because from that moment there
   * is nothing left to settle and the caller's Ctrl-C must not become "nothing
   * happens".
   *
   * `detach()` DOES NOT RESTORE THE PREVIOUS TERMINATOR, AND THAT IS THE POINT
   * OF THE BRANCH ABOVE (implementation finding IF-7). The design asked for a
   * restore in `finally`; `setSignalTerminator` returns `void` and there is no
   * getter, so a literal restore would mean changing `logging/install.ts`, which
   * the change plan holds to a doc-comment-only edit. The `detached` branch is
   * what makes that safe rather than merely convenient: once detached this
   * terminator does `exit(128 + signo)`, which is byte for byte what the default
   * terminator does, so a left-behind one is INDISTINGUISHABLE from a restored
   * one. Anything that ever gives this process a terminator worth returning to -
   * the full-screen one that restores the terminal, or a second `runExec` in one
   * process under the programmatic API section 2.2 hedges for - must revisit
   * this and add the getter.
   */
  private installTerminator(): void {
    this.signals.setTerminator((signo: number) => {
      const at = this.now();
      const secondSignal = at - this.lastSignalAt <= SECOND_SIGNAL_WINDOW_MS;
      if (this.detached || (this.lastSignalAt > 0 && secondSignal)) {
        this.signals.exit(128 + signo);
        return;
      }
      this.lastSignalAt = at;
      this.signalNumber = signo;
      this.stopReason = 'interrupted';
      this.controller?.abort();
    });
  }

  // -----------------------------------------------------------------------
  // Event translation
  // -----------------------------------------------------------------------

  private emit(event: ExecEvent): void {
    this.emitter.emit(event);
  }

  /** Caller-facing prose. STDERR ALWAYS - stdout carries nothing but the schema. */
  private note(text: string): void {
    if (this.opts.quiet) return;
    (this.opts.stderr ?? process.stderr).write(`${text}\n`);
  }

  private onAgentEvent(event: AgentEvent): void {
    switch (event.type) {
      case 'message_update':
        this.onStreamEvent(event.streamEvent);
        break;
      case 'turn_start':
        // The ONE budget check that catches the ordinary case: a single
        // `prompt()` drives many turns, so a ceiling enforced only between
        // caller messages would never bind at all.
        this.checkTurnBudget();
        break;
      case 'tool_execution_start':
        this.emit({
          type: 'tool_call',
          sessionId: this.sessionId,
          turn: this.turns + 1,
          id: event.toolCallId,
          name: event.toolName,
          input: (event.args ?? {}) as Record<string, unknown>,
        });
        break;
      case 'tool_execution_end':
        this.emit({
          type: 'tool_result',
          sessionId: this.sessionId,
          turn: this.turns + 1,
          id: event.toolCallId,
          name: event.toolName,
          isError: event.isError,
          durationMs: event.duration,
          output: toolResultText(event.result),
        });
        break;
      case 'turn_end':
        this.onTurnEnd(event.message, event.usage);
        break;
      case 'agent_end':
        // A swallowed throw (missing key / empty stream) produces no `turn_end`.
        if (!this.sawTurnEnd && !this.errored && this.stopReason === 'end_turn') {
          this.errored = true;
          this.recordError('agent_error', 'The run produced no assistant turn.');
        }
        break;
      default:
        break;
    }
  }

  private onStreamEvent(se: StreamEvent): void {
    if (se.type === 'text_delta') {
      this.flushThinking();
      if (this.opts.partialMessages) {
        this.emit({
          type: 'text_delta',
          sessionId: this.sessionId,
          turn: this.turns + 1,
          delta: se.delta,
        });
      }
      return;
    }
    if (se.type === 'thinking_delta') {
      if (this.opts.includeThinking) this.thinkingBuffer += se.delta;
      return;
    }
    if (se.type === 'error') {
      this.errored = true;
      this.recordError('stream_error', formatStreamError(se.error));
      this.emit({
        type: 'error',
        sessionId: this.sessionId,
        fatal: true,
        code: 'stream_error',
        message: formatStreamError(se.error),
      });
      return;
    }
    if (se.type === 'retry_scheduled') {
      this.emit({
        type: 'retry',
        sessionId: this.sessionId,
        attempt: se.attempt,
        maxRetries: se.maxRetries,
        errorType: String(se.errorType),
        delayMs: se.delayMs,
      });
    }
  }

  private onTurnEnd(message: AssistantMessage, usage: TokenUsage): void {
    this.sawTurnEnd = true;
    this.turns += 1;
    this.usage.inputTokens += usage.inputTokens;
    this.usage.outputTokens += usage.outputTokens;
    this.flushThinking();
    const text = assistantText(message);
    if (text.length > 0) {
      this.lastAssistantText = text;
      this.emit({ type: 'assistant', sessionId: this.sessionId, turn: this.turns, text });
    }
  }

  private flushThinking(): void {
    if (this.thinkingBuffer.length === 0) return;
    const text = this.thinkingBuffer;
    this.thinkingBuffer = '';
    this.emit({ type: 'thinking', sessionId: this.sessionId, turn: this.turns + 1, text });
  }

  private recordError(code: string, message: string): void {
    if (this.errorCode) return;
    this.errorCode = code;
    this.errorMessage = message;
    if (this.stopReason === 'end_turn') this.stopReason = 'error';
  }

  private emitTeam(event: TeamEvent): void {
    if (event.type === 'dispatch_start') {
      this.emit({
        type: 'team',
        sessionId: this.sessionId,
        subtype: 'dispatch_start',
        total: event.specs.length,
      });
      return;
    }
    if (event.type === 'agent_update') {
      const { run } = event;
      this.emit({
        type: 'team',
        sessionId: this.sessionId,
        subtype: 'agent_update',
        label: run.label,
        phase: run.phase,
        description: run.description,
        durationMs: Math.max(0, (run.endedAt ?? 0) - (run.startedAt ?? 0)),
        toolCalls: run.toolCalls,
      });
      return;
    }
    if (event.type === 'dispatch_end') {
      const runs = event.outcome.runs;
      this.emit({
        type: 'team',
        sessionId: this.sessionId,
        subtype: 'dispatch_end',
        ok: runs.filter((r) => r.phase === 'done' && !r.error).length,
        total: runs.length,
        aborted: event.outcome.aborted,
      });
    }
  }
}

/** The final assistant text of a turn, or `''` when the turn was tool calls only. */
function assistantText(message: AssistantMessage | undefined): string {
  if (!message || !Array.isArray(message.content)) return '';
  const parts: string[] = [];
  for (const block of message.content) {
    if (block.type === 'text') parts.push(block.text);
  }
  return parts.join('').trim();
}

/**
 * Flatten a `ToolResult` to the text the MODEL saw.
 *
 * NO SECOND TRUNCATION (AC-26). The core executor already clips at roughly
 * 100 KB; clipping again here would make the event a summary of a summary, and
 * the one faithful choice is to carry what was actually in the conversation.
 */
function toolResultText(result: ToolResult | undefined): string {
  if (!result || !Array.isArray(result.content)) return '';
  const parts: string[] = [];
  for (const block of result.content) {
    if (block.type === 'text') parts.push(block.text);
  }
  return parts.join('');
}
