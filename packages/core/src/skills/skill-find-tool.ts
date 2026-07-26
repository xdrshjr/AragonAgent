/**
 * The `skill_find` tool — the escape hatch for a truncated Level 1 catalog
 * (spec §5.4 / D-A1).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THIS SEARCHES WHAT IS INSTALLED. IT NEVER TOUCHES THE NETWORK.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * The boundary is the whole point (D-A4). Iteration 1 deliberately shipped no
 * search tool, on the reasoning that the catalog already showed everything.
 * `SKILL_CATALOG_MAX_BYTES` is 6000 and a CJK description can cost 660 bytes a
 * line, so that premise fails at roughly ten skills — and when it fails, the
 * omitted skills become invisible to the model with no error anywhere (F1/F2).
 * This tool restores reachability for exactly that case and nothing more.
 *
 * If it ever returned installable-but-not-installed candidates, "the agent can
 * install skills" would quietly change meaning from "the user pointed at a
 * source and the model did the work" to "the model picks its own dependencies".
 * That is a different security model, and it is not this one.
 *
 * Pure logic, like `skill-tool.ts`: the registry is injected, and this module
 * imports no `node:*` (enforced by `no-host-coupling.test.ts`).
 */

import { errorResult, textResult } from '../tools/helpers.js';
import type { AgentTool } from '../tools/types.js';
import {
  SKILL_FIND_DEFAULT_LIMIT,
  SKILL_FIND_MAX_LIMIT,
  SKILL_FIND_MAX_TOKENS,
} from './constants.js';
import { renderSkillFindResults, suggestSkillNames } from './disclosure.js';
import type { SkillRegistry } from './skill-registry.js';
import type { SkillRecord } from './types.js';

export interface SkillFindToolDeps {
  registry: SkillRegistry;
  maxBytes?: number;
  defaultLimit?: number;
}

const DESCRIPTION =
  'Search the skills installed on this machine by name, description or keyword. Use this when the ' +
  'available-skills list says some skills were not shown, or when you suspect a skill exists for ' +
  'the task but you cannot see it. This searches ONLY what is already installed - it never reaches ' +
  'the network and never returns skills you could install. If nothing matches, ask the user for a ' +
  'source instead of inventing one.';

/**
 * Skills a search may return.
 *
 * `activation: manual` is excluded on purpose (D-A3). Manual means "do not put
 * this in front of the model; only the user may invoke it with `/<name>`".
 * Letting search surface it would silently downgrade that setting from an
 * exclusion to a ranking penalty, which is not what the author asked for.
 */
function searchable(registry: SkillRegistry): SkillRecord[] {
  return registry
    .list()
    .filter((r) => !r.disabled && !r.invalid && r.frontmatter.activation !== 'manual');
}

/** The haystack for one record: name, description and keywords, lowercased. */
function haystack(record: SkillRecord): string {
  return `${record.name} ${record.description} ${record.frontmatter.keywords.join(' ')}`.toLowerCase();
}

/**
 * Deterministic three-stage match; the first stage that yields anything wins.
 *
 * Stage 2 is AND across tokens, not OR. With OR, a query like "pdf form" would
 * drag in every skill whose description happens to contain "form" — and because
 * the result block has its own byte budget, the one skill the model actually
 * needed could be the entry that gets dropped off the end.
 */
export function matchSkills(query: string, records: SkillRecord[]): SkillRecord[] {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) return [];

  const exact = records.filter((r) => r.name.toLowerCase() === normalized);
  if (exact.length > 0) return exact;

  const tokens = normalized.split(/\s+/).filter(Boolean).slice(0, SKILL_FIND_MAX_TOKENS);
  if (tokens.length === 0) return [];
  return records.filter((r) => {
    const text = haystack(r);
    return tokens.every((token) => text.includes(token));
  });
}

export function createSkillFindTool(deps: SkillFindToolDeps): AgentTool {
  return {
    name: 'skill_find',
    label: 'Find Skill',
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Words describing the capability you need, e.g. "pdf form" or "deploy preview".',
        },
        limit: { type: 'integer', description: 'Max results. Default 10, max 25.' },
      },
      required: ['query'],
    },
    async execute(_id, rawParams) {
      const params = rawParams as { query?: unknown; limit?: unknown };
      const query = typeof params.query === 'string' ? params.query.trim() : '';
      if (query.length === 0) return errorResult('skill_find requires a "query" parameter.');

      const candidates = searchable(deps.registry);
      const matched = matchSkills(query, candidates);

      // Out-of-range limits are clamped rather than rejected: a model that asks
      // for 500 results wants "as many as you have", and failing the call would
      // cost a turn to relearn a bound it can simply be given.
      const requested =
        typeof params.limit === 'number' && Number.isFinite(params.limit)
          ? Math.floor(params.limit)
          : (deps.defaultLimit ?? SKILL_FIND_DEFAULT_LIMIT);
      const limit = Math.min(SKILL_FIND_MAX_LIMIT, Math.max(1, requested));

      // Stage 3: near-miss names, but only when the first two stages came up
      // empty — otherwise a good match would be diluted with guesses.
      const suggestions =
        matched.length === 0 ? suggestSkillNames(query, candidates.map((r) => r.name), 3) : [];

      return textResult(
        renderSkillFindResults(query, matched.slice(0, limit), {
          total: candidates.length,
          // The PRE-slice count, so `limit` shows up as "+N more matches not
          // shown" instead of quietly passing a truncated list off as the
          // complete one — which is the exact failure mode (F1) this tool was
          // added to undo, and it would be embarrassing to reintroduce here.
          matchedTotal: matched.length,
          ...(deps.maxBytes !== undefined ? { maxBytes: deps.maxBytes } : {}),
          suggestions,
        }),
      );
    },
  };
}
