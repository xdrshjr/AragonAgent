/**
 * `normalizeSubagentSpecs` — pure repair of whatever the model put in the `task`
 * call (team-subagents §3.3.1).
 *
 * ASCII ONLY: `src/team/**` is inside the glyph scanner's scope.
 *
 * MODELLED DIRECTLY ON `human-input.ts::normalizeQuestions`, INCLUDING THE
 * REASON IT EXISTS. The JSON Schema declares SHAPE, not POLICY: `type` and
 * `required` stay in the schema because a `subagents` value that is not an array
 * has nothing for a normalizer to repair. Every BOUND lives in the tool's
 * `description` (which is what the model reads) and is enforced here (which is
 * deterministic and unit-tested). Putting `maxItems: 10` in the schema instead
 * would behave differently depending on whether `ajv` — an OPTIONAL dependency
 * of `@aragon-agent/core` — happened to install: present, the executor rejects an
 * eleven-spec call outright and these rules are dead code; absent, the same call
 * sails straight through to here. One design, two behaviours, selected by
 * whether an optional install step succeeded.
 *
 * NEVER THROWS. Zero survivors is the caller's single hard failure.
 */

import { TEAM_LIMITS } from './limits.js';
import type { SubagentSpec } from './types.js';

export interface NormalizedSpecs {
  specs: SubagentSpec[];
  /** How many entries the model asked for, before dropping and capping. */
  requested: number;
  /**
   * Specs that asked for `model:"fast"` and were downgraded to `main`
   * (fast-model-tier §3.4 / R-6).
   *
   * ADDITIVE: `NormalizedSpecs` GAINS a field, it does not change one, so every
   * existing caller and test compiles unchanged.
   */
  downgraded: number;
}

/** Options for the fast tier. Optional for the reason `normalizeSubagentSpecs`
 *  documents below (RV-14). */
export interface NormalizeOptions {
  /**
   * §3.3's LIVE predicate, evaluated at DISPATCH time (RV-3).
   *
   * `fast.delegate: false` and "the tier stopped resolving twenty minutes ago"
   * are the same observable to the model — a downgrade, counted and reported —
   * which is the honest reading of both.
   */
  fastAvailable?: boolean;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function clamp(text: string, maxChars: number): string {
  const trimmed = text.trim();
  return trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed;
}

/**
 * Slugify a label to `[a-z0-9-]{1,12}`. An empty result falls back to the
 * positional default so a child is never nameless in the panel.
 */
function slugLabel(raw: unknown, index: number): string {
  const slug = asString(raw)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, TEAM_LIMITS.labelChars);
  return slug.length > 0 ? slug : `a${index + 1}`;
}

/**
 * Make `label` unique within the dispatch, case-insensitively, by appending
 * `-2`, `-3`, ...
 *
 * Two agents the user cannot tell apart in the panel is worse than an ugly
 * label, and the bus addresses children BY label — a duplicate would make
 * `team_send` ambiguous, which is a correctness problem rather than a cosmetic
 * one.
 */
function dedupeLabel(label: string, taken: Set<string>): string {
  const base = label.toLowerCase();
  if (!taken.has(base)) {
    taken.add(base);
    return label;
  }
  for (let n = 2; n < 100; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${label.slice(0, TEAM_LIMITS.labelChars - suffix.length)}${suffix}`;
    if (!taken.has(candidate.toLowerCase())) {
      taken.add(candidate.toLowerCase());
      return candidate;
    }
  }
  taken.add(base);
  return label;
}

/**
 * Repair and bound a raw `subagents` array.
 *
 * DROP FIRST, CAP SECOND. Capping first would let a blank entry consume a slot
 * the model meant for real work — the fan-out would silently be one narrower
 * than the model believed, and nothing would say so.
 *
 * @param raw   Whatever arrived in `params.subagents`.
 * @param max   The resolved `team.maxSubagents`; further clamped to
 *              `TEAM_LIMITS.hardMaxSubagents` here so a hand-edited config file
 *              cannot raise the requirement's ceiling (R-g).
 * @param opts  Fast-tier availability. OPTIONAL, DEFAULTING TO `false` (RV-14):
 *              this function and `NormalizedSpecs` are both exported and both
 *              have existing callers and tests, so a required third parameter
 *              would be a breaking edit that buys nothing — and an omitted one
 *              now means exactly what a pre-feature build meant.
 */
export function normalizeSubagentSpecs(
  raw: unknown,
  max: number,
  opts: NormalizeOptions = {},
): NormalizedSpecs {
  if (!Array.isArray(raw)) return { specs: [], requested: 0, downgraded: 0 };
  const requested = raw.length;
  const fastAvailable = opts.fastAvailable === true;

  const kept: SubagentSpec[] = [];
  const taken = new Set<string>();
  /** Parallel to `kept`: did entry `i` ask for the fast tier? */
  const wantedFast: boolean[] = [];

  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    if (!item || typeof item !== 'object') continue;
    const src = item as Record<string, unknown>;

    const description = clamp(asString(src.description), TEAM_LIMITS.descriptionChars);
    if (description.length === 0) continue;
    const prompt = clamp(asString(src.prompt), TEAM_LIMITS.promptChars);
    if (prompt.length === 0) continue;

    // REPAIR, NEVER REJECT — this file's own contract. `'fast'` without
    // availability becomes `'main'` AND IS COUNTED; anything else (a typo, a
    // model id, `undefined`) is simply `'main'` and is NOT counted, because the
    // model did not ask for the fast tier and has nothing to be told about.
    const wantsFast = src.model === 'fast';
    wantedFast.push(wantsFast);
    kept.push({
      label: dedupeLabel(slugLabel(src.label, kept.length), taken),
      description,
      prompt,
      readOnly: src.readOnly === true,
      tier: wantsFast && fastAvailable ? 'fast' : 'main',
    });
  }

  const ceiling = Math.max(1, Math.min(Math.floor(max) || 1, TEAM_LIMITS.hardMaxSubagents));
  const specs = kept.slice(0, ceiling);
  // COUNTED OVER THE SURVIVORS, not over everything the model wrote: a spec the
  // cap dropped never ran at all, so reporting it as "ran on the main model"
  // would be a second, different lie in a line that exists to stop the first.
  const downgraded = specs.filter(
    (spec, i) => spec.tier === 'main' && wantedFast[i] === true,
  ).length;
  return { specs, requested, downgraded };
}
