/**
 * FastWiring — the controller-side glue for the fast tier (fast-model-tier §3.1
 * / §3.3).
 *
 * ASCII ONLY: `src/fast/**` is inside the glyph scanner's scope.
 *
 * THIS CLASS EXISTS FOR A BUDGET REASON, NOT AN AESTHETIC ONE (C-12 / RV-5).
 * `CLAUDE.md` caps a source file at 1000 lines and `controller.ts` was at 960
 * before this feature, which handed it nine new responsibilities. `FastWiring`
 * owns the flag pair, the tier cache, the reviewer's lifetime and the
 * `resolveTier` closure; `AgentController` keeps one field and four thin
 * forwarders. It is still CLI-local and still holds no `ui/` import.
 *
 * TWO FLAGS AND ONE LIVE PREDICATE (§3.3), which is the shape every optional
 * subsystem in this package already uses:
 *
 *   fastRegistered  decided ONCE at construction  = resolveFastTier(config).ok
 *   fastEnabled     live, flipped by /fast on|off = starts equal to registered
 *   available()     derived, read at EVERY use    = registered && enabled
 *                                                   && resolveFastTier(config).ok
 *
 * THE THIRD TERM IS NOT REDUNDANT, and leaving it out is RV-3. `fastRegistered`
 * is frozen by C-2, but the tier it was derived from is not: `fast.provider: ''`
 * and `fast.baseUrl: ''` INHERIT from `config.provider` / `config.baseUrl`, and
 * the key check reads `apiKeys` - all of which `/model`, `/provider`, `/reload`,
 * the settings screen's save and a one-shot key edit rewrite mid-session. So
 * `registered && enabled` can be true at the exact moment `resolveFastTier` has
 * started returning `no_key`, at which point `task` keeps advertising
 * `model:"fast"`, the child is built against a provider with no key, and it dies
 * inside its own loop with an error naming neither the tier nor the setting that
 * caused it (`agent-loop.ts:140-145`).
 */

import type { ModelRole } from '../config/model-profiles.js';
import {
  DEFAULT_RETRY_POLICY,
  initProviders,
  type AgentEvent,
  type AssistantMessage,
  type LLMRequest,
  type ModelRef,
  type ProviderRegistry,
  type RetryPolicy,
  type ThinkingLevel,
} from '@aragon-agent/core';
import type { CliConfig } from '../config/schema.js';
import { getLogger } from '../logging/logger.js';
import type { NoticeLevel } from '../agent/reducer.js';
import { describeFastTierProblem, fastProviderOf, resolveFastTier } from './resolve.js';
import { FastReviewer } from './reviewer.js';
import type {
  FastEvent,
  FastEventListener,
  FastSnapshot,
  FastTier,
  FastTierName,
} from './types.js';

export interface FastWiringDeps {
  /** Read LIVE on every call - the controller replaces the object on mutation. */
  getConfig: () => CliConfig;
  /** `AgentController.hasApiKey`, so there is exactly one key resolver. */
  hasKey: (providerId: string, role?: ModelRole) => boolean;
  getApiKey: (providerId: string, role?: ModelRole) => string | undefined;
  /** Whether the static price table knows this model (C-11 / RV-4). */
  isPricedModel: (ref: Pick<ModelRef, 'providerId' | 'modelId'>) => boolean;
  /** The lead agent's event stream and steering surface. */
  subscribe: (listener: (event: AgentEvent) => void) => () => void;
  /**
   * NOT THE REVIEWER'S TRANSPORT SINCE ROUND 2 (W2 / §3.2): the reviewer calls
   * through `getFastRegistry()`, which is fail-fast and does not observe the
   * user's `/retry`. Retained because the only alternative is a `controller.ts`
   * edit that the round-2 change plan forbids (D-H13), and because the next
   * caller that needs the LEAD's registry from here already has it. Do not
   * "clean up" without reading §3.2.
   */
  complete: (providerId: string, request: LLMRequest) => Promise<AssistantMessage>;
  steer: (text: string) => void;
  isRunning: () => boolean;
  isAbortRequested: () => boolean;
  userSteerCount: () => number;
  clearAllQueues: () => void;
  notify: (level: NoticeLevel, text: string) => void;
  /** Recompose the system prompt: `<fast_tier>` interpolates the model id, so a
   *  tier that stops resolving must not leave the prompt naming it (§3.9). */
  onPromptChanged: () => void;
}

