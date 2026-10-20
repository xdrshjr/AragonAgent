/**
 * Where the ACTIVE kit comes from, and the two places a session kit has to be
 * re-applied (agent-model-kits §4.3 / D-5 / D-6).
 *
 * ASCII ONLY - `src/config/**` is inside `glyphs.test.ts::inScope`.
 *
 * ONE TRUTH, PURELY DERIVED. `CliConfig` carries only `sessionKit: {id, held}`;
 * everything a surface prints about "which kit is running" comes out of
 * `resolveActiveKit(config)`. There is no `config.activeKit` field, because a
 * second copy of that answer is a copy that can disagree with the first.
 */

import { getLogger } from '../logging/logger.js';
import type { CliConfig, FastConfig, PersistedConfig, TeamConfig } from './schema.js';
import type { ModelProfilesConfig } from './model-profiles.js';
import { normalizeProfileBaseUrl, projectModelProfiles, resolveModelProfileState }
  from './model-profile-resolution.js';
import { findKit, kitCandidate, kitSlotConnections, type AgentKit, type KitConnection,
  type KitSlot, type SessionKitState } from './model-kits.js';

/** The three slots, in the order every surface prints them. */
export const ALL_SLOTS: readonly KitSlot[] = ['main', 'fast', 'subagent'];

/** The name the UI gives "no kit is in effect" (D-13). */
export const CURRENT_SETUP_NAME = 'Current setup';

/**
 * The answer when there is no kit, or when the host has no kit support at all.
 *
 * A CONSTANT SO CALLERS CANNOT INVENT A SECOND SHAPE: `App` needs one value that
 * renders "no chip, `Current setup` row" for a controller that predates this
 * port (a test double, an embedded host), and re-deriving it there would be a
 * second definition of "nothing".
 */
export const INACTIVE_KIT: ActiveKit = { source: 'none', id: null,
  name: CURRENT_SETUP_NAME, held: [], modified: false, driftReasons: [],
  missingProfiles: [] };

export interface ActiveKit {
  source: 'session' | 'default' | 'none';
  id: string | null;
  /** `Current setup` when `source === 'none'`. */
  name: string;
  /** `[]` when `source === 'none'`; all three for a default kit. */
  held: KitSlot[];
  /** The kit's definition and the live connections no longer agree (§4.8). */
  modified: boolean;
  /** Human-readable ASCII reasons, for `/kit` and the root row. */
  driftReasons: string[];
  /** Slots whose referenced profile is gone (RV-P1-1 / I-8). */
  missingProfiles: KitSlot[];
}

/** The session-kit runtime shape, owned by `model-kits.ts` and re-exported here. */
export type { SessionKitState } from './model-kits.js';

interface Drift {
  reasons: string[];
  missing: KitSlot[];
}

function driftOfMain(config: CliConfig, connection: KitConnection | null): string[] {
  if (!connection) return [];
  const changed: string[] = [];
  if (config.provider !== connection.provider) changed.push('provider');
  if (config.model !== connection.model) changed.push('model');
  if (normalizeProfileBaseUrl(config.baseUrl) !== normalizeProfileBaseUrl(connection.baseUrl)) {
    changed.push('endpoint');
  }
  return changed.length ? [`main: ${changed.join(', ')} changed`] : [];
}

function driftOfFast(config: CliConfig, kit: AgentKit, connection: KitConnection | null): string[] {
  if (kit.fastProfileId === null) {
    // D-8: this kit TURNS THE TIER OFF, so the endpoints are irrelevant - only
    // "is it on" can disagree. Comparing endpoints here would report drift for
    // every user who ever ran a fast tier before applying a fast-off kit.
    return config.fast.enabled ? ['fast: turned back on'] : [];
  }
  if (!connection) return [];
  const changed: string[] = [];
  if (!config.fast.enabled) changed.push('off');
  if (config.fast.provider !== connection.provider) changed.push('provider');
  if (config.fast.model !== connection.model) changed.push('model');
  if (normalizeProfileBaseUrl(config.fast.baseUrl)
    !== normalizeProfileBaseUrl(connection.baseUrl)) changed.push('endpoint');
  return changed.length ? [`fast: ${changed.join(', ')} changed`] : [];
}

