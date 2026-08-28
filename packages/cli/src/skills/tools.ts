/**
 * The three model-facing skill tools (spec §8.1 / §12.3).
 *
 *   skill          — Level 2 load (built in core; bound to the service here)
 *   skill_install  — install from an external source
 *   skill_create   — author a new skill from what the model just worked out
 *
 * D14 — SAME-TURN VISIBILITY. Both mutating tools end their success message
 * with the new skill's Level 1 catalog line. The system prompt is snapshotted
 * when the run starts (D2), so a skill installed on turn N is invisible in
 * `<available_skills>` until the NEXT `prompt()`. Without the inline line the
 * model installs something and then truthfully reports it cannot see it —
 * which reads to the user as a broken install.
 */

import {
  createSkillFindTool,
  createSkillTool,
  errorResult,
  textResult,
  type AgentTool,
} from '@aragon-agent/core';
import { createSkill, installSkill, type Initiator, type InstallResult } from './installer.js';
import type { SkillService } from './service.js';

const INSTALL_DESCRIPTION =
  'Install a new skill from a local directory, a git repository, or an https URL (a single ' +
  'SKILL.md or a .zip bundle). Use this when the user points you at a skill to install, or when a ' +
  'task clearly needs a capability that no listed skill covers and the user has given you a source. ' +
  'Requires user approval. Never install from a source the user did not provide.';

const CREATE_DESCRIPTION =
  'Author a NEW skill from scratch and save it to disk so it is available in this and future ' +
  'sessions. Use this after you have worked out a repeatable procedure worth reusing (the user ' +
  'asks to "remember how to do X", or you had to rediscover the same non-obvious steps twice). ' +
  'The description field must state both what the skill does and WHEN to use it.';

/** Shape the success message, ending with the D14 inline catalog entry. */
function successText(result: InstallResult, verb: 'Installed' | 'Created'): string {
  const lines = [
    `${verb} skill "${result.name}" (v${result.version ?? '0.0.0'}, ${result.scope} scope, ` +
      `${result.fileCount} files) at ${result.dir}.`,
    'It is available immediately in this conversation:',
  ];
  if (result.catalogLine) lines.push(result.catalogLine);
  lines.push(`Load it with skill(name="${result.name}").`);
  return lines.join('\n');
}

export function createSkillInstallTool(service: SkillService, installerVersion: string): AgentTool {
  return {
    name: 'skill_install',
    label: 'Install Skill',
    description: INSTALL_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          description:
            'Local dir/file path, git URL, github:owner/repo[/subdir][#ref], or an https URL to a SKILL.md or .zip.',
        },
        scope: {
          type: 'string',
          enum: ['user', 'project'],
          description: 'Where to install. Default: user.',
        },
        name: { type: 'string', description: 'Override the installed skill name (kebab-case).' },
      },
      required: ['source'],
    },
    async execute(_id, rawParams) {
      const params = rawParams as { source?: unknown; scope?: unknown; name?: unknown };
      const source = typeof params.source === 'string' ? params.source.trim() : '';
      if (source.length === 0) return errorResult('skill_install requires a "source" parameter.');

      const result = await installSkill(service, source, {
        ...(params.scope === 'project' || params.scope === 'user' ? { scope: params.scope } : {}),
        ...(typeof params.name === 'string' && params.name.trim().length > 0
          ? { name: params.name.trim() }
          : {}),
        initiator: 'agent' as Initiator,
        cwd: service.getCwdForInstall(),
        installer: installerVersion,
      });
      if (!result.ok) return errorResult(result.error ?? 'Installation failed.');
      return textResult(successText(result, 'Installed'));
    },
  };
}

export function createSkillCreateTool(service: SkillService, installerVersion: string): AgentTool {
  return {
    name: 'skill_create',
    label: 'Create Skill',
    description: CREATE_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'kebab-case skill name.' },
        description: {
          type: 'string',
          description:
            'What it does AND when to use it. This is the only text the model sees before loading the skill.',
        },
        body: { type: 'string', description: 'Markdown body of SKILL.md (no frontmatter).' },
        files: {
          type: 'array',
          description: 'Optional bundled files.',
          items: {
            type: 'object',
            properties: { path: { type: 'string' }, content: { type: 'string' } },
            required: ['path', 'content'],
          },
        },
        scope: { type: 'string', enum: ['user', 'project'] },
        activation: { type: 'string', enum: ['auto', 'manual'] },
      },
      required: ['name', 'description', 'body'],
    },
    async execute(_id, rawParams) {
      const p = rawParams as {
        name?: unknown;
        description?: unknown;
        body?: unknown;
        files?: unknown;
        scope?: unknown;
        activation?: unknown;
      };
      if (typeof p.name !== 'string' || typeof p.description !== 'string' || typeof p.body !== 'string') {
        return errorResult('skill_create requires "name", "description" and "body" strings.');
      }
      const files = Array.isArray(p.files)
        ? p.files.filter(
            (f): f is { path: string; content: string } =>
              !!f &&
              typeof (f as { path?: unknown }).path === 'string' &&
              typeof (f as { content?: unknown }).content === 'string',
          )
        : [];

      const result = await createSkill(
        service,
        {
          name: p.name.trim(),
          description: p.description.trim(),
          body: p.body,
          files,
          ...(p.scope === 'project' || p.scope === 'user' ? { scope: p.scope } : {}),
          ...(p.activation === 'manual' || p.activation === 'auto' ? { activation: p.activation } : {}),
          initiator: 'agent' as Initiator,
        },
        { cwd: service.getCwdForInstall(), installer: installerVersion },
      );
      if (!result.ok) return errorResult(result.error ?? 'Skill creation failed.');
      return textResult(successText(result, 'Created'));
    },
  };
}

/**
 * All four tools, in the order they appear in `/tools`.
 *
 * `skill_find` sits directly after `skill` so the two READ operations are
 * adjacent and the two MUTATING ones follow — the listing itself then reads as
 * the safety gradient it is.
 *
 * `update` is deliberately absent (D-A5): it is a maintenance action for the
 * user, not a capability for the model.
 */
export function createSkillTools(
  service: SkillService,
  installerVersion = '0.0.0',
  /**
   * Live tool names for the ceiling snapshot. Supplied by `AgentController`;
   * omitted by the one-shot `aragon skills` paths, where there is no agent and
   * therefore no policy line to render.
   */
  getRegisteredTools?: () => readonly string[],
): AgentTool[] {
  return [
    createSkillTool({
      registry: service.getRegistry(),
      loadBody: (name) => service.loadBody(name),
      bodyMaxBytes: service.getConfig().bodyMaxBytes,
      platform: service.platform(),
      // Called by the tool AFTER `enterFrame()`, so the snapshot includes the
      // skill being loaded — see the numbered sequence in `skill-tool.ts`.
      ...(getRegisteredTools
        ? { policySnapshot: () => service.toolPolicyView(getRegisteredTools) }
        : {}),
    }),
    createSkillFindTool({ registry: service.getRegistry() }),
    createSkillInstallTool(service, installerVersion),
    createSkillCreateTool(service, installerVersion),
  ];
}
