/**
 * Per-child fast review (main-agent parity).
 *
 * ASCII ONLY: `src/team/**` is inside the glyph scanner's scope
 * (`glyphs.test.ts`), so no literal in this tree may hold a non-ASCII byte.
 *
 * THE LEAD HAS A FAST REVIEWER; A CHILD NOW HAS ONE TOO. The requirement is
 * that "when the main agent pulls up subagents, all subagents are as capable as
 * the main agent", and the fast/slow cooperation is part of what the main agent
 * has: a cheap second model periodically critiques the run and steers a
 * `<fast_review>` block into the conversation. A child runs the lead's own
 * model, and this module gives that run the same second opinion.
 *
 * WHAT IS SHARED, AND WHAT IS PER CHILD:
 *   - SHARED: the tier resolution (`resolveFastTier` on the LIVE config), the
 *     fail-fast review transport (`FastWiring.completeViaFastRegistry` - one
 *     lazy registry for the whole session, the same adapter-state reuse
 *     argument `TeamRuntime` makes about the lead's `ProviderRegistry`), and
 *     the `fast.*` policy keys. A `/fast off` mid-dispatch therefore stops
 *     child reviews at the same instant it stops the lead's.
 *   - PER CHILD: one `FastReviewer` instance, its own turn-frame ring, its own
 *     session budget, its own goal (the spec's description).
 *
 * THE REVIEWER'S PROTOCOL IS UNCHANGED, AND THAT IS THE POINT. `FastReviewer`
 * steers from exactly one place (the `tool_execution_end` that brings the batch
 * to zero), never steers into a requested abort, and proves delivery at the
 * next `turn_start`. The two guards need host-side facts, and a child supplies
 * them differently than the lead:
 *
 *   - `userSteerCount` is ALWAYS ZERO: no human can steer a child. That makes
 *     the reviewer's `clearAllQueues` provably safe by construction (D-21).
 *   - `isAbortRequested` comes from the HANDLE-level abort flag that
 *     `TeamRuntime` sets BEFORE calling `agent.abort()`. Reading the agent
 *     alone is not enough: an Esc lands as `abortAll()`, and without the flag
 *     the reviewer would race the abort it was told about.
 *   - `emit` and `notify` LOG INSTEAD OF RENDERING. A child has no transcript
 *     card and no status chip; the team panel row and the dispatch report are
 *     where a child's internals belong, and review spend is bounded by the
 *     same `fast.reviewMaxPerSession` budget the lead obeys.
 */

import type {
  AgentEvent,
  AssistantMessage,
  LLMRequest,
} from '@aragon-agent/core';
import type { ModelRole } from '../config/model-profiles.js';
import type { CliConfig } from '../config/schema.js';
import { getLogger } from '../logging/logger.js';
import { resolveFastTier } from '../fast/resolve.js';
import { FastReviewer } from '../fast/reviewer.js';
import type { FastSnapshot, FastTier } from '../fast/types.js';

/**
 * The slice of a child `Agent` the reviewer needs beyond what
 * `SubagentAgentLike` already carries. Core's `Agent` satisfies this with its
 * own `steer` / `clearAllQueues`; a test stub satisfies it the same way.
 */
export interface ChildReviewerAgent {
  subscribe(listener: (event: AgentEvent) => void): () => void;
  steer(text: string): void;
  clearAllQueues(): void;
}

/** Everything one child reviewer needs to know about its child. */
export interface ChildReviewerRequest {
  label: string;
  /** The spec's description: the goal the critique judges the run against. */
  goal: string;
  agent: ChildReviewerAgent;
  /** A live phase, not a terminal one - the lead's `isRunning` equivalent. */
  isRunning: () => boolean;
  /** Set by the HANDLE-level abort, synchronously before `agent.abort()`. */
  isAbortRequested: () => boolean;
}

/** Everything the reviewer needs from the session, all of it shared. */
export interface ChildReviewerDeps {
  /** Read LIVE on every call - a mid-dispatch `/fast off` must reach children. */
  getConfig: () => CliConfig;
  hasKey: (providerId: string, role?: ModelRole) => boolean;
  getApiKey: (providerId: string, role?: ModelRole) => string | undefined;
  /** `FastWiring.completeViaFastRegistry` - the shared fail-fast transport. */
  complete: (providerId: string, request: LLMRequest) => Promise<AssistantMessage>;
  /** `FastWiring.available()` - registered AND enabled AND resolving. */
  available: () => boolean;
}

export interface ChildReviewerHandle {
  dispose(): void;
}