function driftOfSubagent(config: CliConfig, kit: AgentKit, connection: string | null):
string[] {
  if (!connection) return [];
  const sameMode = config.team?.model === kit.subagent.model;
  const sameId = kit.subagent.model === 'profile'
    ? (config.team?.modelProfileId ?? null) === kit.subagent.modelProfileId : true;
  return sameMode && sameId ? [] : ['subagent: changed'];
}

function subagentConnection(config: CliConfig, kit: AgentKit): string | null {
  if (kit.subagent.model === 'profile') return kit.subagent.modelProfileId;
  return kit.subagent.model === 'main' ? 'main' : 'fast';
}

/** Build the verdict for a kit that exists, whatever installed it. */
function describe(config: CliConfig, library: ModelProfilesConfig, kit: AgentKit,
  source: 'session' | 'default', held: KitSlot[]): ActiveKit {
  const connections = kitSlotConnections(library, kit);
  const drift: Drift = { reasons: [], missing: [] };
  if (held.includes('main')) {
    if (!connections.main) drift.missing.push('main');
    else drift.reasons.push(...driftOfMain(config, connections.main));
  }
  if (held.includes('fast')) {
    if (kit.fastProfileId !== null && !connections.fast) drift.missing.push('fast');
    else drift.reasons.push(...driftOfFast(config, kit, connections.fast));
  }
  if (held.includes('subagent')) {
    const missingProfile = kit.subagent.model === 'profile' && !connections.subagent.name;
    if (missingProfile) drift.missing.push('subagent');
    else drift.reasons.push(...driftOfSubagent(config, kit, subagentConnection(config, kit)));
  }
  if (held.length < ALL_SLOTS.length) drift.reasons.push(`holds ${held.join('+') || 'nothing'}`);
  return { source, id: kit.id, name: kit.name, held: [...held],
    modified: held.length < ALL_SLOTS.length || drift.reasons.length > 0
      || drift.missing.length > 0,
    driftReasons: drift.reasons, missingProfiles: drift.missing };
}

/**
 * Which kit is in effect, and whether it has drifted (§4.8).
 *
 * Precedence is D-6's: session kit, then the persisted default, then the disk
 * bindings (which the UI calls `Current setup`).
 */
export function resolveActiveKit(config: CliConfig): ActiveKit {
  const library = config.modelProfiles;
  const state = config.sessionKit;
  const session = state ? findKit(library, state.id) : undefined;
  if (state && session) {
    const held = state.held.filter((slot): slot is KitSlot =>
      (ALL_SLOTS as readonly string[]).includes(slot));
    return describe(config, library!, session, 'session', held.length ? held : []);
  }
  const fallback = findKit(library, library?.defaultKitId ?? null);
  if (library && fallback) return describe(config, library, fallback, 'default', [...ALL_SLOTS]);
  return { source: 'none', id: null, name: CURRENT_SETUP_NAME, held: [], modified: false,
    driftReasons: [], missingProfiles: [] };
}

/**
 * The minimum a candidate has to offer for the held slots to be re-applied.
 *
 * STRUCTURAL, NOT `PersistedConfig`: the same routine serves a disk candidate on
 * its way to `liveCandidate` and a freshly reloaded `CliConfig`, and forcing
 * either through a cast at the call site would hide the fact that only these
 * three sections are ever written.
 */
export interface HeldTarget {
  modelProfiles?: ModelProfilesConfig;
  fast?: Partial<FastConfig>;
  team?: Partial<TeamConfig>;
}
function slotSurvives(library: ModelProfilesConfig, kit: AgentKit, slot: KitSlot): boolean {
  const ids = new Set(library.entries.map((entry) => entry.id));
  if (slot === 'main') return ids.has(kit.mainProfileId);
  if (slot === 'fast') return kit.fastProfileId === null || ids.has(kit.fastProfileId);
  return kit.subagent.model !== 'profile'
    || (!!kit.subagent.modelProfileId && ids.has(kit.subagent.modelProfileId));
}

