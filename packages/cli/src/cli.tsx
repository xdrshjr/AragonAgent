/**
 * Bin entry (spec §3.1 / §5.1). Parses argv, resolves layered config, and
 * branches:
 *   --help/--version           → commander prints & exits
 *   config / models subcommand → utility & exit
 *   -p/--print or piped stdin  → one-shot headless run
 *   else                       → render the interactive Ink TUI
 *
 * The shebang is prepended post-build by scripts/prepend-shebang.mjs.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import React from 'react';
import { render } from 'ink';
import { Command } from 'commander';
import { loadConfig, type CliFlags } from './config/load.js';
import { getConfigPath, updatePersistedConfig } from './config/store.js';
import {
  ADAPTER_PROVIDERS,
  clampDensity,
  clampTheme,
  clampThinkingLevel,
  clampTranscriptWindow,
  coerceMaxTokens,
  coercePositiveInt,
  isAdapterProvider,
  type PersistedConfig,
} from './config/schema.js';
import { makeGetApiKey } from './config/load.js';
import { AgentController } from './agent/controller.js';
import { runHeadless } from './agent/headless.js';
import { App, type ConfirmBridge } from './ui/App.js';
import { decideRenderMode } from './ui/layout/frame.js';
import { enterAltScreen, writeExitTranscript, type ScreenHandle } from './ui/screen.js';
import { readExitSnapshot } from './ui/exit-snapshot.js';
import { renderTranscriptText } from './ui/transcript-text.js';
import { detectCapabilities } from './ui/capabilities.js';
import { pickGlyphs } from './ui/glyphs.js';
import type { Overlay } from './agent/reducer.js';
import type { ConfirmRequest } from './tools/index.js';

// ---------------------------------------------------------------------------
// Version (read from the shipped package.json next to dist/)
// ---------------------------------------------------------------------------

function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf-8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const VERSION = readVersion();

// ---------------------------------------------------------------------------
// Flag extraction
// ---------------------------------------------------------------------------

interface RawOpts {
  print?: boolean;
  fullscreen?: boolean;
  exitTranscript?: boolean;
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  thinking?: string;
  maxTokens?: string;
  cwd?: string;
  confirm?: boolean;
  toolTimeout?: string;
  idleTimeout?: string;
  theme?: string;
  color?: boolean;
  quiet?: boolean;
  compact?: boolean;
  hints?: boolean;
}

function toFlags(opts: RawOpts): CliFlags {
  return {
    provider: opts.provider,
    model: opts.model,
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    thinking: opts.thinking,
    maxTokens: opts.maxTokens,
    cwd: opts.cwd,
    theme: opts.theme,
    color: opts.color,
    confirm: opts.confirm,
    toolTimeout: opts.toolTimeout,
    idleTimeout: opts.idleTimeout,
    fullscreen: opts.fullscreen,
    exitTranscript: opts.exitTranscript,
    compact: opts.compact,
    hints: opts.hints,
  };
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

function makeController(flags: CliFlags): { controller: AgentController; confirmBridge: ConfirmBridge } {
  const config = loadConfig(flags);
  const confirmBridge: ConfirmBridge = { handler: null };
  const controller = new AgentController(config, {
    confirm: (req: ConfirmRequest) =>
      confirmBridge.handler ? confirmBridge.handler(req) : Promise.resolve(true),
  });
  return { controller, confirmBridge };
}

/** POSIX signal numbers for the `128 + signo` exit-code convention. */
const SIGNAL_NUMBERS: Record<string, number> = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 };

/**
 * The interactive TUI — and the ONLY place that may touch the screen.
 *
 * Screen take-over stays inside this function on purpose (§4.4). Hoisting it up
 * to `buildProgram()` / `parseAsync` would push `\x1b[?1049h` into `argon -p
 * "…" > out.txt`, `argon config set`, and `argon --version`, because the
 * interactive and headless paths are disjoint branches: `runInteractive()`
 * renders Ink, `runOneShot()` goes to `runHeadless()`, which never does.
 */
