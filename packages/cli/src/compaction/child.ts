/**
 * Per-child context compaction (context-auto-compaction-hardening §3.4 / W3).
 *
 * ASCII ONLY: `src/compaction/**` is inside the glyph scanner's scope.
 *
 * WHY THIS REVERSES D-15. That decision said children are bounded by their
 * dispatch timeout and turn cap, so giving them a manager only makes a dispatch's
 * cost unpredictable. The premise is measurable and false at the configured
 * bounds: `team.maxTurnsPerSubagent` is 24 and `team.dispatchTimeoutMs` is
 * 900 000, which is 24 turns over fifteen minutes - the same profile as the lead
 * run this feature exists for. The cost argument also inverts once the
 * alternative is priced: an overflow ENDS the dispatch, the lead pays for every
 * turn the child already ran, and receives one partial sentence for all of it.
 * Two fast-model summarizations is the cheap side of that trade.
 *
 * SINCE MAIN-AGENT PARITY, A CHILD MANAGER RUNS THE LEAD'S OWN POLICY. The only
 * overlay left is the CONNECTION (provider / model / base URL / manual window),
 * which must follow the model the child actually runs on. `keepRecentTurns`,
 * `onFailure`, `useFastTier`, `archive` and the per-run compaction bound are all
 * read from the SAME live config the lead reads, so a user who tunes compaction
 * tunes every child identically - the requirement "same mode and configuration
 * as the main agent", taken literally.
 *
 * THE INSTANCE BOUND stays (mechanism B of RV-2) because `maxPerRun` is
 * STRUCTURAL with no config path by design (`limits.ts` header); it is now the
 * SAME `COMPACTION_LIMITS.maxPerRun` the lead's own manager runs under.
 *
 * NO UI. A child's compaction produces no transcript card (DH-7): the lead's
 * transcript describes the LEAD's context, and a card there would claim the
 * lead's own history had been compacted. The team panel row and the dispatch
 * report are where a child's internals belong.
 */

import { resolveFastTier } from '../fast/resolve.js';
import type { ModelRole } from '../config/model-profiles.js';
import type {
  AssistantMessage,
  ContextManager,
  LLMRequest,
  Message,
  ModelInfo,
  ModelRef,
  TokenUsage,
} from '@aragon-agent/core';
import type { CliConfig } from '../config/schema.js';
import { getLogger } from '../logging/logger.js';
import { Compactor } from './compactor.js';
import { COMPACTION_LIMITS } from './limits.js';
import { ContextMeter } from './meter.js';
import { shouldCompactAt } from './pressure.js';
import type { CompactionBilling } from './types.js';

export interface ChildCompactionDeps {
  /** Read LIVE on every call - see `childConfig` below. */
  getConfig: () => CliConfig;
  hasKey: (providerId: string, role?: ModelRole) => boolean;
  getApiKey: (providerId: string, role?: ModelRole) => string | undefined;
  getModelInfoFor: (ref: Pick<ModelRef, 'providerId' | 'modelId'>) => ModelInfo;
  isPricedModel: (ref: Pick<ModelRef, 'providerId' | 'modelId'>) => boolean;
  /** The lead wiring's own transport, reused (D-10 stays true). */
  complete: (providerId: string, request: LLMRequest) => Promise<AssistantMessage>;
  /** Child compaction spend joins the session totals through the lead's sink. */
  onUsage: (usage: TokenUsage, billing?: CompactionBilling) => void;
}

/**
 * Everything one child manager needs about its child.
 *
 * AN OPTIONS OBJECT RATHER THAN FIVE POSITIONAL PARAMETERS - the rule
 * `TeamRuntime.RunOneCtx` states one package over, and this signature would sit
 * exactly on the cap.
 */
export interface ChildContextManagerRequest {
  role?: ModelRole;
  label: string;
  /**
   * The model the child actually runs on.
   *
   * CARRIED RATHER THAN READ FROM CONFIG, because a `tier: 'fast'` child runs on
   * a model whose context window is usually SMALLER than the lead's. Measuring a
   * child against the lead's window would put the trigger in the wrong place in
   * the one direction that matters - late.
   */
  model: ModelRef;
  /**
   * LAZY, AND IT MUST BE. `agentRef` is assigned AFTER the factory call returns,
   * so a non-lazy read here is `undefined` at construction and the child's
   * estimate branch would silently measure an empty history - CR-1 reproduced one
   * module over.
   */
  getMessages: () => readonly Message[];
  getSystemPrompt: () => string;
  onCompacted: () => void;
}

/**
 * A child manager, plus the one hook the port does not carry.
 *
 * `onTurnEnd` IS NOT PART OF `ContextManager` and is called by `subagent.ts` from
 * its existing `turn_end` case. Without it the child never records the history
 * length its last measurement covered, so W1's delta is permanently `undefined`
 * and the child reads the same systematically-short number the lead used to.
 */
export interface ChildContextManager extends ContextManager {
  onTurnEnd(usage: TokenUsage, messages: readonly Message[], systemPrompt: string): void;
  /** Settle only after Core has accepted or rejected the proposed history. */
  onCompactionEnd(verdict: {
    applied: boolean; reason?: string; tokensBefore: number; tokensAfter: number;
  }): void;
}

export type ChildContextManagerFactory = (
  req: ChildContextManagerRequest,
) => ChildContextManager;

