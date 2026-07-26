/**
 * Slash-command registry + dispatcher (spec §5.2). A leading `/` in the prompt
 * input is routed here instead of to the agent; `//` is the literal-`/` escape.
 */

import type { AgentController } from '../agent/controller.js';
import type { NoticeLevel, Overlay, ToastLevel, ViewAction, ViewState } from '../agent/reducer.js';
import type { PersistedConfig } from '../config/schema.js';

export interface CommandContext {
  /** Raw argument string after the command word (may be empty). */
  args: string;
  controller: AgentController;
  state: ViewState;
  dispatch: (action: ViewAction) => void;
  setOverlay: (overlay: Overlay) => void;
  /** Durable transcript message (errors, listings, saved paths). */
  notify: (level: NoticeLevel, text: string) => void;
  /** Ephemeral, auto-dismissing acknowledgement (spec §3.9). */
  toast: (level: ToastLevel, text: string) => void;
  persistConfig: (patch: Partial<PersistedConfig>) => void;
  exit: () => void;
  /**
   * Submit `text` as if the user had typed it (steers when running, prompts when
   * idle). Dynamic skill commands need this: they turn `/pdf-forms a.pdf` into a
   * real user message. It is a separate entry point from `handleSubmit` on
   * purpose — routing back through that would re-enter slash-command parsing.
   */
  submit: (text: string) => void;
  /** Rebuild the system prompt and the dynamic command list after a skill change. */
  refreshSkills: () => void;
}

export interface SlashCommand {
  name: string;
  aliases?: string[];
  description: string;
  run: (ctx: CommandContext) => void | Promise<void>;
}

export class CommandRegistry {
  private readonly byName = new Map<string, SlashCommand>();

  register(command: SlashCommand): void {
    this.byName.set(command.name, command);
    for (const alias of command.aliases ?? []) {
      this.byName.set(alias, command);
    }
  }

  get(name: string): SlashCommand | undefined {
    return this.byName.get(name);
  }

  all(): SlashCommand[] {
    // De-duplicate aliases pointing at the same command.
    return Array.from(new Set(this.byName.values()));
  }
}

/**
 * Try to run a slash command from raw input. Returns `true` if the input was a
 * (known or unknown) slash command and was consumed; `false` if it is a normal
 * message that should go to the agent.
 */
export async function runSlashInput(
  registry: CommandRegistry,
  input: string,
  makeCtx: (args: string) => CommandContext,
): Promise<boolean> {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith('/')) return false;
  // `//...` escapes a literal leading slash — not a command.
  if (trimmed.startsWith('//')) return false;

  const withoutSlash = trimmed.slice(1);
  const spaceIdx = withoutSlash.search(/\s/);
  const name = spaceIdx === -1 ? withoutSlash : withoutSlash.slice(0, spaceIdx);
  const args = spaceIdx === -1 ? '' : withoutSlash.slice(spaceIdx + 1).trim();

  const command = registry.get(name);
  const ctx = makeCtx(args);
  if (!command) {
    ctx.notify('warn', `Unknown command "/${name}" - try /help.`);
    return true;
  }
  await command.run(ctx);
  return true;
}
