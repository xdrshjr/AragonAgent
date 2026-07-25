/**
 * Built-in slash commands (spec §5.2):
 * /help /model /settings /thinking /tools /clear /reset /cwd /save /resume
 * /copy /exit (/quit).
 */

import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import process from 'node:process';
import { clampThinkingLevel, clampTheme, THINKING_LEVELS } from '../config/schema.js';
import type { Entry } from '../agent/reducer.js';
import { loadSession, resolveSessionPath, saveSession } from '../session/persist.js';
import { CommandRegistry, type SlashCommand } from './registry.js';

const COMMANDS: SlashCommand[] = [
  {
    name: 'help',
    description: 'Show keybindings and commands',
    run: (ctx) => ctx.setOverlay('help'),
  },
  {
    name: 'model',
    description: 'Open the model picker',
    run: (ctx) => ctx.setOverlay('model'),
  },
  {
    name: 'settings',
    description: 'Open the settings screen',
    run: (ctx) => ctx.setOverlay('settings'),
  },
  {
    name: 'thinking',
    description: 'Set the thinking level',
    run: (ctx) => {
      const level = ctx.args.trim();
      if (!level) {
        ctx.notify('info', `Thinking levels: ${THINKING_LEVELS.join(', ')}.`);
        return;
      }
      const clamped = clampThinkingLevel(level, ctx.controller.getConfig().thinkingLevel);
      ctx.controller.setThinkingLevel(clamped);
      ctx.persistConfig({ thinkingLevel: clamped });
      ctx.toast('info', `Thinking level set to "${clamped}".`);
    },
  },
  {
    name: 'theme',
    description: 'Switch the color theme (auto|dark|light)',
    run: (ctx) => {
      const arg = ctx.args.trim().toLowerCase();
      const current = ctx.controller.getConfig().theme;
      if (!arg) {
        ctx.notify('info', `Theme: ${current}. Use /theme <auto|dark|light>.`);
        return;
      }
      const name = clampTheme(arg, current);
      if (arg !== name) {
        ctx.notify('warn', `Unknown theme "${arg}" — use auto, dark, or light.`);
        return;
      }
      ctx.controller.setTheme(name);
      ctx.persistConfig({ theme: name });
      ctx.toast('success', `Theme set to ${name}.`);
    },
  },
  {
    name: 'expand',
    description: 'Expand / collapse a recent tool card (default: last)',
    run: (ctx) => {
      const toolEntries = ctx.state.entries.filter((e) => e.kind === 'tool');
      if (toolEntries.length === 0) {
        ctx.toast('info', 'No tool output to expand.');
        return;
      }
      const n = Number.parseInt(ctx.args.trim(), 10);
      const fromLast = Number.isFinite(n) && n > 0 ? n : 1;
      const idx = Math.max(0, toolEntries.length - fromLast);
      const target = toolEntries[idx];
      if (target) ctx.dispatch({ type: 'toggleExpand', id: target.id });
    },
  },
  {
    name: 'tools',
    description: 'List active tools',
    run: (ctx) => {
      const lines = ctx.controller
        .listTools()
        .map((t) => `• ${t.name} — ${t.description.split('\n')[0]}`)
        .join('\n');
      ctx.notify('info', `Active tools:\n${lines}`);
    },
  },
  {
    name: 'clear',
    description: 'Clear the visible transcript',
    run: (ctx) => ctx.dispatch({ type: 'clearTranscript' }),
  },
  {
    name: 'reset',
    description: 'Start a new conversation',
    run: (ctx) => {
      ctx.controller.clearMessages();
      ctx.controller.clearAllQueues();
      ctx.dispatch({ type: 'resetConversation' });
      ctx.toast('info', 'Started a new conversation.');
    },
  },
  {
    name: 'cwd',
    description: 'Show or change the tool working directory',
    run: (ctx) => {
      const arg = ctx.args.trim();
      if (!arg) {
        ctx.notify('info', `Working directory: ${ctx.controller.getCwd()}`);
        return;
      }
      const target = isAbsolute(arg) ? arg : resolve(ctx.controller.getCwd(), arg);
      if (!existsSync(target) || !statSync(target).isDirectory()) {
        ctx.notify('error', `Not a directory: ${arg}`);
        return;
      }
      ctx.controller.setCwd(target);
      ctx.notify('info', `Working directory set to ${target}`);
    },
  },
  {
    name: 'save',
    description: 'Save the session to JSON',
    run: (ctx) => {
      try {
        const path = resolveSessionPath(ctx.args, ctx.controller.getCwd());
        const cfg = ctx.controller.getConfig();
        saveSession(path, {
          model: {
            providerId: cfg.provider,
            modelId: cfg.model,
            ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
          },
          messages: ctx.controller.getMessages(),
          entries: ctx.state.entries,
        });
        ctx.notify('info', `Saved session to ${path}`);
      } catch (err) {
        ctx.notify('error', `Save failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  },
  {
    name: 'resume',
    description: 'Load a saved session',
    run: (ctx) => {
      try {
        const path = resolveSessionPath(ctx.args, ctx.controller.getCwd());
        const session = loadSession(path);
        ctx.controller.replaceMessages(session.messages);
        ctx.dispatch({ type: 'restoreEntries', entries: session.entries as Entry[] });
        if (session.model?.providerId && session.model?.modelId) {
          ctx.controller.setModel(session.model.providerId, session.model.modelId, session.model.baseUrl);
        }
        ctx.notify('info', `Resumed session from ${path}`);
      } catch (err) {
        ctx.notify('error', `Resume failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  },
  {
    name: 'copy',
    description: 'Copy the last answer to the clipboard',
    run: (ctx) => {
      const last = [...ctx.state.entries].reverse().find((e) => e.kind === 'assistant');
      if (!last || last.kind !== 'assistant' || last.text.trim().length === 0) {
        ctx.notify('warn', 'No assistant message to copy.');
        return;
      }
      const ok = copyToClipboard(last.text);
      ctx.toast(ok ? 'success' : 'warn', ok ? 'Copied to clipboard.' : 'Clipboard not available.');
    },
  },
  {
    name: 'exit',
    aliases: ['quit'],
    description: 'Exit',
    run: (ctx) => ctx.exit(),
  },
];

export function registerBuiltinCommands(registry: CommandRegistry): void {
  for (const command of COMMANDS) registry.register(command);
}

/** Best-effort clipboard copy via the platform's clipboard CLI. */
function copyToClipboard(text: string): boolean {
  const cmd =
    process.platform === 'win32'
      ? { file: 'clip', args: [] as string[] }
      : process.platform === 'darwin'
      ? { file: 'pbcopy', args: [] }
      : { file: 'xclip', args: ['-selection', 'clipboard'] };
  try {
    const child = spawn(cmd.file, cmd.args, { stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', () => {
      /* swallow — clipboard is best-effort */
    });
    child.stdin?.end(text);
    return true;
  } catch {
    return false;
  }
}