/**
 * What the controller hands `subagent.ts`, so a child's reviewer is built from
 * the lead's own wiring rather than a second tier resolver.
 *
 * `active` AND `create` ARE SEPARATE ON PURPOSE: the child's system prompt
 * must be composed BEFORE the agent exists, and `create` needs the agent. The
 * two must answer the same question at the same instant, so both derive from
 * `FastWiring.available() && config.fast.review` and the caller reads `active`
 * once per child.
 */
export interface ChildReviewProvider {
  /** Whether per-child review is live RIGHT NOW (tier live AND `fast.review`). */
  active: () => boolean;
  /** The resolved fast model id, for the child's `<fast_tier>` prompt block. */
  modelId: () => string;
  /** Build one reviewer for a child; `undefined` when not active. */
  create: (req: ChildReviewerRequest) => ChildReviewerHandle | undefined;
}

/**
 * A snapshot for the reviewer's self-disable announcement. The lead's
 * `FastWiring.snapshot()` builds the same shape from its own reviewer; a child
 * has no wiring, so this builds it from the reviewer the module itself holds.
 *
 * `pricingUnknown` is FALSE because the child reviewer never prices anything:
 * it logs counts, not currency, and an unpriced model id therefore cannot lie
 * here the way it can on the lead's status line (C-11).
 */
function buildSnapshot(reviewer: FastReviewer | null, tier: FastTier): FastSnapshot {
  return {
    live: tier.ok,
    selfDisabled: reviewer?.isSelfDisabled() ?? false,
    model: tier.ok ? tier.ref.modelId : '',
    sameAsMain: tier.ok ? tier.sameAsMain : false,
    reviews: reviewer?.reviewCount() ?? 0,
    reviewBudget: reviewer?.budgetLimit() ?? 0,
    budgetReached: reviewer?.isBudgetReached() ?? false,
    usage: reviewer?.sessionUsage() ?? { inputTokens: 0, outputTokens: 0 },
    pricingUnknown: false,
    inFlight: reviewer?.isReviewInFlight() ?? false,
  };
}

/**
 * Build one reviewer for one child, or `undefined` when the session has no
 * live review to give it.
 *
 * `undefined` RATHER THAN A NO-OP REVIEWER, for the same reason
 * `createChildContextManager` declines: the caller then wires nothing at all,
 * and a session with the fast tier off builds the child it always built.
 */
export function createChildReviewer(
  req: ChildReviewerRequest,
  deps: ChildReviewerDeps,
): ChildReviewerHandle | undefined {
  // GATED ON THE SAME THREE FACTS THE LEAD'S REVIEWER IS: the wiring is live
  // (`available()`), the policy allows reviews (`fast.review`), and the tier
  // resolves against the LIVE config. Re-checked, never snapshotted, so a
  // mid-dispatch `/fast off` or a settings-screen model edit reaches the next
  // child even when it cannot stop one already running.
  const tier = resolveFastTier(deps.getConfig(), deps.hasKey);
  if (!deps.available() || !deps.getConfig().fast.review || !tier.ok) return undefined;

  const log = getLogger().child('fast');
  let reviewer: FastReviewer | null = null;

  const built = new FastReviewer({
    subscribe: (listener) => req.agent.subscribe(listener),
    complete: deps.complete,
    steer: (text) => req.agent.steer(text),
    isRunning: req.isRunning,
    isAbortRequested: req.isAbortRequested,
    userSteerCount: () => 0,
    clearAllQueues: () => req.agent.clearAllQueues(),
    getTier: () => resolveFastTier(deps.getConfig(), deps.hasKey),
    getConfig: () => deps.getConfig().fast,
    available: () =>
      deps.available() && resolveFastTier(deps.getConfig(), deps.hasKey).ok,
    getApiKey: (providerId) => deps.getApiKey(providerId, 'fast'),
    emit: (event) => {
      log.info('child_review', { label: req.label, type: event.type });
    },
    snapshot: () => buildSnapshot(reviewer, tier),
    // A CHILD HAS NO TRANSCRIPT. The lead's warnings ride `notify` into a card
    // the user reads; the same text from a background worker would claim the
    // user's attention for an agent they cannot see. It is logged instead.
    notify: (level, text) => {
      log.warn('child_review_notice', { label: req.label, level, text });
    },
  });
  reviewer = built;
  built.setGoal(req.goal);

  log.info('child_review_attached', {
    label: req.label,
    model: tier.ref.modelId,
    reviewEveryTurns: deps.getConfig().fast.reviewEveryTurns,
  });

  return { dispose: () => built.dispose() };
}
