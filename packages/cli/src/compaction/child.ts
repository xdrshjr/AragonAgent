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
 * A CHILD MANAGER IS THE SAME `Compactor` UNDER A DIFFERENT POLICY, and the
 * overlay needs TWO mechanisms rather than one (RV-2):
 *
 *   A. A CONFIG VIEW, for `keepRecentTurns` / `onFailure` / `useFastTier`, which
 *      `Compactor` reads through `deps.getConfig()`.
 *   B. AN INSTANCE BOUND, for `maxPerRun`, which is STRUCTURAL and has no config
 *      path by design (`limits.ts` header). Without it the child silently
 *      inherits the lead's 5 - two and a half times the bound the reversal above
 *      rests on.
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
  onUsage: (usage: TokenUsage) => void;
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
   * `useFastTier: true` EXPRESSES A PREFERENCE, NOT AN OUTCOME. `resolveFastTier`
   * still decides, and when nothing resolves the child falls back exactly as the
   * lead does - to its OWN model, because `provider` / `model` are overlaid here
   * too.
   *
   * `onFailure: 'truncate'` IS FORCED because a child that stops is a failed
   * dispatch and the user is not there to intervene.
   */
  const childConfig = (): CliConfig => {
    const base = deps.getConfig();
    return {
      ...base,
      provider: req.model.providerId,
      model: req.model.modelId,
      baseUrl: req.model.baseUrl,
      compaction: {
        ...base.compaction,
        keepRecentTurns: COMPACTION_LIMITS.childKeepRecentTurns,
        onFailure: 'truncate',
        useFastTier: true,
        // ONE ARCHIVE PER LEAD COMPACTION IS AUDITABLE; TWENTY PER DISPATCH IS
        // NOISE. The child's dropped slice is therefore never retained either -
        // `runCompaction` reads this key before it stashes anything.
        archive: false,
      },
    };
  };

  const compactor = new Compactor(
    {
      getConfig: childConfig,
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
          deps.onUsage(event.usage);
          return;
        }
        if (event.type !== 'compaction_end') return;
        // DEFENCE IN DEPTH SINCE quiet-noop D-8: a child compaction that declines
        // before committing to work no longer emits this event at all, so this
        // filter is now unreachable on that path. It is retained deliberately -
        // it is this tree's own record that a no-op compaction is a non-event, and
        // deleting it would make the child depend on that rule holding forever.
        if (!event.record.applied && event.record.mode === 'none') return;
        req.onCompacted();
        // W3 HAS NO CARD, so this line is the whole record of a child compaction.
        log.info('compaction_child', {
          label: req.label,
          index: event.record.index,
          tokensBefore: event.record.tokensBefore,
          tokensAfter: event.record.tokensAfter,
        });
      },
      // A CHILD HAS NO TRANSCRIPT AND NOBODY WATCHING IT. `notify` on the lead's
      // channel would put a warning about a background worker's context in the
      // user's transcript with no card to explain which agent it is about.
      notify: () => {},
    },
    // MECHANISM B - the instance bound (RV-2 / DH-16).
    { maxPerRun: COMPACTION_LIMITS.childMaxPerRun },
  );

  return {
    // THERE IS NO `/compact` FOR A CHILD, so nothing is ever queued and the
    // manual branch of `shouldCompact` is unreachable by construction.
    shouldCompact: (probe) => compactor.shouldCompact(probe),
    compact: (ctx) => compactor.compact(ctx),
    onTurnEnd: (usage, messages, systemPrompt) =>
      compactor.onTurnEnd(usage, messages, systemPrompt),
  };
}
