/**
 * `/skills …` management commands and the dynamic `/<skill-name>` registrations
 * (spec §7.1 / §7.2).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  computeToolPolicy,
  rankCatalogRecords,
  renderSkillInvocation,
  type SkillRecord,
  type SkillScope,
  type ToolPolicyDecision,
} from '@aragon-agent/core';
import { resolveDeclaredTool } from '@aragon-agent/core/skills';
import { installSkill, removeSkill, renderSkillMarkdown } from '../skills/installer.js';
import { writableRootFor } from '../skills/installer.js';
import { checkManifest } from '../skills/manifest.js';
import type { SkillService } from '../skills/service.js';
import { updateAllSkills, updateSkill, isHardFailure } from '../skills/updater.js';
import { currentPlatform } from '../skills/node-host.js';
import { listUsage, resetUsage, getUsagePath } from '../skills/usage.js';
import { HOST_TOOL_NAMES, SKILL_TOOL_FLOOR } from '../tools/index.js';
import { SKILLS_TOOL_POLICY_MODES, isSkillsToolPolicyMode } from '../config/schema.js';
import { pickGlyphs, type Glyphs } from '../ui/glyphs.js';
import { CommandRegistry, type CommandContext, type SlashCommand } from './registry.js';

/**
 * Status marks for `/skills`, taken from the shared glyph table rather than
 * written inline (§4.1 tier B, enforced by `glyphs.test.ts`). A legacy
 * `cmd.exe` renders a hardcoded U+2713 as mojibake, and this listing is exactly
 * the kind of dense column output where that is unreadable.
 */
interface Marks {
  ok: string;
  disabled: string;
  invalid: string;
  shadowed: string;
}

function marksFor(ctx: CommandContext): { marks: Marks; glyphs: Glyphs } {
  const cfg = ctx.controller.getConfig();
  const glyphs = pickGlyphs({ colorLevel: cfg.colorLevel ?? 0, unicode: cfg.unicode ?? false });
  return {
    glyphs,
    marks: {
      ok: glyphs.check,
      disabled: glyphs.times,
      invalid: glyphs.warn,
      shadowed: '~',
    },
  };
}

function markFor(record: SkillRecord, marks: Marks): string {
  if (record.invalid) return marks.invalid;
  if (record.disabled) return marks.disabled;
  return marks.ok;
}

