/**
 * `/kit` - the slash surface for agent model kits (agent-model-kits §4.9).
 *
 * ASCII ONLY - `src/commands/**` is inside `glyphs.test.ts::inScope`.
 *
 * WHY A COMMAND AT ALL, WHEN `ctrl+K` EXISTS: a key that a terminal, tmux, an
 * input method or a IME can swallow needs an equivalent that cannot be swallowed
 * (`R-4`), and the same reading is what a user pastes into an issue. The two
 * surfaces call the SAME controller methods, so they can never diverge in
 * behaviour - only in how the answer is rendered.
 *
 * THERE IS NO `/kit default` (D-7): the session path is forbidden from writing
 * the file, so a "make this the default" verb here would be the one hole in that
 * promise. Setting a default is a settings action, with a Save the user sees.
 */

import type { CommandRegistry, CommandContext } from './registry.js';
import type { CliConfig } from '../config/schema.js';
import { kitMatches, findKit, kitSlotConnections, type AgentKit } from '../config/model-kits.js';
import { kitApplyMessage, kitNoteMessages } from '../agent/kit-apply.js';

/** `main a:b / sub same as main / fast off`, shared by every branch below. */
function describeKit(config: CliConfig, kit: AgentKit): string {
  const connections = kitSlotConnections(config.modelProfiles, kit);
  const main = connections.main
    ? `${connections.main.provider}:${connections.main.model}` : 'Profile missing';
  const fast = kit.fastProfileId === null ? 'off'
    : connections.fast ? `${connections.fast.provider}:${connections.fast.model}`
      : 'Profile missing';
  const subagent = kit.subagent.model === 'main' ? 'same as main'
    : kit.subagent.model === 'fast' ? 'fast tier'
      : connections.subagent.name ? `profile ${connections.subagent.name}` : 'Profile missing';
  return `main ${main} / sub ${subagent} / fast ${fast}`;
}

function kitNames(config: CliConfig): string[] {
  return (config.modelProfiles?.kits ?? []).map((kit) => kit.name);
}

/** `/kit` with no argument: what is in effect, and what it resolves to. */
function reportActive(ctx: CommandContext): void {
  const config = ctx.controller.getConfig();
  const active = ctx.controller.getActiveKit();
  const kits = config.modelProfiles?.kits ?? [];
  if (!kits.length) {
    ctx.notify('info', 'No kits yet. Create one in /settings (Settings > Kit pack).');
    return;
  }
  const session = active.source === 'session'
    ? `session: ${active.name}${active.held.length < 3
      ? `, holds ${active.held.join('+')}` : ''}`
    : active.source === 'default' ? 'default' : 'current setup';
  const kit = findKit(config.modelProfiles, active.id);
  const detail = kit ? ` ${describeKit(config, kit)}.` : '';
  const drift = active.modified && active.driftReasons.length
    ? ` Drifted: ${active.driftReasons.join('; ')}.` : '';
  ctx.notify('info', `Kit pack: ${active.name} (${session}).${detail}${drift}`);
}

/** `/kit list`: every kit, its markers and its three connections. */
function listKits(ctx: CommandContext): void {
  const config = ctx.controller.getConfig();
  const kits = config.modelProfiles?.kits ?? [];
  const active = ctx.controller.getActiveKit();
  const fallback = config.modelProfiles?.defaultKitId ?? null;
  if (!kits.length) {
    ctx.notify('info', 'No kits yet. Create one in /settings.');
    return;
  }
  const lines = kits.map((kit) => {
    const markers = [kit.id === fallback ? '[Default]' : '',
      active.source !== 'none' && active.id === kit.id ? '[In use]' : '',
      active.source !== 'none' && active.id === kit.id && active.modified ? '~' : '']
      .filter(Boolean).join(' ');
    return `${markers ? `${markers} ` : ''}${kit.name}: ${describeKit(config, kit)}`;
  });
  ctx.notify('info', `Kits (${kits.length}):\n${lines.join('\n')}`);
}

/** `/kit use current` and `/kit use <name|#prefix>`. */
function useKit(ctx: CommandContext, ref: string): void {
  const config = ctx.controller.getConfig();
  if (ref.toLowerCase() === 'current') {
    const released = ctx.controller.clearSessionKit();
    ctx.toast(released.ok ? 'success' : 'warn', kitApplyMessage(released));
    return;
  }
  const matches = kitMatches(config.modelProfiles, ref);
  if (!matches.length) {
    const names = kitNames(config);
    ctx.notify('warn', `No kit named "${ref}".`
      + (names.length ? ` Available: ${names.join(', ')}.` : ' Create one in /settings first.'));
    return;
  }
  if (matches.length > 1) {
    const ids = matches.map((kit) => `#${kit.id.slice(0, 8)}`).join(', ');
    ctx.notify('warn', `Two or more kits are named "${ref}": ${ids}. Use one of those ids.`);
    return;
  }
  const kit = matches[0]!;
  const result = ctx.controller.applySessionKit(kit.id);
  if (!result.ok) {
    // `kit_references_missing_profile` names the SLOT in its issues; without them
    // the user would have to open three screens to find out which one is dead.
    const detail = (result.issues ?? []).map((issue) => issue.message).join(' ');
    ctx.notify('warn', [kitApplyMessage(result), detail].filter(Boolean).join(' '));
    return;
  }
  const notes = kitNoteMessages(result.notes);
  ctx.toast(notes.length ? 'warn' : 'success',
    [`Kit ${kit.name} applied for this session.`, ...notes].join(' '));
}

/** The command body; `registerKitCommand` is the only registration site. */
export function runKitCommand(ctx: CommandContext): void {
  const args = ctx.args.trim();
  if (!args) { reportActive(ctx); return; }
  const [verb = '', ...rest] = args.split(/\s+/);
  if (verb.toLowerCase() === 'list') { listKits(ctx); return; }
  if (verb.toLowerCase() === 'use') {
    const ref = rest.join(' ').trim();
    if (!ref) {
      ctx.notify('warn', 'Which kit? Use /kit use <name|#id prefix>, or /kit use current.');
      return;
    }
    useKit(ctx, ref);
    return;
  }
  ctx.notify('warn', 'Unknown /kit subcommand. Try /kit, /kit list, /kit use <name>.');
}

/** Registered from `builtins.ts` with one line, next to every other subsystem. */
export function registerKitCommand(registry: CommandRegistry): void {
  registry.register({ name: 'kit', description: 'Agent kits: status, list, use for this session',
    run: (ctx) => { runKitCommand(ctx); } });
}
