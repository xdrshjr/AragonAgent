/**
 * `resolveSubagentModel` — THE single authority on which model a team child
 * runs (subagent-model-and-question-controls §3.3).
 *
 * ASCII ONLY: `src/team/**` is inside the glyph scanner's scope.
 *
 * EVERY CONSUMER READS THE CHILD'S MODEL THROUGH THIS FUNCTION AND NOWHERE
 * ELSE — `createSubagent`, the `task` report header, the settings root row and
 * `/team model` — following the `resolveFastTier` precedent one directory over:
 * four call sites each recomputing "which model do children run on?" from raw
 * config keys is exactly how the report ends up naming a model the children
 * silently fell back from.
 *
 * IT IS RE-RUN ON EVERY DISPATCH AND EVERY RENDER, NOT ONCE (rule 8 / RV-3 of
 * the fast tier, inherited here): `team.model`, the fast tier and the profile
 * library are all LIVE keys a settings save, `/fast off` or `/team model` can
 * rewrite mid-session. A resolution captured at construction would be a
 * resolution describing a session that no longer exists.
 *
 * A CHILD IS NEVER LEFT WITHOUT A MODEL (D-4). Every failure mode — fast tier
 * off, profile deleted, profile key missing — degrades to the MAIN connection
 * with a `fallbackReason`, so a dispatch cannot fail because its model setting
 * went stale. The reason is disclosed, never swallowed: the report header and
 * the settings summary line both render it.
 */

import type { ModelRef, ThinkingLevel } from '@aragon-agent/core';
import type { ModelProfile, ModelRole } from '../config/model-profiles.js';
import { resolveFastTier } from '../fast/resolve.js';
import type { CliConfig } from '../config/schema.js';

/** Which model children run on. `main` is the default and the historical behavior. */
export type SubagentModelMode = 'main' | 'fast' | 'profile';

/** Why a non-main request degraded to the main model (D-4 disclosure). */
export type SubagentFallbackReason =
  /** `team.model='fast'` but `resolveFastTier` is not ok (off, unconfigured, no key). */
  | 'fast_unavailable'
  /** `modelProfileId` is absent from the library (deleted, or never existed). */
  | 'profile_missing'
  /** The entry exists but carries no key of its own and the shared layer has none. */
  | 'profile_no_key';

/** In-memory resolution; recomputed per dispatch/render, never persisted (§6.3). */
export interface SubagentModelResolution {
  /** The user's requested mode, verbatim from config (UI highlight reads this). */
  mode: SubagentModelMode;
  /** The mode actually in effect; `'main'` whenever a fallback fired. */
  effective: SubagentModelMode;
  /** The connection children will use. On fallback, exactly the main connection. */
  ref: ModelRef;
  /** main/profile take `config.thinkingLevel`; fast takes `config.fast.thinkingLevel`. */
  thinkingLevel: ThinkingLevel;
  /** The role controller key resolution uses: main/profile `'main'`, fast `'fast'`. */
  keyRole: ModelRole;
  /** The profile entry a `profile` request hit, dedicated key included; else null. */
  profile: ModelProfile | null;
  /** Present only when `effective !== mode`. */
  fallbackReason?: SubagentFallbackReason;
}

/** The `AgentController.hasApiKey` shape, injected so there is one key resolver. */
export type HasApiKey = (providerId: string, role?: ModelRole) => boolean;

/** The lead-layer key resolver `resolveSubagentKey` falls back to. */
export type SharedKeyResolver = (providerId: string, role: ModelRole) => string | undefined;

function mainRef(config: CliConfig): ModelRef {
  return {
    providerId: config.provider,
    modelId: config.model,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
  };
}