function shortDescription(record: SkillRecord, max = 60, ellipsis = '...'): string {
  const one = record.description.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - ellipsis.length)}${ellipsis}` : one;
}

function formatRow(record: SkillRecord, marks: Marks, glyphs: Glyphs): string {
  const shadow =
    record.shadowed.length > 0 ? `  ${marks.shadowed}shadowed by ${record.shadowed[0]!.scope}` : '';
  // Spelled out rather than folded into the mark column: `!` there already means
  // "failed validation", and conflating "broken" with "you edited this" would
  // send the user looking for a problem that does not exist.
  const modified = record.integrity === 'modified' ? '  !modified' : '';
  return (
    `${markFor(record, marks)} ${record.name.padEnd(24)} ${record.frontmatter.version.padEnd(8)} ` +
    `${record.scope.padEnd(8)} ${shortDescription(record, 60, glyphs.ellipsis)}${modified}${shadow}`
  );
}

function parseScopeFlag(args: string): { rest: string; scope?: SkillScope } {
  const match = /--scope[= ](user|project)\b/.exec(args);
  if (!match) return { rest: args.trim() };
  return { rest: args.replace(match[0], '').trim(), scope: match[1] as SkillScope };
}

// ---------------------------------------------------------------------------
// /skills
// ---------------------------------------------------------------------------

async function runSkills(ctx: CommandContext, service: SkillService, version: string): Promise<void> {
  const [sub, ...rest] = ctx.args.trim().split(/\s+/).filter((s) => s.length > 0);
  const argument = rest.join(' ');

  switch (sub) {
    case undefined:
      return listSkills(ctx, service);
    case 'list':
      return listSkills(ctx, service, argument);
    case 'info':
      return infoSkill(ctx, service, argument);
    case 'install':
      return installFromCommand(ctx, service, argument, version);
    case 'update':
      return updateFromCommand(ctx, service, argument, version);
    case 'remove':
      return removeFromCommand(ctx, service, argument);
    case 'enable':
    case 'disable':
      return toggleSkill(ctx, service, argument, sub === 'disable');
    case 'reload': {
      const result = service.reload();
      ctx.toast('success', `Reloaded ${result.records.length} skills.`);
      return;
    }
    case 'create':
      return scaffoldSkill(ctx, service, argument);
    case 'trust':
    case 'untrust':
      return trustFromCommand(ctx, service, argument, sub === 'untrust');
    case 'policy':
      return policyFromCommand(ctx, service, argument);
    case 'unload':
      return unloadFrames(ctx, service);
    case 'usage':
      return usageFromCommand(ctx, service, argument);
    default:
      ctx.notify(
        'warn',
        `Unknown subcommand "/skills ${sub}". Try: list, info, install, update, remove, enable, ` +
          'disable, reload, create, trust, untrust, policy, unload, usage.',
      );
  }
}

// ---------------------------------------------------------------------------
// /skills policy · unload · usage  (§5.5 / §9)
// ---------------------------------------------------------------------------

/**
 * What the frame's declarations actually amount to, for display only.
 *
 * DERIVED FROM `computeToolPolicy`, NOT FROM THE RAW FRONTMATTER. The two answers
 * differ in exactly the cases that matter: `skills.toolPolicy=off` enforces
 * nothing at all, and a single unresolvable tool name waives a whole declaration
 * (D-G4). Reading `allowedTools` directly would print "Tool ceiling this turn: …"
 * for a ceiling nobody is applying — the same overclaim `/skills info` was
 * rewritten to stop making (P0-3 / RG3), and it would contradict the
 * `NOT ENFORCEABLE` line that `info` prints for the very same skill.
 *
 * Resolved against `HOST_TOOL_NAMES` like `doctor` and `info` (P1-8): this is a
 * statement about what a declaration means, so it must not change depending on
 * whether this process happens to have an agent attached.
 */
function ceilingDecision(service: SkillService): ToolPolicyDecision {
  const frame = service
    .frameNames()
    .map((name) => service.get(name))
    .filter((record): record is SkillRecord => record !== undefined);
  // `computeToolPolicy` drops disabled / invalid / `activation: always` records
  // itself, so there is no second copy of that rule here.
  return computeToolPolicy({
    frame,
    registered: HOST_TOOL_NAMES,
    floor: SKILL_TOOL_FLOOR,
    mode: service.effectiveToolPolicy().mode,
  });
}

/** `read_file, write_file (+ read-only) - from pdf-forms`, or `''` when unconstrained. */
function ceilingSummary(service: SkillService): string {
  return summarizeCeiling(ceilingDecision(service));
}

function summarizeCeiling(decision: ToolPolicyDecision): string {
  if (decision.allowed === null) return '';
  const granted = [...new Set(decision.sources.flatMap((s) => s.granted))].sort((a, b) =>
    a.localeCompare(b, 'en'),
  );
  // A declaration naming only tools this host lacks still imposes a ceiling — the
  // floor and nothing else. Saying so beats printing a bare "(+ read-only)".
  const list = granted.length > 0 ? `${granted.join(', ')} (+ read-only)` : 'read-only tools only';
  return `${list} - from ${decision.sourceNames.join(', ')}`;
}

/**
 * `/skills policy [off|warn|enforce]`.
 *
 * Writing BOTH the session slot and the config file is the whole point (P1-1).
 * Persisting only would leave a `--skill-tool-policy` run unchanged, and the
 * refusal message that sent the user here names this exact command — so the
 * override is also announced when it actually overrode something.
 */
function policyFromCommand(ctx: CommandContext, service: SkillService, argument: string): void {
  const requested = argument.trim();
  const current = service.effectiveToolPolicy();

  if (requested.length === 0) {
    const decision = ceilingDecision(service);
    const ceiling = summarizeCeiling(decision);
    ctx.notify(
      'info',
      [
        `Tool policy: ${current.mode} (from ${current.from})`,
        ceiling ? `Tool ceiling this turn: ${ceiling}` : 'No tool ceiling in effect this turn.',
        // Naming the waived skills matters here: "no ceiling because nothing
        // declared anything" and "no ceiling because a name is misspelled" look
        // identical otherwise, and only the second one is a bug to go and fix.
        ...decision.ignored.map(
          (entry) =>
            `  Not enforceable: "${entry.name}" declares unknown tools ` +
            `(${entry.unresolved.join(', ')}).`,
        ),
        `Usage: /skills policy ${SKILLS_TOOL_POLICY_MODES.join('|')}`,
      ].join('\n'),
    );
    return;
  }

  if (!isSkillsToolPolicyMode(requested)) {
    ctx.notify('warn', `Unknown policy "${requested}". Use ${SKILLS_TOOL_POLICY_MODES.join(', ')}.`);
    return;
  }

  service.setSessionToolPolicy(requested);
  service.persistToolPolicy(requested);
  const overrode =
    current.from === 'flag' ? ' (overriding --skill-tool-policy for this session)' : '';
  ctx.notify(
    'info',
    `Tool policy: ${current.mode} -> ${requested} (this session and saved).${overrode}`,
  );
}

/**
 * `/skills unload` — clears the ceiling frame.
 *
 * The name reads like "take the skill back out of my context", which is not
 * something anything can do: the body is already in the message history. The
 * text says so outright rather than renaming the command, because a rename would
 * strand every reader of the current README (P2-8).
 */
function unloadFrames(ctx: CommandContext, service: SkillService): void {
  const cleared = service.frameNames();
  service.clearFrames();
  ctx.notify(
    'info',
    cleared.length === 0
      ? 'No skill was constraining this turn. (This command clears the tool ceiling only - ' +
          'skill text already in the conversation cannot be reclaimed.)'
      : `Tool ceiling cleared (was: ${cleared.join(', ')}). This does NOT remove the skill text ` +
          'already in the conversation - nothing can.',
  );
}

function formatRelative(then: number, now: number): string {
  if (then <= 0) return 'never';
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** `YYYY-MM-DD HH:MM` in local time — paired with the relative form, never alone. */
function formatAbsolute(then: number): string {
  if (then <= 0) return '-';
  const d = new Date(then);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/**
 * `/skills usage [--reset]` (§9 / FG7).
 *
 * The counters were being written from day one and were readable by nobody and
 * erasable by no one. "Visible and erasable" is the floor for locally stored
 * behavioural data, however innocuous the contents.
 */
async function usageFromCommand(
  ctx: CommandContext,
  service: SkillService,
  argument: string,
): Promise<void> {
  if (/--reset\b/.test(argument)) {
    const approval = service.getApproval();
    // Same fail-closed probe the installer uses (D17): "is there a human?" is
    // asked before "do you agree?", never inferred from a callback's default.
    if (!approval.canPrompt()) {
      ctx.notify(
        'warn',
        'Cannot confirm a reset without an interactive session. ' +
          'Run "aragon skills usage --reset --yes" instead.',
      );
      return;
    }
    const ok = await approval.request({
      tool: 'skills usage --reset',
      summary: `Delete all local skill usage counters (${getUsagePath()})`,
    });
    if (!ok) {
      ctx.notify('info', 'Usage counters left untouched.');
      return;
    }
    const removed = resetUsage();
    ctx.toast('success', `Cleared ${removed} usage ${removed === 1 ? 'entry' : 'entries'}.`);
    return;
  }

  const rows = listUsage();
  if (rows.length === 0) {
    ctx.notify('info', `No skill usage recorded yet.\nFile: ${getUsagePath()}`);
    return;
  }
  const now = Date.now();
  const width = Math.max(...rows.map((r) => r.name.length), 5);
  ctx.notify(
    'info',
    [
      'Skill usage:',
      ...rows.map(
        (r) =>
          `  ${r.name.padEnd(width)}  ${String(r.useCount).padStart(4)}  ` +
          `${formatRelative(r.lastUsedAt, now)} (${formatAbsolute(r.lastUsedAt)})`,
      ),
      '',
      `File: ${getUsagePath()}`,
      'Stored locally, never transmitted. Clear it with "/skills usage --reset", ' +
        'or switch it off with skills.usageTracking=false.',
    ].join('\n'),
  );
}

function listSkills(ctx: CommandContext, service: SkillService, args = ''): void {
  const recent = /--sort[= ]recent\b/.test(args);
  const all = service.list();
  // Same ranking the catalog uses, so "why is that one not listed for the
  // model?" and "what does /skills show me" cannot drift apart.
  const ranked = recent ? rankCatalogRecords(all, { usage: service.getUsage() }) : all;
  const seen = new Set(ranked.map((r) => r.name));
  const records = recent ? [...ranked, ...all.filter((r) => !seen.has(r.name))] : all;
  const pending = service.untrustedDirs();
  if (records.length === 0) {
    const hint =
      pending.length > 0
        ? `\nUntrusted project skill directories: ${pending.join(', ')}\nRun "/skills trust <dir>" to load them.`
        : '';
    ctx.notify('info', `No skills installed.${hint}`);
    return;
  }
  const { marks, glyphs } = marksFor(ctx);
  const lines = records.map((r) => formatRow(r, marks, glyphs));
  const active = service.getRegistry().activeNames;
  const ceiling = ceilingSummary(service);
  const footer = [
    '',
    `${records.length} skills - ${marks.ok} active  ${marks.disabled} disabled  ` +
      `${marks.invalid} invalid  ${marks.shadowed} shadowed`,
    ...(active.length > 0 ? [`Loaded this session: ${active.join(', ')}`] : []),
    ...(ceiling ? [`Tool ceiling this turn: ${ceiling}`] : []),
    ...(pending.length > 0 ? [`Untrusted project dirs: ${pending.join(', ')}`] : []),
    ...service.errors().map((e) => `warning: ${e}`),
  ];
  ctx.notify('info', ['Skills:', ...lines, ...footer].join('\n'));
}

/**
 * The `Declared tools:` block for `/skills info` (§5.6b).
 *
 * NEVER the bare word `enforced`, and never `advisory` (P0-3 / C3). The scope is
 * a TURN, and the ceiling is a UNION with `skill` permanently in the floor — so
 * a constrained skill can widen its own ceiling by telling the model to load
 * another one (D-G17). Calling that "enforced" full stop would be a fresh
 * version of the same overclaim this iteration exists to retire, and `advisory`
 * is the word that caused the original problem.
 */
function declaredToolsLines(record: SkillRecord, service: SkillService): string[] {
  const declared = record.frontmatter.allowedTools;
  const unresolved: string[] = [];
  const absent: string[] = [];
  for (const name of declared) {
    const outcome = resolveDeclaredTool(name, HOST_TOOL_NAMES);
    if (outcome === null) unresolved.push(name);
    else if (outcome === 'absent') absent.push(name);
  }

  if (unresolved.length > 0) {
    return [
      `Declared tools: ${declared.join(', ')}`,
      `  NOT ENFORCEABLE: unknown tool ${unresolved.map((n) => `"${n}"`).join(', ')}; ` +
        'this skill imposes no ceiling. Fix the name or the ceiling will never apply.',
    ];
  }

  const mode = service.effectiveToolPolicy().mode;
  const header =
    mode === 'off'
      ? `Declared tools (not enforced - skills.toolPolicy=off): ${declared.join(', ')}`
      : record.frontmatter.activation === 'always'
      ? `Declared tools (never enforced - activation: always is exempt): ${declared.join(', ')}`
      : `Declared tools (enforced this turn, union with other loaded skills): ${declared.join(', ')}`;

  if (absent.length === 0) return [header];
  const verb = absent.length === 1 ? 'is' : 'are';
  return [header, `  ${absent.join(', ')} ${verb} not a tool on this host and ${verb} ignored`];
}

function infoSkill(ctx: CommandContext, service: SkillService, name: string): void {
  if (!name) {
    ctx.notify('warn', 'Usage: /skills info <name>');
    return;
  }
  const record = service.get(name);
  if (!record) {
    ctx.notify('warn', `No skill named "${name}".`);
    return;
  }
  const lines = [
    `${record.name} v${record.frontmatter.version} (${record.scope}${record.writable ? '' : ', read-only'})`,
    record.description,
    `Path: ${record.dir}`,
  ];
  if (record.frontmatter.author) lines.push(`Author: ${record.frontmatter.author}`);
  if (record.frontmatter.homepage) lines.push(`Homepage: ${record.frontmatter.homepage}`);
  if (record.frontmatter.license) lines.push(`License: ${record.frontmatter.license}`);
  if (record.frontmatter.keywords.length > 0) {
    lines.push(`Keywords: ${record.frontmatter.keywords.join(', ')}`);
  }
  if (record.frontmatter.allowedTools.length > 0) {
    lines.push(...declaredToolsLines(record, service));
  }
  lines.push(`Activation: ${record.frontmatter.activation}`);

  const manifest = record.manifest;
  if (manifest) {
    lines.push(
      `Source: ${manifest.source.kind} ${manifest.source.url}` +
        (manifest.source.ref ? ` @ ${manifest.source.ref}` : '') +
        (manifest.source.resolvedRef ? ` (${manifest.source.resolvedRef.slice(0, 8)})` : ''),
      `Installed: ${new Date(manifest.installedAt).toISOString()} by ${manifest.installer}`,
      `Files: ${manifest.files.length} (${Math.round(manifest.totalBytes / 1024)} KB)`,
    );
    if (manifest.updatedAt) {
      lines.push(
        `Updated: ${new Date(manifest.updatedAt).toISOString()}` +
          (manifest.previousVersion ? ` (from v${manifest.previousVersion})` : ''),
      );
    }
    if (record.integrity === 'modified') {
      lines.push('Integrity: SKILL.md has been modified since install');
    }
    const tamper = checkManifest(record.dir, manifest);
    if (tamper.missing.length > 0) lines.push(`Missing files: ${tamper.missing.join(', ')}`);
    if (tamper.modified.length > 0) lines.push(`Modified files: ${tamper.modified.join(', ')}`);
  } else {
    lines.push('Source: hand-authored (no install manifest)');
  }

  if (record.shadowed.length > 0) {
    lines.push(`Shadows: ${record.shadowed.map((s) => `${s.scope}:${s.dir}`).join(', ')}`);
  }
  for (const issue of record.issues) lines.push(`${issue.level}: ${issue.code} - ${issue.message}`);
  if (service.getRegistry().isActive(record.name)) lines.push('Loaded in this conversation.');

  ctx.notify('info', lines.join('\n'));
}

async function installFromCommand(
  ctx: CommandContext,
  service: SkillService,
  args: string,
  version: string,
): Promise<void> {
  const { rest: source, scope } = parseScopeFlag(args);
  if (!source) {
    ctx.notify('warn', 'Usage: /skills install <source> [--scope user|project]');
    return;
  }
  ctx.toast('info', `Installing ${source}${marksFor(ctx).glyphs.ellipsis}`);
  const result = await installSkill(service, source, {
    ...(scope ? { scope } : {}),
    initiator: 'user',
    cwd: ctx.controller.getCwd(),
    installer: version,
  });
  if (!result.ok) {
    ctx.notify('error', `Install failed: ${result.error}`);
    return;
  }
  ctx.refreshSkills();
  ctx.notify(
    'info',
    `Installed "${result.name}" v${result.version} into ${result.scope} scope (${result.fileCount} files) at ${result.dir}.`,
  );
}

/**
 * `/skills update <name> [--force]` / `/skills update --all`.
 *
 * `--dry-run` is intentionally absent from the slash surface (§6.5): a list of
 * paths that *would* change is worth reading in a terminal you can scroll, and
 * is not worth another flag to explain in a TUI notice.
 */
async function updateFromCommand(
  ctx: CommandContext,
  service: SkillService,
  args: string,
  version: string,
): Promise<void> {
  const force = /--force\b/.test(args);
  const rest = args.replace(/--force\b/g, '').trim();
  const all = /^--all\b/.test(rest);
  const name = all ? '' : rest;

  if (!all && !name) {
    ctx.notify('warn', 'Usage: /skills update <name> [--force]  |  /skills update --all');
    return;
  }

  const opts = {
    cwd: ctx.controller.getCwd(),
    installer: version,
    ...(force ? { force: true } : {}),
    initiator: 'user' as const,
  };

  // Arrows come from the resolved glyph table, never inline (§4.1 tier B): a
  // legacy cmd.exe renders a hardcoded U+2192 as mojibake, and `glyphs.test.ts`
  // fails the build for it.
  const { glyphs } = marksFor(ctx);

  if (!all) {
    ctx.toast('info', `Updating ${name}${glyphs.ellipsis}`);
    const result = await updateSkill(service, name, opts);
    if (!result.ok) {
      ctx.notify(isHardFailure(result) ? 'error' : 'warn', result.error ?? `Could not update "${name}".`);
      return;
    }
    if (!result.changed) {
      ctx.notify('info', `${result.name} is already up to date (v${result.fromVersion}).`);
      return;
    }
    ctx.refreshSkills();
    ctx.notify(
      'info',
      `Updated ${result.name} ${result.fromVersion} ${glyphs.arrowRight} ${result.toVersion}.`,
    );
    return;
  }

  ctx.toast('info', `Updating all skills${glyphs.ellipsis}`);
  const results = await updateAllSkills(service, opts);
  if (results.length === 0) {
    ctx.notify('info', 'No skills have an upstream to update from.');
    return;
  }
  const updated = results.filter((r) => r.ok && r.changed);
  const unchanged = results.filter((r) => r.ok && !r.changed).length;
  const failed = results.filter(isHardFailure).length;
  if (updated.length > 0) ctx.refreshSkills();
  ctx.notify(
    'info',
    [
      'Skill updates:',
      ...results.map((r) => {
        if (r.ok && r.changed) {
          return `  ${r.name}: updated ${r.fromVersion} ${glyphs.arrowRight} ${r.toVersion}`;
        }
        if (r.ok) return `  ${r.name}: up to date`;
        return `  ${r.name}: skipped - ${r.error?.split('\n')[0] ?? r.reason}`;
      }),
      '',
      `Updated ${updated.length}, unchanged ${unchanged}, ` +
        `skipped ${results.length - updated.length - unchanged - failed}, failed ${failed}.`,
    ].join('\n'),
  );
}

async function removeFromCommand(
  ctx: CommandContext,
  service: SkillService,
  name: string,
): Promise<void> {
  if (!name) {
    ctx.notify('warn', 'Usage: /skills remove <name>');
    return;
  }
  const result = await removeSkill(service, name);
  if (!result.ok) {
    ctx.notify('error', result.error ?? `Could not remove "${name}".`);
    return;
  }
  ctx.refreshSkills();
  ctx.toast('success', `Removed skill "${name}".`);
}

function toggleSkill(
  ctx: CommandContext,
  service: SkillService,
  name: string,
  disable: boolean,
): void {
  if (!name) {
    ctx.notify('warn', `Usage: /skills ${disable ? 'disable' : 'enable'} <name>`);
    return;
  }
  if (!service.get(name)) {
    ctx.notify('warn', `No skill named "${name}".`);
    return;
  }
  service.setDisabled(name, disable);
  ctx.refreshSkills();
  ctx.toast('success', `Skill "${name}" ${disable ? 'disabled' : 'enabled'}.`);
}

function scaffoldSkill(ctx: CommandContext, service: SkillService, name: string): void {
  if (!name) {
    ctx.notify('warn', 'Usage: /skills create <name>');
    return;
  }
  const root = writableRootFor('user', ctx.controller.getCwd());
  if (!root) {
    ctx.notify('error', 'No writable skills directory available.');
    return;
  }
  try {
    // Deliberately a scaffold, not an interactive wizard (§7.2): the useful next
    // step is opening the file in the user's own editor, not answering prompts
    // in a TUI that has no text-area affordance.
    const dir = writeScaffold(root, name);
    service.reload();
    ctx.refreshSkills();
    ctx.notify('info', `Created a skill skeleton at ${dir}. Edit SKILL.md, then run /skills reload.`);
  } catch (err) {
    ctx.notify('error', `Could not create the skill: ${(err as Error).message}`);
  }
}

function writeScaffold(root: string, name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    renderSkillMarkdown({
      name,
      description: `TODO: what this skill does AND when to use it - the model sees only this line.`,
      body: ['# ' + name, '', '## When to use', '', 'TODO', '', '## Steps', '', '1. TODO'].join('\n'),
    }),
    'utf-8',
  );
  return dir;
}

function trustFromCommand(
  ctx: CommandContext,
  service: SkillService,
  dir: string,
  untrust: boolean,
): void {
  if (!dir) {
    ctx.notify('warn', `Usage: /skills ${untrust ? 'untrust' : 'trust'} <dir>`);
    return;
  }
  const ok = untrust ? service.untrustDir(dir) : service.trustDir(dir);
  if (!ok) {
    ctx.notify('warn', untrust ? `"${dir}" was not trusted.` : `Could not resolve "${dir}".`);
    return;
  }
  service.reload();
  ctx.refreshSkills();
  ctx.toast('success', `${untrust ? 'Untrusted' : 'Trusted'} ${dir}.`);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function makeSkillsCommand(service: SkillService, version: string): SlashCommand {
  return {
    name: 'skills',
    description: 'List and manage skills',
    run: (ctx) => runSkills(ctx, service, version),
  };
}

/**
 * Register one dynamic command per usable skill.
 *
 * CONFLICT RULE (D6 / P1-2): the namespaced `/skill:<name>` form is ALWAYS
 * registered — documentation and scripts need a stable handle — while the bare
 * `/<name>` is only taken when `registry.get(name)` is undefined.
 *
 * The probe MUST be `get()`, never `all().map(c => c.name)`. `all()` de-dupes
 * by command OBJECT, so it returns primary names only and silently omits every
 * alias. `quit` is an alias of `exit`, and `register()` overwrites
 * unconditionally — so a third-party skill named `quit` would take over `/quit`.
 * D6 calls hijacking the user's muscle memory a security boundary, not a
 * papercut, and `get()` is the only probe that sees the alias table.
 */
export function registerSkillCommands(registry: CommandRegistry, service: SkillService): void {
  for (const record of service.list()) {
    if (record.disabled || record.invalid) continue;
    if (record.frontmatter.activation === 'manual') continue;

    const command = makeSkillCommand(record, service);
    registry.register({ ...command, name: `skill:${record.name}` });
    if (registry.get(record.name) === undefined) {
      registry.register({ ...command, name: record.name });
    }
  }
}

function makeSkillCommand(record: SkillRecord, service: SkillService): SlashCommand {
  return {
    name: record.name,
    description: shortDescription(record),
    run: (ctx) => {
      let loaded: { body: string; files: Array<{ path: string; bytes: number }> };
      try {
        loaded = service.loadBody(record.name);
      } catch (err) {
        ctx.notify('error', `Could not load skill "${record.name}": ${(err as Error).message}`);
        return;
      }
      const hydrated: SkillRecord = { ...record, body: loaded.body, files: loaded.files };
      service.getRegistry().activate(record.name);
      // QUEUE, do not enter (D-G2). `ctx.submit()` below turns into the user
      // message that OPENS the next turn, and `controller.prompt()` clears the
      // frame on its way in — so entering here would leave the one turn the user
      // explicitly asked this skill to run as the only unconstrained one.
      service.queueFrame(record.name);

      const policy = service.pendingToolPolicyView(() =>
        ctx.controller.listTools().map((t) => t.name),
      );
      const message = renderSkillInvocation(hydrated, ctx.args, {
        // The same knob as the tool path, at last (GG3 / FG3).
        bodyMaxBytes: service.bodyMaxBytes(),
        platform: currentPlatform(),
        ...(policy ? { policy } : {}),
      });
      // The SUBMITTED size, not the file's. Reporting 480 KB while sending 30 KB
      // is how a user concludes the truncation marker is a rendering glitch.
      const kb = Math.max(1, Math.round(Buffer.byteLength(message, 'utf-8') / 1024));
      ctx.notify(
        'info',
        `Skill "${record.name}" loaded (${kb} KB submitted, ${loaded.files.length} bundled files).`,
      );
      ctx.submit(message);
    },
  };
}