/**
 * The shape `subagent.ts` is handed, which may DECLINE.
 *
 * `undefined` RATHER THAN A THROW OR A NO-OP MANAGER, and the difference is
 * AC-H10: the caller spreads the result conditionally, so a session with
 * `compaction.subagents: false` builds a child whose options bag has no
 * `contextManager` KEY AT ALL - the loop's gate then tests a genuinely absent
 * field. The decision is re-taken per child rather than per dispatch, so a
 * settings-screen edit mid-dispatch reaches the next one.
 */
export type ChildContextManagerProvider = (
  req: ChildContextManagerRequest,
) => ChildContextManager | undefined;

/** One manager per child. State is per-history and must not be shared. */
export function createChildContextManager(
  req: ChildContextManagerRequest,
  deps: ChildCompactionDeps,
): ChildContextManager {
  const log = getLogger().child('compaction');

  /**
   * MECHANISM A - the config view.
   *
   * IT RE-READS `deps.getConfig()` ON EVERY CALL and never closes over one
   * snapshot: a settings-screen edit mid-dispatch has to reach a running child,
   * which is the same reason `subagent.ts` reuses the lead's `getApiKey` closure
   * rather than the resolved key.
   *
   * `useFastTier` is read LIVE from the base config (main-agent
   * parity - no overlay): it expresses a PREFERENCE, not an outcome.
   * `resolveFastTier` still decides, and when nothing resolves the child
   * falls back exactly as the lead does - to its OWN model, because
   * `provider` / `model` are overlaid here too.
   * Failed summaries preserve the child's task just as they preserve the lead's.
   */
  const childConfig = (): CliConfig => {
    const base = deps.getConfig();
    const sameConnection = base.provider === req.model.providerId &&
      base.model === req.model.modelId && base.baseUrl === req.model.baseUrl;
    return {
      ...base,
      provider: req.model.providerId,
      model: req.model.modelId,
      baseUrl: req.model.baseUrl,
      // The lead's manual limit describes its connection, not every worker.
      contextWindow: sameConnection ? base.contextWindow : null,
      // NO POLICY OVERLAY (main-agent parity): `keepRecentTurns`, `onFailure`,
      // `useFastTier` and `archive` are read LIVE from the base config, so the
      // child compacts under exactly the policy the lead compacts under. A
      // settings-screen edit mid-dispatch reaches a running child because this
      // view is re-read on every call.
    };
  };

  const meter = new ContextMeter({
    getMessages: req.getMessages,
    getSystemPrompt: req.getSystemPrompt,
    getModelInfo: () => deps.getModelInfoFor(req.model),
    isWindowKnown: () => {
      const source = deps.getModelInfoFor(req.model).contextWindowSource;
      return source === undefined ? deps.isPricedModel(req.model) : source !== 'fallback';
    },
    getWindowOverride: () => childConfig().contextWindow,
  });
  let overflowNotified = false;

  const compactor = new Compactor(
    {
      getConfig: childConfig,
      meter,
      mainRole: req.role ?? 'main',
      resolveFastCandidate: () => resolveFastTier(deps.getConfig(), deps.hasKey),
      hasKey: deps.hasKey,
      getApiKey: deps.getApiKey,
      getModelInfoFor: deps.getModelInfoFor,
      isPricedModel: deps.isPricedModel,
      getMessages: req.getMessages,
      getSystemPrompt: req.getSystemPrompt,
      complete: deps.complete,
      emit: (event) => {
        if (event.type === 'usage') {
          deps.onUsage(event.usage, { modelRef: event.modelRef,
            costUsd: event.costUsd, pricingUnknown: event.pricingUnknown });
          return;
        }
        if (event.type !== 'compaction_end') return;
        // W3 HAS NO CARD, so this line is the whole record of a child compaction.
        log.info('compaction_child', {
          label: req.label,
          index: event.record.index,
          tokensBefore: event.record.tokensBefore,
          tokensAfter: event.record.tokensAfter,
          applied: event.record.applied,
          reason: event.record.reason,
        });
      },
      // A CHILD HAS NO TRANSCRIPT AND NOBODY WATCHING IT. `notify` on the lead's
      // channel would put a warning about a background worker's context in the
      // user's transcript with no card to explain which agent it is about.
      notify: () => {},
    },
    // MECHANISM B - the instance bound (RV-2 / DH-16). The SAME bound the
    // lead's own manager runs under (main-agent parity).
    { maxPerRun: COMPACTION_LIMITS.maxPerRun },
  );

  return {
    // THERE IS NO `/compact` FOR A CHILD, so nothing is ever queued and the
    // manual branch of `shouldCompact` is unreachable by construction.
    shouldCompact: (probe) => {
      const should = compactor.shouldCompact(probe);
      if (!should && probe.trigger === 'overflow' && !overflowNotified && childConfig().compaction.enabled) {
        const pressure = meter.current();
        if (Number.isFinite(pressure.occupied) && pressure.occupied >= 0 &&
            Number.isFinite(pressure.contextWindow) && pressure.contextWindow > 0 &&
            !shouldCompactAt(pressure, childConfig().compaction.threshold)) {
          overflowNotified = true;
          log.info('compaction_child', { label: req.label, reason: 'below_threshold' });
        }
      }
      return should;
    },
    compact: (ctx) => compactor.compact(ctx),
    onTurnEnd: (usage, messages, systemPrompt) =>
      compactor.onTurnEnd(usage, messages, systemPrompt),
    onCompactionEnd: (verdict) => {
      if (!compactor.settleOperation(verdict) || !verdict.applied) return;
      meter.onHistorySpliced();
      req.onCompacted();
    },
  };
}