function fallbackToMain(
  config: CliConfig,
  mode: SubagentModelMode,
  fallbackReason: SubagentFallbackReason,
): SubagentModelResolution {
  // THE ALWAYS-USABLE ANSWER (D-4): whatever the user asked for that could not
  // resolve, the caller still gets a working connection — the same provider,
  // model, base URL and thinking level the lead itself runs on.
  return {
    mode,
    effective: 'main',
    ref: mainRef(config),
    thinkingLevel: config.thinkingLevel,
    keyRole: 'main',
    profile: null,
    fallbackReason,
  };
}

/**
 * Resolve the model every child of the NEXT dispatch will run on.
 *
 * Pure, synchronous, no IO — testable as a matrix over config fixtures.
 *
 * @param config The live effective config. Read fresh; never snapshot it.
 * @param hasKey `AgentController.hasApiKey`, which already resolves the
 *   config-file key, the provider environment variable and the one-shot
 *   `--api-key` override. Injected rather than reimplemented for the reason
 *   `resolveFastTier` records: a second key resolver is a second answer to
 *   "why does it say no key?".
 */
export function resolveSubagentModel(
  config: CliConfig,
  hasKey: HasApiKey,
): SubagentModelResolution {
  // `clampTeamConfig` guarantees the enum on every read and write path, so the
  // default `'main'` here is belt-and-braces rather than a real branch.
  const mode = config.team.model ?? 'main';

  if (mode === 'fast') {
    const tier = resolveFastTier(config, hasKey);
    if (tier.ok) {
      return {
        mode,
        effective: 'fast',
        ref: tier.ref,
        thinkingLevel: config.fast.thinkingLevel,
        keyRole: 'fast',
        profile: null,
      };
    }
    return fallbackToMain(config, mode, 'fast_unavailable');
  }

  if (mode === 'profile') {
    // A missing library, a missing id and a dangling id are one outcome
    // (D-4): degrade to main and say so. Reference EXISTENCE is deliberately
    // not validated in `clampTeamConfig` — resolution is where it belongs.
    const id = config.team.modelProfileId;
    const entry = id
      ? config.modelProfiles?.entries.find((candidate) => candidate.id === id)
      : undefined;
    if (!entry) return fallbackToMain(config, mode, 'profile_missing');
    // The dedicated entry key wins; without one the shared layer must have a
    // key for the entry's provider, or the child could not authenticate at all.
    if (!entry.apiKey && !hasKey(entry.provider, 'main')) {
      return fallbackToMain(config, mode, 'profile_no_key');
    }
    return {
      mode,
      effective: 'profile',
      ref: {
        providerId: entry.provider,
        modelId: entry.model,
        ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
      },
      thinkingLevel: config.thinkingLevel,
      keyRole: 'main',
      profile: entry,
    };
  }

  return {
    mode: 'main',
    effective: 'main',
    ref: mainRef(config),
    thinkingLevel: config.thinkingLevel,
    keyRole: 'main',
    profile: null,
  };
}

/**
 * The key a CHILD resolves for a provider, profile-aware (§3.3 / I-4).
 *
 * A profile's dedicated key is visible ONLY here: it never reaches env,
 * `config.apiKeys` or a log line. While the resolution's profile is bound and
 * the provider matches it, the entry key takes priority over the shared layer;
 * every other provider (and every non-profile mode) resolves through the
 * lead's own resolver at `resolution.keyRole` — which is what keeps a `fast`
 * child entitled to the fast-role key and a `main` child to the main one.
 *
 * @param config The live config (carried for parity with the resolver pair).
 * @param resolution A fresh `resolveSubagentModel` output.
 * @param providerId The provider the child needs a key for.
 * @param shared The lead-layer resolver (`controller.resolveKey`).
 */
export function resolveSubagentKey(
  config: CliConfig,
  resolution: SubagentModelResolution,
  providerId: string,
  shared: SharedKeyResolver,
): string | undefined {
  void config; // parity parameter: the pair reads one config, the key does not need it
  if (resolution.profile && providerId === resolution.ref.providerId) {
    return resolution.profile.apiKey ?? shared(providerId, 'main');
  }
  return shared(providerId, resolution.keyRole);
}