/** What `/fast status`, the settings line and the status chip all read. */
export interface FastStatus {
  registered: boolean;
  enabled: boolean;
  tier: FastTier;
  snapshot: FastSnapshot;
}

/**
 * One retry, not ten and not zero (D-H3).
 *
 * ZERO loses a review to a single connection reset; TEN is what makes a
 * background advisory compete with the user's own work for a rate-limited
 * provider's quota, which is the whole defect W2 exists to close. It spreads
 * `DEFAULT_RETRY_POLICY` rather than replacing it, so `respectRetryAfter` and
 * the transient classification stay exactly as the lead's - only the attempt
 * count differs.
 */
const FAST_RETRY_POLICY: RetryPolicy = { ...DEFAULT_RETRY_POLICY, maxRetries: 1 };

/** The status of a session that never had the tier (wiring is `null`). */
export function offFastStatus(): FastStatus {
  return {
    registered: false,
    enabled: false,
    tier: { ok: false, reason: 'disabled' },
    snapshot: {
      live: false,
      // A tier that never existed was never switched off by its reviewer, so
      // `false` here is the truth and not a placeholder.
      selfDisabled: false,
      model: '',
      sameAsMain: false,
      reviews: 0,
      // BOTH ARE PLACEHOLDERS FOR "THERE IS NO TIER", NOT A LIMIT (RV-H10).
      // `reviews >= reviewBudget` here is `0 >= 0` -> `true`, which is why
      // `budgetReached` is CARRIED and callers must never re-derive it.
      reviewBudget: 0,
      budgetReached: false,
      delegated: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
      pricingUnknown: false,
      inFlight: false,
    },
  };
}

export class FastWiring {
  /** Scope `fast` since round 2 (W4), for the reason `FastReviewer` records. */
  private readonly log = getLogger().child('fast');
  private readonly listeners = new Set<FastEventListener>();
  private readonly reviewer: FastReviewer;
  /** The reviewer's OWN transport (W2 / §3.2). Lazy - see `getFastRegistry()`. */
  private fastRegistry: ProviderRegistry | null = null;

  /** Frozen at construction (C-2): the `task` schema cannot grow a field later. */
  private readonly registered: boolean;
  private enabled: boolean;
  /** The last resolution. Recomputed by `onConfigChanged()`, never trusted stale. */
  private tier: FastTier;
  /** Warned once per TRANSITION, so a broken tier does not shout every turn. */
  private lastReportedReason: string | null = null;
  private delegated = 0;

  constructor(private readonly deps: FastWiringDeps) {
    this.tier = resolveFastTier(deps.getConfig(), deps.hasKey);
    this.registered = this.tier.ok;
    this.enabled = this.registered;
    this.lastReportedReason = this.tier.ok ? null : this.tier.reason;

    this.log.info('fast_tier_resolved', {
      enabled: deps.getConfig().fast.enabled,
      provider: this.tier.ok ? this.tier.ref.providerId : fastProviderOf(deps.getConfig()),
      model: this.tier.ok ? this.tier.ref.modelId : deps.getConfig().fast.model,
      sameAsMain: this.tier.ok ? this.tier.sameAsMain : false,
      ...(this.tier.ok ? {} : { reason: this.tier.reason }),
    });

    this.reviewer = new FastReviewer({
      subscribe: deps.subscribe,
      // W2: the reviewer's own fail-fast registry, NOT `deps.complete`. Bound
      // through a closure so the registry stays lazy - the reviewer holds no
      // reference to it and never learns a second one exists.
      complete: (providerId, request) => this.getFastRegistry().complete(providerId, request),
      steer: deps.steer,
      isRunning: deps.isRunning,
      isAbortRequested: deps.isAbortRequested,
      userSteerCount: deps.userSteerCount,
      clearAllQueues: deps.clearAllQueues,
      getTier: () => this.tier,
      getConfig: () => this.deps.getConfig().fast,
      available: () => this.available(),
      getApiKey: (id) => deps.getApiKey(id, 'fast'),
      emit: (event) => this.emit(event),
      // The reviewer announces its own self-disable with a `tier_changed`, and
      // only the wiring can build the snapshot that carries it.
      snapshot: () => this.snapshot(),
      notify: deps.notify,
    });
  }

