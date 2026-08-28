/**
 * TurnFrameRing — the reviewer's bounded record of what the lead just did
 * (fast-model-tier §3.5.1, extracted here by fast-model-tier-hardening W3).
 *
 * ASCII ONLY: `src/fast/**` is inside the glyph scanner's scope.
 *
 * THIS IS THE `data` HALF OF THE SPLIT, AND IT IS A LEAF ON PURPOSE. `reviewer.ts`
 * was at 871 of the repo's 1 000-line cap before round 2 added a budget to it, so
 * the ring and the transport moved out. The split line is drawn along data and
 * transport BECAUSE BOTH ARE LEAVES: the protocol — the two drain guards and the
 * call-cancellation stamping — stays whole in `reviewer.ts`, where a module
 * boundary through it would reopen a P0 (§3.3 / AC-H11 / AC-H16).
 *
 * WHAT THIS CLASS OWNS: the open frame, the retired ring, the outstanding-call
 * counter and the tool-argument map. WHAT IT DECIDES: nothing. It reports that a
 * batch has emptied; the caller decides what that means.
 */

import type { AssistantMessage, StreamEvent } from '@aragon-agent/core';
import { FAST_LIMITS } from './limits.js';
// The one `unknown -> text` helper of this tree lives with the module that
// classifies errors. A second copy here would be a second answer to one question.
import { errorText } from './review-call.js';
import type { TurnFrame } from './types.js';

export interface TurnFrameRingDeps {
  /**
   * Whether a frame can still be consumed by a review this run.
   *
   * A PREDICATE, NOT A BOOLEAN, and read inside `recordDelta` rather than at its
   * call site: this runs on every `text_delta` of every turn, and evaluating the
   * caller's gate eagerly would move a config read onto the hottest path in the
   * package for the deltas that are discarded by type anyway.
   */
  canRecord(): boolean;
}

/** The one argument a tool call is worth naming in a digest. */
function pickToolArg(args: unknown): string | undefined {
  const a = (args ?? {}) as Record<string, unknown>;
  for (const key of ['path', 'pattern', 'command', 'query', 'label']) {
    const value = a[key];
    if (typeof value === 'string' && value.length > 0) {
      return value.slice(0, FAST_LIMITS.toolArgChars);
    }
  }
  return undefined;
}

export class TurnFrameRing {
  private retained: TurnFrame[] = [];
  private open: TurnFrame | null = null;
  /**
   * Tool calls still to run in the current batch.
   *
   * ASSIGNED at `turn_end`, NEVER CARRIED ACROSS TURNS (RV-7), and the
   * difference is not cosmetic. Two paths end a batch without emitting a
   * `tool_execution_end` for every call: checkpoint 2 skips the whole batch
   * (`agent-loop.ts:199-207`) and an abort breaks out mid-batch (`:211`). A
   * counter that only ever decremented would sit permanently above zero after
   * either, and the injection window would never open again for the rest of the
   * run. Re-assigning at each `turn_end` makes both cases self-heal on the next
   * turn, which is correct: those batches genuinely had no window.
   */
  private outstanding = 0;
  private completedTurns = 0;
  /** Tool args captured at `tool_execution_start`, keyed by call id. */
  private readonly toolArgs = new Map<string, string>();

  constructor(private readonly deps: TurnFrameRingDeps) {}

  /** Completed turns of the CURRENT run — the cadence and staleness clock. */
  get turns(): number {
    return this.completedTurns;
  }

  /** Always 0 at the injection window; logged there as the assertion, recorded. */
  get outstandingCalls(): number {
    return this.outstanding;
  }

  /** The ring, oldest first. `buildReviewDigest` filters it for sealed frames. */
  frames(): TurnFrame[] {
    return this.retained;
  }

  /** `agent_start`. */
  reset(): void {
    this.retained = [];
    this.open = null;
    this.outstanding = 0;
    this.completedTurns = 0;
    this.toolArgs.clear();
  }