function runInteractive(
  flags: CliFlags,
  extras: { initialPrompt?: string; initialOverlay?: Overlay } = {},
): void {
  const { controller, confirmBridge } = makeController(flags);
  const config = controller.getConfig();
  const mode = decideRenderMode({ fullscreen: config.fullscreen }, process.env, process.stdout);

  let screen: ScreenHandle | null = null;
  let replayed = false;

  const replayTranscript = (): void => {
    if (replayed || mode !== 'fullscreen' || !config.exitTranscript) return;
    replayed = true;
    const snapshot = readExitSnapshot();
    if (!snapshot) return; // Never published (instant exit) — skip, do not throw.
    writeExitTranscript(
      process.stdout,
      renderTranscriptText(snapshot.entries, {
        // Same terminal the TUI just left, so the same glyph tier applies.
        glyphs: pickGlyphs(detectCapabilities(process.env, process.stdout)),
        usageTotal: snapshot.usageTotal,
        provider: snapshot.provider,
        model: snapshot.model,
        elapsedMs: Date.now() - snapshot.startedAt,
      }),
    );
  };

  if (mode === 'fullscreen') {
    screen = enterAltScreen(process.stdout);
    const restore = (): void => screen?.restore();

    // Four idempotent restore paths (§4.4). The signal hook is NOT redundant:
    //   - `waitUntilExit().then()` is a microtask and may never be reached when
    //     the process is killed;
    //   - Node does not emit `'exit'` at all on signal termination;
    //   - Ink's own `signalExit` only unmounts the component tree — it knows
    //     nothing about the alternate screen.
    // Without it, `kill <pid>`, closing the terminal window (SIGHUP), or a dying
    // parent all leave the user staring at a blank alternate screen with `reset`
    // as their only way out.
    process.on('exit', restore);
    for (const [name, signo] of Object.entries(SIGNAL_NUMBERS)) {
      process.on(name as NodeJS.Signals, () => {
        restore(); // Synchronous: stdout.write on a TTY is sync on every platform.
        process.exit(128 + signo);
      });
    }
  }

  const instance = render(
    <App
      controller={controller}
      version={VERSION}
      mode={mode}
      confirmBridge={confirmBridge}
      initialPrompt={extras.initialPrompt}
      initialOverlay={extras.initialOverlay}
    />,
    // Full-screen owns console.* itself (I-4): Ink's patchConsole writes
    // straight to stdout and permanently shifts the fixed frame's accounting.
    { exitOnCtrlC: false, patchConsole: mode === 'inline' },
  );

  // The return value MUST be captured — `waitUntilExit()` is the normal-exit
  // restore path and it cannot be registered otherwise.
  void instance
    .waitUntilExit()
    .then(() => {
      screen?.restore();
      replayTranscript();
    })
    .catch(() => {
      screen?.restore();
    });
}

async function runOneShot(flags: CliFlags, prompt: string, quiet: boolean): Promise<void> {
  const { controller } = makeController(flags);
  const code = await runHeadless(controller, prompt, { quiet });
  process.exitCode = code;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf-8').trim();
}

async function runModels(flags: CliFlags, providerArg?: string): Promise<void> {
  const config = loadConfig(flags);
  const { controller } = makeController(flags);
  const registry = controller.getModelRegistry();
  const getKey = makeGetApiKey(config);

  const providers =
    providerArg && isAdapterProvider(providerArg) ? [providerArg] : [...ADAPTER_PROVIDERS];
  if (providerArg && !isAdapterProvider(providerArg)) {
    process.stderr.write(`Unknown provider "${providerArg}". Choose: ${ADAPTER_PROVIDERS.join(', ')}.\n`);
    process.exitCode = 2;
    return;
  }

  for (const provider of providers) {
    process.stdout.write(`\n${provider}:\n`);
    for (const model of registry.getModels(provider)) {
      process.stdout.write(`  ${model.id}  -  ${model.name}\n`);
    }
    const key = getKey(provider);
    if (key) {
      const discovered = await registry.discoverModels(provider, key, config.baseUrl);
      const builtinIds = new Set(registry.getModels(provider).map((m) => m.id));
      const extra = discovered.filter((m) => !builtinIds.has(m.id));
      if (extra.length > 0) {
        process.stdout.write('  (discovered):\n');
        for (const model of extra) {
          process.stdout.write(`    ${model.id}  -  ${model.name}\n`);
        }
      }
    }
  }
}

const CONFIG_SET_KEYS = new Set([
  'provider',
  'model',
  'baseUrl',
  'thinkingLevel',
  'maxTokens',
  'theme',
  'confirmTools',
  'toolTimeoutMs',
  'idleTimeoutMs',
  'fullscreen',
  'exitTranscript',
  'transcriptWindow',
  // Without these two, `density` and `hints` would be settable only as one-shot
  // flags and never persist -- inconsistent with every other config field.
  'density',
  'hints',
]);

function runConfigSet(key: string, value: string): void {
  if (!CONFIG_SET_KEYS.has(key)) {
    process.stderr.write(
      `Unknown config key "${key}". Known keys: ${[...CONFIG_SET_KEYS].join(', ')}.\n`,
    );
    process.exitCode = 2;
    return;
  }
  const patch: Partial<PersistedConfig> = {};
  switch (key) {
    case 'provider':
      patch.provider = value;
      break;
    case 'model':
      patch.model = value;
      break;
    case 'baseUrl':
      patch.baseUrl = value.trim().length > 0 ? value : null;
      break;
    case 'thinkingLevel':
      patch.thinkingLevel = clampThinkingLevel(value, 'off');
      break;
    case 'maxTokens':
      patch.maxTokens = coerceMaxTokens(value) ?? null;
      break;
    case 'theme':
      patch.theme = clampTheme(value, 'auto');
      break;
    case 'confirmTools':
      patch.confirmTools = value === 'true' || value === '1';
      break;
    case 'toolTimeoutMs':
      patch.toolTimeoutMs = coercePositiveInt(value, 180_000);
      break;
    case 'idleTimeoutMs':
      patch.idleTimeoutMs = coercePositiveInt(value, 210_000);
      break;
    case 'fullscreen':
      patch.fullscreen = value === 'true' || value === '1';
      break;
    case 'exitTranscript':
      patch.exitTranscript = value === 'true' || value === '1';
      break;
    case 'transcriptWindow':
      patch.transcriptWindow = clampTranscriptWindow(value, 300);
      break;
    case 'density':
      patch.density = clampDensity(value, 'comfortable');
      break;
    case 'hints':
      patch.hints = value === 'true' || value === '1';
      break;
  }
  updatePersistedConfig(patch);
  process.stdout.write(`Set ${key} = ${value}\n`);
}