  // -----------------------------------------------------------------------
  // The reviewer's transport (W2 / §3.2)
  // -----------------------------------------------------------------------

  /**
   * The registry the REVIEW calls through — separate from the lead's, and
   * fail-fast.
   *
   * THE PROBLEM IT SOLVES. `ProviderRegistry.complete()` routes through a
   * retrying `stream()`, the policy is per-registry, and `LLMRequest` carries no
   * override (IF-3) - so before this the background advisory inherited the
   * user's `retry` config, up to ten attempts with backoff. During the one
   * condition where the fast tier is most likely to be failing (a rate-limited
   * or overloaded provider), an unrequested call competed with the user's actual
   * work for the same quota. It needs NO core change: `initProviders()` is
   * exported and returns a FRESH registry per call with all three adapters
   * registered, which is exactly what `resolveFastTier` rule 4 gates on.
   *
   * IT DOES NOT OBSERVE THE USER'S `retry` CONFIG OR `/retry`, deliberately
   * (D-H4): that policy states how hard to fight for the USER'S answer, and
   * inheriting it for a call nobody asked for is the bug. Logged at construction
   * so a support reader can see which policy a review ran under.
   *
   * LAZY, SO OFF STAYS BYTE-IDENTICAL (I-2 / AC-H13). Nothing is constructed
   * until a review actually calls, so a session that never uses the tier
   * allocates no registry and registers no adapters.
   */
  private getFastRegistry(): ProviderRegistry {
    if (this.fastRegistry === null) {
      this.fastRegistry = initProviders({ retryPolicy: FAST_RETRY_POLICY });
      this.log.info('fast_registry_created', { maxRetries: FAST_RETRY_POLICY.maxRetries });
    }
    return this.fastRegistry;
  }

  // -----------------------------------------------------------------------
  // Flags and the live predicate
  // -----------------------------------------------------------------------