  /** `agent_end` — the ring survives for a late answer; the open frame does not. */
  endRun(): void {
    this.open = null;
    this.toolArgs.clear();
  }

  /** `turn_start`. */
  beginTurn(): void {
    this.open = {
      index: this.completedTurns + 1,
      textTail: '',
      tools: [],
      sealed: false,
    };
  }

  /**
   * The frame recorder.
   *
   * GATED ON `text_delta` AS AN ALLOW-TEST, NEVER A DENY-LIST (RV-10 / R-16).
   * `agent-loop.ts:170` forwards EVERY stream event through `message_update` -
   * `text_delta`, `thinking_delta`, `tool_call_delta`, `done`, and (as of
   * `llm-api-retry-backoff`) `retry_scheduled` / `retry_attempt` - so this is a
   * synchronous listener on the hottest path in the package. A deny-list would
   * have silently started recording the two new members the moment they shipped.
   *
   * The remaining conditions are economic rather than structural: after the last
   * permitted review of a run there is nothing left that can consume a frame.
   */
  recordDelta(streamEvent: StreamEvent): void {
    if (streamEvent.type === 'error') {
      if (this.open) this.open.error = errorText(streamEvent.error);
      return;
    }
    if (streamEvent.type !== 'text_delta') return;
    if (!this.open) return;
    if (!this.deps.canRecord()) return;
    const delta = streamEvent.delta;
    if (delta.length === 0) return;
    // O(1) per delta: one bounded concat and one bounded slice, the same rolling
    // tail `subagent.ts:392` already uses for the activity line.
    this.open.textTail = (this.open.textTail + delta).slice(-FAST_LIMITS.turnTailChars);
  }

  /** `tool_execution_start`. */
  noteToolArgs(toolCallId: string, args: unknown): void {
    const arg = pickToolArg(args);
    if (arg !== undefined) this.toolArgs.set(toolCallId, arg);
  }

  /** `turn_end`. A turn with NO tool calls ends the run, so its frame seals here. */
  endTurn(message: AssistantMessage): void {
    this.completedTurns += 1;
    const calls = Array.isArray(message?.content)
      ? message.content.filter((b) => b.type === 'tool_call').length
      : 0;
    this.outstanding = calls;
    if (this.open) this.open.index = this.completedTurns;
    if (calls === 0) this.seal();
  }

  /**
   * `tool_execution_end`. Returns whether this call EMPTIED the batch — which is
   * both the sealing point (§3.5.1) and the one injection window (§3.5.4). The
   * ring reports the fact; `reviewer.ts` owns what follows from it.
   */
  endTool(toolCallId: string, toolName: string, isError: boolean, duration: number): boolean {
    if (this.open) {
      const arg = this.toolArgs.get(toolCallId);
      this.open.tools.push({
        name: toolName,
        ...(arg !== undefined ? { arg } : {}),
        ...(isError ? { isError: true } : {}),
        ms: duration,
      });
    }
    this.toolArgs.delete(toolCallId);

    if (this.outstanding > 0) this.outstanding -= 1;
    return this.outstanding === 0;
  }

  /**
   * Seal the open frame and retire it into the ring.
   *
   * A REVIEW IS TRIGGERED ON SEALING, NOT AT `turn_end` (RV-2 / D-22).
   * `turn_end` fires at `agent-loop.ts:188`, BEFORE any tool runs, while
   * `TurnFrame.tools` carries `isError` and `ms` - fields that exist only once
   * `tool_execution_end` has been emitted (`:249-256`). Triggering there meant
   * the newest frame of every digest was structurally missing the single fact a
   * reviewer most needs: whether the batch it is reviewing just failed.
   */
  seal(): void {
    if (!this.open || this.open.sealed) return;
    this.open.sealed = true;
    this.retained.push(this.open);
    if (this.retained.length > FAST_LIMITS.maxFramesRetained) {
      this.retained.splice(0, this.retained.length - FAST_LIMITS.maxFramesRetained);
    }
    this.open = null;
  }
}
