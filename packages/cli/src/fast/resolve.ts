/**
 * `resolveFastTier` — THE single authority on whether a fast tier exists and
 * what it points at (fast-model-tier §3.2).
 *
 * ASCII ONLY: `src/fast/**` is inside the glyph scanner's scope.
 *
 * EVERY CONSUMER READS THE TIER THROUGH THIS FUNCTION AND NOWHERE ELSE - the
 * controller, the subagent factory, the reviewer, `/fast`, the settings screen
 * and the status bar. Four call sites recomputing "is fast usable?" from raw
 * config keys is exactly how a UI ends up showing a chip for a tier that refuses
 * every call.
 *
 * IT IS ALSO RE-RUN ON EVERY CONFIG MUTATION, NOT ONCE (rule 8 / RV-3). Rules 2
 * and 6 make `fast.provider: ''` and `fast.baseUrl: ''` INHERIT from
 * `config.provider` / `config.baseUrl`, and rule 5 reads `apiKeys`. All of those
 * are live: `/model`, `/provider`, the settings screen's save, `/reload` and a
 * one-shot key edit each rewrite one of them mid-session. A tier resolved once
 * at construction is a tier that can be describing a provider the session no
 * longer uses.
 */

import type { ModelRole } from '../config/model-profiles.js';
import type { ModelRef } from '@aragon-agent/core';
import { isAdapterProvider, type CliConfig } from '../config/schema.js';
import type { FastTier } from './types.js';

/**
 * Resolve the fast tier from the CURRENT config.
 *
 * @param config The live effective config. Read fresh; never snapshot it.
 * @param hasKey `AgentController.hasApiKey`, which already resolves the
 *   config-file key, the provider environment variable and the one-shot
 *   `--api-key` override. Injected rather than reimplemented, because a second
 *   key resolver is a second answer to "why does it say no key?".
 */
export function resolveFastTier(
  config: CliConfig,
  hasKey: (providerId: string, role?: ModelRole) => boolean,
): FastTier {
  const fast = config.fast;

  // 1. The switch.
  if (!fast || fast.enabled !== true) return { ok: false, reason: 'disabled' };

  // 2. An empty provider INHERITS the main one. This is what makes `fast.model`
  //    alone a complete configuration for the overwhelmingly common case ("same
  //    vendor, cheaper model").
  const provider = fast.provider.trim().length > 0 ? fast.provider.trim() : config.provider;

  // 3. An empty model is NOT CONFIGURED, and deliberately does not inherit
  //    (D-4). Silently falling back to the main model would make R-e - opting in
  //    to fast == main, which is legal - indistinguishable from a typo.
  const modelId = fast.model.trim();
  if (modelId.length === 0) return { ok: false, reason: 'no_model' };

  // 4 / 5. Both are reported separately because they send the user to two
  //        different settings.
  if (!isAdapterProvider(provider)) return { ok: false, reason: 'no_adapter' };
  if (!hasKey(provider, 'fast')) return { ok: false, reason: 'no_key' };

  // 6. A fast tier on the SAME provider inherits the session's base URL: a user
  //    pointing the CLI at a gateway means both models, not one. A fast tier on
  //    a DIFFERENT provider does not, because that base URL belongs to another
  //    API and would be an immediate 404.
  const explicitBaseUrl = fast.baseUrl.trim();
  const baseUrl =
    explicitBaseUrl.length > 0
      ? explicitBaseUrl
      : config.modelProfiles?.fastId && !config.modelProfileState?.fast.invalid
      ? undefined
      : provider === config.provider
      ? config.baseUrl
      : undefined;

  const ref: ModelRef = {
    providerId: provider,
    modelId,
    ...(baseUrl ? { baseUrl } : {}),
  };

  return {
    ok: true,
    ref,
    thinkingLevel: fast.thinkingLevel,
    // 7. DISPLAY ONLY, and no branch anywhere may read it (R-13). "The two tiers
    //    resolve to the same model, so skip the work" is the tempting
    //    optimization that silently turns R-e into a no-op: the user is allowed
    //    to choose it, and the cost of the review is real either way.
    sameAsMain: provider === config.provider && modelId === config.model,
  };
}

/**
 * The one-line notice for a tier the user switched on that cannot resolve, or
 * `null` when there is nothing worth saying.
 *
 * `disabled` returns `null` - the tier being off because the user left it off is
 * not news. The other three are CONFIGURATION MISTAKES that are otherwise
 * completely invisible: nothing else in the session would ever mention them.
 */
export function describeFastTierProblem(tier: FastTier, provider: string): string | null {
  if (tier.ok) return null;
  switch (tier.reason) {
    case 'no_model':
      return 'fast.enabled is on but fast.model is empty - the fast tier is off. ' +
        'Set it with /fast model <id>.';
    case 'no_adapter':
      return `Provider "${provider}" has no adapter - the fast tier is off.`;
    case 'no_key':
      return `No API key for ${provider} - the fast tier is off.`;
    default:
      return null;
  }
}

/** The provider a tier resolution was about, for the notice above. */
export function fastProviderOf(config: CliConfig): string {
  const explicit = config.fast?.provider.trim() ?? '';
  return explicit.length > 0 ? explicit : config.provider;
}