  isRegistered(): boolean {
    return this.registered;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * §3.3's live predicate. THE THIRD TERM IS THE POINT - see the header.
   *
   * `FastReviewer.isSelfDisabled()` is DELIBERATELY NOT a fourth term. Folding
   * it in would look tidier and would break something else: `delegationAvailable()`
   * is `available() && config.fast.delegate === true`, so three consecutive
   * REVIEW failures would silently switch DELEGATION off as well - turning a
   * diagnostic signal into a behaviour change for every user. The two facts are
   * reported separately on `FastSnapshot` instead (`live` / `selfDisabled`).
   */
  available(): boolean {
    return this.registered && this.enabled && this.tier.ok;
  }

  /**
   * Whether `model: "fast"` on `task` is honoured right now.
   *
   * Evaluated AT DISPATCH TIME, never snapshot (§3.4 / RV-3). `fast.delegate:
   * false` and "the tier stopped resolving twenty minutes ago" are the same
   * observable to the model - a downgrade, counted and reported - which is the
   * honest reading of both.
   */
  delegationAvailable(): boolean {
    return this.available() && this.deps.getConfig().fast.delegate === true;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.deps.onPromptChanged();
    this.emit({ type: 'tier_changed', snapshot: this.snapshot() });
  }

  /**
   * Re-resolve the tier after ANY config mutation (§3.2 rule 8 / §3.9 / RV-3).
   *
   * Called from `setModel`, `setApiKey`, `setFastConfig`, `/reload` and the
   * settings screen's save - the five live inputs rules 2, 5 and 6 read. It also
   * recomposes the system prompt, because `<fast_tier>` interpolates the
   * resolved model id and a prompt naming a model the tier will not use is worse
   * than no prompt at all.
   */
  onConfigChanged(refreshPrompt = true, enabled?: boolean): void {
    if (enabled !== undefined) this.enabled = enabled;
    const next = resolveFastTier(this.deps.getConfig(), this.deps.hasKey);
    const before = this.tier;
    this.tier = next;

    const reason = next.ok ? null : next.reason;
    if (reason !== this.lastReportedReason) {
      this.lastReportedReason = reason;
      if (reason && before.ok) {
        // A tier that stopped resolving MID-SESSION is the case R-14 is about:
        // without a word here the only symptom is a child dying with
        // `No API key available for provider "openai"`.
        this.log.warn('fast_tier_unavailable', { reason });
        const text = describeFastTierProblem(next, fastProviderOf(this.deps.getConfig()));
        if (text) this.deps.notify('warn', text);
      }
    }

    if (refreshPrompt) this.deps.onPromptChanged();
    this.emit({ type: 'tier_changed', snapshot: this.snapshot() });
  }

  /**
   * The startup notice for a configuration mistake that is otherwise invisible
   * (§3.3). Raised once, at construction, through the controller's `notify`.
   */
  startupNotice(): string | null {
    return describeFastTierProblem(this.tier, fastProviderOf(this.deps.getConfig()));
  }

  // -----------------------------------------------------------------------
  // Tier resolution for subagents (§3.4)
  // -----------------------------------------------------------------------

  /**
   * The `ModelRef` and thinking level one subagent tier runs on.
   *
   * `'fast'` FALLS BACK TO MAIN when delegation is not available, so the two
   * guards agree BY CONSTRUCTION: the normalizer can never produce a
   * `tier: 'fast'` spec this factory would refuse, and this factory can never
   * build a child against a `ModelRef` the tier no longer resolves (RV-3).
   */
  resolveTier(tier: FastTierName): { ref: ModelRef; thinkingLevel: ThinkingLevel; role?: ModelRole } {
    const config = this.deps.getConfig();
    if (tier === 'fast' && this.delegationAvailable() && this.tier.ok) {
      return { ref: this.tier.ref, thinkingLevel: this.tier.thinkingLevel, role: 'fast' };
    }
    return {
      ref: {
        providerId: config.provider,
        modelId: config.model,
        ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      },
      thinkingLevel: config.thinkingLevel,
      role: 'main',
    };
  }

  /** The resolved fast `ModelRef`, or `null` - for per-tier cost lookup (§3.6). */
  fastRef(): ModelRef | null {
    return this.tier.ok ? this.tier.ref : null;
  }

  /** Count fast-tier children so `/fast status` can answer "is this saving me
   *  anything?" — the aggregate on the status bar cannot. */
  noteDelegated(count: number): void {
    if (count > 0) this.delegated += count;
  }

  // -----------------------------------------------------------------------
  // Reviewer lifetime
  // -----------------------------------------------------------------------

  setGoal(text: string): void {
    this.reviewer.setGoal(text);
  }

  abort(): void {
    this.reviewer.abort();
  }

  dispose(): void {
    this.reviewer.dispose();
    this.listeners.clear();
  }

  // -----------------------------------------------------------------------
  // Status and events
  // -----------------------------------------------------------------------

  getTier(): FastTier {
    return this.tier;
  }

  snapshot(): FastSnapshot {
    const ref = this.tier.ok ? this.tier.ref : null;
    return {
      live: this.available(),
      // ORTHOGONAL TO `live`, never derivable from it (see `FastSnapshot`).
      selfDisabled: this.reviewer.isSelfDisabled(),
      model: ref ? ref.modelId : '',
      sameAsMain: this.tier.ok ? this.tier.sameAsMain : false,
      // THE NUMERATOR, THE DENOMINATOR AND THE FLAG ARE READ IN ONE EXPRESSION,
      // so they cannot describe different moments (§5 / R-H8). `reviewBudget`
      // comes from live config, which is what lets `/fast budget <n>` change the
      // denominator on the status chip with no restart.
      reviews: this.reviewer.reviewCount(),
      reviewBudget: this.reviewer.budgetLimit(),
      budgetReached: this.reviewer.isBudgetReached(),
      delegated: this.delegated,
      usage: this.reviewer.sessionUsage(),
      // UNKNOWN PRICING IS NOT ZERO PRICING (C-11 / RV-4). The fast tier is
      // precisely where an unrecognised model id is likely, and rendering it as
      // `$0.00` would make the feature look free while it is spending money.
      pricingUnknown: ref ? !this.deps.isPricedModel(ref) : false,
      inFlight: this.reviewer.isReviewInFlight(),
    };
  }

  status(): FastStatus {
    return {
      registered: this.registered,
      enabled: this.enabled,
      tier: this.tier,
      snapshot: this.snapshot(),
    };
  }

  subscribe(listener: FastEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: FastEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // One bad subscriber must not take the run down with it — the rule
        // `TeamRuntime.emit` already states.
      }
    }
  }
}
