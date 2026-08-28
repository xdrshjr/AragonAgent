/**
 * The injected context-management port (context-auto-compaction §3.2).
 *
 * TYPES ONLY, ZERO LOGIC, and the only imports are erased type imports from
 * `llm/types.js` and `agent-loop.js`. The engine does not know what a context
 * window IS — `Agent` holds a `ModelRef`, never a `ModelInfo` — and it must not
 * learn, because `ModelRegistry` lives one layer up and
 * `no-host-coupling.test.ts` rule 2 forbids this package from reaching for a
 * host. So the engine gains ONE port it calls at a turn boundary, and every
 * decision behind it — the threshold, which model summarizes, what the summary
 * asks for, what happens on failure — is made on the host's side of it (D-2).
 */

import type { Message, TokenUsage } from '../llm/types.js';
import type { ModelRef } from './agent-loop.js';

/** Why compaction is being considered right now. */
export type CompactionTrigger = 'pressure' | 'overflow';

/** What the engine can cheaply tell the host at a turn boundary. */
export interface CompactionProbe {
  readonly messageCount: number;
  /**
   * Authoritative usage of the most recently COMPLETED turn, or `undefined`
   * before the first one (a fresh run, or the first turn after `/resume`).
   *
   * THE HOST MUST HANDLE `undefined` (§3.4.2). It is not an edge case: the most
   * dangerous single moment in this feature's life is the first request of a
   * resumed 180 k-token session, where there is no usage to read and the naive
   * answer is "0 %".
   */
  readonly lastUsage?: TokenUsage;
  /** 1-based index of the turn that is about to be sent. */
  readonly turnIndex: number;
  readonly trigger: CompactionTrigger;
}

export interface CompactionContext extends CompactionProbe {
  /**
   * A SHALLOW COPY of the engine's history, never the live array (P1-2).
   *
   * `MessageManager.getAll()` returns the internal array itself (the "readonly
   * view" in its doc comment is a TYPE, not a copy). Passing that across the
   * port would let a host that sorts, splices or truncates it corrupt engine
   * state in place, BEFORE the structural gate at §3.3 step 5 can look at it —
   * which would defeat the one job the engine has in this feature. One array
   * allocation per compaction, i.e. at most `maxPerRun` per run, buys the whole
   * guarantee.
   */
  readonly messages: readonly Message[];
  readonly systemPrompt: string;
  readonly model: ModelRef;
  /**
   * The run's signal. The host MUST forward it into its own LLM call.
   *
   * The engine does not TRUST that it does: `runCompaction` races this promise
   * against the signal and against a hard ceiling (§3.3), because the watchdog
   * is paused across the call and a non-settling promise would otherwise hang
   * the run with the idle detector switched off (P1-3).
   */
  readonly signal: AbortSignal;
}

export type CompactionOutcome =
  | { action: 'keep'; reason: string }
  | {
      action: 'replace';
      messages: Message[];
      mode: 'summarized' | 'truncated';
      /** For the event; the engine does not interpret it. */
      summary?: string;
      reason?: string;
    };

export interface ContextManager {
  /**
   * SYNCHRONOUS, CHEAP, SIDE-EFFECT FREE. Called once per turn, before the LLM
   * request is built.
   *
   * IT IS SYNCHRONOUS SO THAT "OFF" AND "BELOW THRESHOLD" COST NOTHING (D-3).
   * A single async port would put an `await` — a microtask tick and a promise
   * allocation — on every turn of every run for a decision that is `false` more
   * than 99 % of the time, and would make it impossible to state that a session
   * below the threshold is byte-identical to a pre-feature build.
   */
  shouldCompact(probe: CompactionProbe): boolean;

  /**
   * Only called when `shouldCompact` returned `true`.
   *
   * MUST NOT THROW. The engine wraps the call defensively anyway (§3.3 step 4),
   * because a host that breaks its own contract must degrade to "compaction did
   * not happen", never to "the run died" — but a throwing implementation is a
   * bug on the host side and is reported as one through `compaction_end.reason`.
   */
  compact(ctx: CompactionContext): Promise<CompactionOutcome>;
}
