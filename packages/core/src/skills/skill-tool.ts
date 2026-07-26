/**
 * The `skill` tool — Level 2 of progressive disclosure (spec §5.2).
 *
 * WHY A TOOL RESULT AND NOT A SYSTEM-PROMPT REWRITE (D2): `Agent.prompt()`
 * snapshots `this.systemPrompt` when the loop starts, so mutating it mid-run is
 * a no-op for the current turn. A tool result, by contrast, enters the message
 * history immediately, survives `/save` + `/resume` for free, and costs nothing
 * on turns where no skill is used.
 *
 * NAMING (D4): lowercase `skill`, matching the seven existing snake_case tools,
 * rather than Claude Code's `Skill`. The catalog block spells out the mapping so
 * community skills that say "call the Skill tool" still resolve.
 */

import { errorResult, textResult } from '../tools/helpers.js';
import type { AgentTool } from '../tools/types.js';
import { renderSkillBody, suggestSkillNames } from './disclosure.js';
import type { SkillRegistry } from './skill-registry.js';
import type { SkillFileRef, SkillPlatform, SkillPolicyView } from './types.js';

export interface SkillToolDeps {
  registry: SkillRegistry;
  /**
   * Read SKILL.md + list bundled files for a skill.
   * MAY THROW — the Node host wraps sync fs calls (§10.1 error contract), so
   * `execute()` below owns the try/catch. "Never throws" is the TOOL's promise.
   */
  loadBody: (name: string) => { body: string; files: SkillFileRef[] };
  bodyMaxBytes?: number;
  resultMaxBytes?: number;
  /**
   * Take a policy snapshot for the ceiling line in the rendered body.
   * `undefined` (the port, or its return value) means "render no policy line".
   *
   * MUST BE CALLED AFTER `enterFrame(name)` — see the numbered sequence in
   * `execute()`. The skill being loaded is itself one of the ceiling's sources,
   * so a snapshot taken first would print a permitted set missing the very
   * tools this skill just granted: the one wrong answer a model would act on
   * without hesitating.
   */
  policySnapshot?: () => SkillPolicyView | undefined;
  /** Host shell family for the Level 3 guidance (D-G14; core never reads `process`). */
  platform?: SkillPlatform;
}

const DESCRIPTION =
  'Load the full instructions of an installed skill before doing work it covers. ' +
  'Pick the exact name from <available_skills>. Returns the skill body plus a list of ' +
  'bundled files you can then read with read_file or run with bash. ' +
  'Loading a skill is cheap - prefer it over re-deriving a procedure yourself.';

export function createSkillTool(deps: SkillToolDeps): AgentTool {
  return {
    name: 'skill',
    label: 'Skill',
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Exact skill name from <available_skills>.' },
        arguments: { type: 'string', description: 'Optional free-form arguments for the skill.' },
        force: {
          type: 'boolean',
          description:
            'Re-send the full body even if this skill was already loaded in this conversation. ' +
            'Only needed if you cannot find the earlier copy.',
        },
      },
      required: ['name'],
    },
    async execute(_id, rawParams) {
      const params = rawParams as { name?: unknown; arguments?: unknown; force?: unknown };
      const name = typeof params.name === 'string' ? params.name.trim() : '';
      if (name.length === 0) return errorResult('skill requires a "name" parameter.');

      const record = deps.registry.get(name);
      if (!record) {
        const suggestions = suggestSkillNames(name, deps.registry.names());
        const hint = suggestions.length > 0 ? ` Did you mean: ${suggestions.join(', ')}?` : '';
        return errorResult(`Unknown skill "${name}".${hint} Run /skills to list all.`);
      }
      if (record.disabled) {
        return errorResult(`Skill "${name}" is disabled. Enable it with /skills enable ${name}.`);
      }
      if (record.invalid) {
        const first = record.issues.find((i) => i.level === 'error');
        return errorResult(
          `Skill "${name}" failed validation: ${first ? `${first.code} - ${first.message}` : 'unknown error'}.`,
        );
      }

      // The single place where a host-side throw is converted into a diagnosable
      // tool error. The engine would otherwise turn it into a generic stack trace.
      let loaded: { body: string; files: SkillFileRef[] };
      try {
        loaded = deps.loadBody(name);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResult(`Could not read SKILL.md for "${name}": ${message}`);
      }

      // ── The order below is load-bearing; do not reorder (§7.2). ──────────
      // 1. Hydrate.
      record.body = loaded.body;
      record.files = loaded.files;
      // 2. Record the session-level load and learn whether it is a repeat.
      const alreadyLoaded = deps.registry.activate(name);
      // 3. Enter the frame BEFORE step 4 — this skill is one of the ceiling's
      //    own sources, and a digest counts as a "I am using this" statement
      //    just as much as a full load does, so the ceiling applies either way.
      deps.registry.enterFrame(name);
      // 4. Only now is a policy snapshot truthful.
      const policy = deps.policySnapshot?.();
      // 5. Repeat loads get the digest unless the model explicitly asks otherwise.
      const force = params.force === true;
      const mode = alreadyLoaded && !force ? 'digest' : 'full';

      const args = typeof params.arguments === 'string' ? params.arguments : '';
      // 6. Render.
      return textResult(
        renderSkillBody(record, {
          ...(deps.bodyMaxBytes !== undefined ? { bodyMaxBytes: deps.bodyMaxBytes } : {}),
          ...(deps.resultMaxBytes !== undefined ? { resultMaxBytes: deps.resultMaxBytes } : {}),
          // The legacy one-line hint belongs to the full re-send only; the digest
          // states the same fact in its own opening line.
          ...(mode === 'full' && alreadyLoaded ? { alreadyLoaded: true } : {}),
          mode,
          ...(policy ? { policy } : {}),
          ...(deps.platform ? { platform: deps.platform } : {}),
          ...(args.length > 0 ? { arguments: args } : {}),
        }),
      );
    },
  };
}