/**
 * Re-apply the still-`held` slots of a session kit onto a candidate.
 *
 * THE RETURN VALUE MAY ONLY EVER FEED `liveCandidate`. It must NEVER be handed
 * to `commitModelSettings` (I-14 / RV-P0-1): "this session only" is a claim
 * about the FILE, and a held slot that reaches the commit turns one unrelated
 * save into a permanent, invisible change of the user's defaults. The one
 * caller is `prepareModelSettings` in `agent/model-profile-settings.ts`, which
 * keeps the two candidates in separate variables for exactly this reason.
 *
 * Slots whose kit, or whose referenced profile, disappeared are DROPPED and
 * reported, so the caller can log the release instead of silently forgetting it.
 */
export function applyHeldToLive<T extends HeldTarget>(
  candidate: T,
  sessionKit: SessionKitState | null | undefined,
): { candidate: T; dropped: KitSlot[] } {
  const heldIn = sessionKit?.held ?? [];
  if (!sessionKit || heldIn.length === 0) return { candidate, dropped: [] };
  const library = candidate.modelProfiles;
  const kit = findKit(library, sessionKit.id);
  if (!library || !kit) return { candidate, dropped: [...heldIn] };
  const held = heldIn.filter((slot) => slotSurvives(library, kit, slot));
  const dropped = heldIn.filter((slot) => !held.includes(slot));
  if (!held.length) return { candidate, dropped };
  const patch = kitCandidate({ library, kit });
  const next = {
    ...candidate,
    modelProfiles: { ...library,
      ...(held.includes('main') ? { mainId: kit.mainProfileId } : {}),
      ...(held.includes('fast') ? { fastId: kit.fastProfileId } : {}) },
  } as T;
  if (held.includes('subagent')) {
    next.team = { ...candidate.team, ...patch.team } as T['team'];
  }
  if (held.includes('fast')) {
    next.fast = { ...candidate.fast, enabled: kit.fastProfileId !== null } as T['fast'];
  }
  return { candidate: next, dropped };
}

/**
 * Keep a session kit alive across `Reload settings` (D-6).
 *
 * THE PROJECTION HAS TO BE RECOMPUTED, not just the bindings: `I-3` says a
 * library's projections never depend on whether a kit exists, so a live config
 * whose `mainId` says "kit" while `provider`/`model` still name the reloaded
 * file would break the equivalence every other surface relies on. Hence the
 * round trip through `projectModelProfiles` + `resolveModelProfileState`.
 */
export function carrySessionKit(input: { resolved: CliConfig; previous: CliConfig }): CliConfig {
  const state = input.previous.sessionKit;
  const { resolved } = input;
  if (!state) return resolved;
  const library = resolved.modelProfiles;
  const kit = findKit(library, state.id);
  if (!library || !kit) {
    getLogger().warn('config', 'session_kit_released', { reason: 'kit_missing' });
    return { ...resolved, sessionKit: undefined };
  }
  const applied = applyHeldToLive(resolved, state);
  const held = state.held.filter((slot) => !applied.dropped.includes(slot));
  if (!held.length) {
    getLogger().warn('config', 'session_kit_released', { reason: 'slots_dropped' });
    return { ...resolved, sessionKit: undefined };
  }
  const file = applied.candidate as unknown as Partial<PersistedConfig>;
  const projected = projectModelProfiles(file).file;
  const next: CliConfig = { ...resolved, modelProfiles: projected.modelProfiles };
  if (held.includes('main')) {
    next.provider = projected.provider!;
    next.model = projected.model!;
    next.baseUrl = projected.baseUrl ?? undefined;
    if (next.contextWindowOrigin !== 'env') {
      next.contextWindow = projected.contextWindow ?? null;
      next.contextWindowOrigin = next.contextWindow === null ? undefined : 'profile';
    }
  }
  if (held.includes('fast') && projected.fast) {
    next.fast = { ...next.fast, provider: projected.fast.provider ?? '',
      model: projected.fast.model ?? '', baseUrl: projected.fast.baseUrl ?? '' };
  }
  if (held.includes('subagent') && file.team) next.team = { ...next.team, ...file.team };
  next.modelProfileState = resolveModelProfileState(next);
  next.sessionKit = { id: kit.id, held };
  if (applied.dropped.length) {
    getLogger().warn('config', 'session_kit_slots_dropped', { slots: applied.dropped });
  }
  return next;
}