// ---------------------------------------------------------------------------
// CLI definition
// ---------------------------------------------------------------------------

function buildProgram(): Command {
  const program = new Command();

  program
    .name('aragon')
    .description('ArgonAgent - a Claude-Code / Codex-style terminal UI for the ArgonAgent engine.')
    .version(VERSION, '-v, --version', 'Print the version')
    .argument('[prompt]', 'Task prompt (starts the TUI, or a one-shot run with -p / piped stdin)')
    .option('-p, --print', 'Headless: stream the answer to stdout, then exit')
    .option('--provider <id>', 'anthropic | openai | google')
    .option('--model <id>', 'Model id')
    .option('--base-url <url>', 'Override the provider base URL')
    .option('--api-key <key>', 'One-shot API key override (not persisted)')
    .option('--thinking <level>', 'off|minimal|low|medium|high|xhigh')
    .option('--max-tokens <n>', 'Output token cap')
    .option('--cwd <dir>', 'Working directory for tools')
    .option('--confirm', 'Confirm each mutating tool call')
    .option('--tool-timeout <ms>', 'Per-tool executor ceiling (default 180000)')
    .option('--idle-timeout <ms>', 'Watchdog idle timeout (auto-raised to >= tool-timeout+30s)')
    .option('--theme <name>', 'auto|warm|cool|light ("dark" is an alias for "cool")')
    // Same tri-state shape as `--fullscreen`: declaring the positive form first
    // keeps the default `undefined`, so "no opinion" stays distinguishable from
    // an explicit choice and the config layer below can still win.
    .option('--compact', 'Compact transcript density (no blank rows between turns)')
    .option('--no-compact', 'Comfortable transcript density')
    .option('--hints', 'Always show the composer hint row')
    .option('--no-hints', 'Hide the composer hint row')
    // Declaring `--fullscreen` BEFORE `--no-fullscreen` keeps the default
    // `undefined` instead of `true`, which is what makes the tri-state work:
    // "no opinion" must stay distinguishable from "force it".
    .option('--fullscreen', 'Force the full-screen TUI (overrides auto-downgrade, except non-TTY)')
    .option('--no-fullscreen', 'Force the inline renderer (v0.2.0 behavior)')
    .option('--no-exit-transcript', 'Do not replay the session summary after exiting')
    .option('--no-color', 'Disable ANSI color')
    .option('--quiet', '(print mode) suppress tool/usage lines on stderr')
    .action(async (prompt: string | undefined, opts: RawOpts) => {
      const flags = toFlags(opts);
      const piped = !process.stdin.isTTY;
      const oneShot = !!opts.print || piped;

      if (oneShot) {
        let text = prompt;
        if ((!text || text.trim().length === 0) && piped) {
          text = await readStdin();
        }
        if (!text || text.trim().length === 0) {
          process.stderr.write('No prompt provided for -p/--print mode.\n');
          process.exitCode = 2;
          return;
        }
        await runOneShot(flags, text, !!opts.quiet);
        return;
      }

      if (!process.stdout.isTTY) {
        // No interactive terminal available — fall back to headless if we have a prompt.
        if (prompt && prompt.trim().length > 0) {
          await runOneShot(flags, prompt, !!opts.quiet);
        } else {
          process.stderr.write('Not a TTY and no prompt given - nothing to do. Use -p "<prompt>".\n');
          process.exitCode = 2;
        }
        return;
      }

      runInteractive(flags, { initialPrompt: prompt });
    });

  // aragon config [set <key> <value> | path]
  const configCmd = program
    .command('config')
    .description('Open the settings screen')
    .action(() => {
      runInteractive(toFlags(program.opts()), { initialOverlay: 'settings' });
    });

  configCmd
    .command('set <key> <value>')
    .description('Write a single config value')
    .action((key: string, value: string) => runConfigSet(key, value));

  configCmd
    .command('path')
    .description('Print the config file path')
    .action(() => {
      process.stdout.write(`${getConfigPath()}\n`);
    });

  // aragon models [--provider p]
  program
    .command('models')
    .description('List builtin + discovered models')
    .option('--provider <id>', 'anthropic | openai | google')
    .action(async (opts: { provider?: string }) => {
      // The root program also declares `--provider`, so commander routes
      // `aragon models --provider x` onto the parent's options; fall back to it.
      const provider = opts.provider ?? (program.opts() as { provider?: string }).provider;
      await runModels(toFlags(program.opts()), provider);
    });

  return program;
}

async function main(): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(process.argv);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exitCode = 1;
});
