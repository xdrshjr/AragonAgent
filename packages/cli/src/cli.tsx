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

import '../runtime/insecure-tls-warning.cjs';

// Must precede every other dependency that imports Ink: CI detection is cached.
import { render } from './ui/ink-runtime.js';
import React from 'react';
import { Command } from 'commander';
import { ModelProfileConfigError } from './config/model-profile-store.js';
import { loadConfig, type CliFlags } from './config/load.js';
import { getConfigPath, readConfigFile, updatePersistedConfig } from './config/store.js';
import { formatMigrationNotice, migrateLegacyState } from './config/migrate-legacy-state.js';
import { formatHomeMigrationNotice, migrateToHome } from './config/migrate-home.js';
import { migrateStateOutOfConfig } from './config/migrate-state-out-of-config.js';
import { runHistoryCommand, type HistoryCliOptions } from './config/history-commands.js';
import {
  COMPACTION_CONFIG_SET_KEYS,
  FAST_CONFIG_SET_KEYS,
  LOG_CONFIG_SET_KEYS,
  RETRY_CONFIG_SET_KEYS,
  TEAM_CONFIG_SET_KEYS,
  UPDATE_CONFIG_SET_KEYS,
  applyCompactionConfigSet,
  applyFastConfigSet,
  applyLogConfigSet,
  applyRetryConfigSet,
  applyTeamConfigSet,
  applyUpdateConfigSet,
  runConfigEdit,
  runConfigGet,
  runConfigHome,
  runConfigList,
  warnIfRedactionDisabled,
} from './config/cli-commands.js';
import {
  attachAgentEvents,
  attachTeamEvents,
  installLogging,
  setScreenRestore,
  setSignalTerminator,
  type PendingNote,
} from './logging/install.js';
import { getLogger } from './logging/logger.js';
import { runLogsCommand, type LogsCliOptions } from './logging/cli-commands.js';
import {
  ADAPTER_PROVIDERS,
  clampDensity,
  clampTheme,
  clampThinkingLevel,
  clampAskRounds,
  clampHumanTimeout,
  clampSkillsIntegrity,
  clampSkillsToolPolicy,
  clampContextWindow,
  clampMaxRenderInterval,
  clampScrollResumeMs,
  clampTranscriptRetain,
  clampTranscriptWindow,
  coercePositiveInt,
  isAdapterProvider,
  isAutoToken,
  parseMaxTokensInput,
  DEFAULT_MAX_RENDER_INTERVAL_MS,
  DEFAULT_MAX_TOKENS,
  DEFAULT_PLAN_HUMAN_TIMEOUT_MS,
  DEFAULT_PLAN_MAX_ASK_ROUNDS,
  DEFAULT_SCROLL_RESUME_MS,
  DEFAULT_SKILLS_CONFIG,
  DEFAULT_TRANSCRIPT_RETAIN,
  DEFAULT_TRANSCRIPT_WINDOW,
  type PersistedConfig,
} from './config/schema.js';
import { makeGetApiKey } from './config/load.js';
import { AgentController, DENY_ALL_APPROVAL } from './agent/controller.js';
import { runSkillsCommand, type SkillsCliOptions } from './skills/cli-commands.js';
import { runHeadless } from './agent/headless.js';
// The four `register*Command` entry points of cli-integration-surface §3.1. The
// declarations live in those modules rather than here; see the header of
// `exec/cli-commands.ts` for why this new code departs from the `logs` /
// `history` / `skills` convention.
import { registerExecCommand } from './exec/cli-commands.js';
import { registerSessionsCommand } from './session/cli-commands.js';
import { registerDoctorCommand, registerInfoCommand } from './diagnostics/cli-commands.js';
import type { ToolPermission } from './exec/permission.js';
import { App, type AppProps, type ConfirmBridge } from './ui/App.js';
import { createFrameDiffer } from './ui/frame-differ.js';
import { wrapStdoutForFrames } from './ui/stdout-frame-writer.js';
import { setFrameStatsProvider } from './commands/perf.js';
import { tryCreateStdinFilter } from './input/stdin-filter.js';
import type { PasteBridge } from './input/limits.js';
import { createScrollbarBridge } from './ui/scrollbar-controller.js';
import { createPointerRouter } from './input/pointer-router.js';
import { createFrameObserver } from './ui/frame-observer.js';
import { enterAltScreen, writeExitTranscript, type ScreenHandle } from './ui/screen.js';
import { supportsWindowsVtInput } from './ui/win-vt-input.js';
import { forceWindowsVtInput } from './ui/win-vt-force.js';
import { readExitSnapshot } from './ui/exit-snapshot.js';
import { renderTranscriptText } from './ui/transcript-text.js';
import { detectCapabilities } from './ui/capabilities.js';
import { pickGlyphs } from './ui/glyphs.js';
import { getTheme } from './ui/theme.js';
import {
  createSelectionController,
  type SelectionBridge,
} from './ui/selection/selection-controller.js';
import type { Overlay } from './agent/reducer.js';
import type { ConfirmRequest } from './tools/index.js';
import { DENY_ALL_HUMAN_INPUT, type HumanInputBridge } from './tools/human-input.js';
// `import type` ONLY, and that is the whole of AC-1's first clause (C-16 /
// P1-7 / D-25). `runOneShot` and `runInteractive` live in THIS module and there
// is no bundler, so a value import from `update/` would put the entire
// subsystem in `dist/cli.js`'s graph and `aragon -p` would evaluate every one of
// its modules. The service is reached through `await import(...)` below; this
// specifier is erased by tsc.
import type { UpdateBridge, UpdateSnapshot } from './update/types.js';
// A VALUE import, and the one deliberate exception to the paragraph above
// (cli-auto-update-hardening P2-7). `boot/guard.js` statically pulls
// `update/state.js`, so `aragon -p` now EVALUATES that module - it is pure at
// module scope, calls nothing, and `update-wiring.test.ts` walks the transitive
// graph against an allow-list so it cannot quietly grow. The alternative, a
// dynamic import for a two-line disarm on the hottest path in the file, buys
// nothing: the guard has already loaded and read the same module milliseconds
// earlier, in the launcher.
import { markBootHealthy } from './boot/guard.js';

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
  showThinking?: boolean;
  liveToolOutput?: boolean;
  mouse?: boolean;
  mouseSelect?: boolean;
  paste?: boolean;
  skills?: boolean;
  skill?: string[];
  skillsYes?: boolean;
  skillToolPolicy?: string;
  plan?: boolean;
  team?: boolean;
  teamMax?: string;
  todo?: boolean;
  todoPanel?: boolean;
  todoFollow?: string;
  retry?: boolean;
  retryMax?: string;
  fast?: boolean;
  fastModel?: string;
  fastProvider?: string;
  fastReview?: string;
  fastDelegate?: boolean;
  logLevel?: string;
  logFile?: boolean;
  logDir?: string;
  verbose?: boolean;
  transcriptRetain?: string;
  renderGovernor?: boolean;
  maxRenderInterval?: string;
  diffRender?: boolean;
  syncOutput?: boolean;
  update?: boolean;
  compaction?: boolean;
  compactionThreshold?: string;
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
    exitTranscript: opts.exitTranscript,
    compact: opts.compact,
    hints: opts.hints,
    // Without this line the flag never reaches `CliFlags` and `--show-thinking`
    // is inert -- the failure the `mouse` note below records (P1-2).
    showThinking: opts.showThinking,
    // And again for the live tail, one feature later. The pair is declared in
    // both directions below because `liveToolOutput` is PERSISTED and defaults
    // to `true`: a lone `--no-live-tool-output` would make commander default
    // `opts.liveToolOutput` to `true`, which is indistinguishable from silence.
    liveToolOutput: opts.liveToolOutput,
    // Without this line the flag never reaches `CliFlags` and `--no-mouse` is
    // inert — a failure with no compile error and no runtime error (P1-2).
    mouse: opts.mouse,
    // Site three of three for `--mouse-select` / `--no-mouse-select` — NINE
    // features, one trap. A flag needs the `.option()` declaration below, a field
    // on `CliFlags`, AND a line here; `config.test.ts` is the regression pin that
    // exists because `--no-mouse` shipped inert once already.
    mouseSelect: opts.mouseSelect,
    // Site three of three for `--paste` / `--no-paste` -- TEN features, one
    // trap. A flag needs the `.option()` declaration below, a field on
    // `CliFlags`, AND a line here; `config.test.ts` is the regression pin that
    // exists because `--no-mouse` shipped inert once already.
    paste: opts.paste,
    skills: opts.skills,
    skill: opts.skill,
    skillsYes: opts.skillsYes,
    skillToolPolicy: opts.skillToolPolicy,
    plan: opts.plan,
    // These two lines are the same failure the `mouse` note above records, one
    // feature later (P1-4): without them `--no-team` and `--team-max` never
    // reach `CliFlags` and are inert, with no compile error and no runtime error.
    team: opts.team,
    teamMax: opts.teamMax,
    // Site three of three for `--todo` / `--todo-panel`, and the one this
    // package has now paid for twice (`mouse` P1-2, `team` P1-4): a flag needs
    // the `.option()` declaration below, a field on `CliFlags`, AND a line here.
    // Miss this one and the flag is inert with no compile error and no runtime
    // error.
    todo: opts.todo,
    todoPanel: opts.todoPanel,
    // Site three of three for `--todo-follow` as well (todo-plan-followthrough
    // C-9). A value flag is no less inert than a boolean one when this line is
    // missing.
    todoFollow: opts.todoFollow,
    // Site three of three for `--retry` / `--retry-max` — five features, same
    // trap (`mouse` P1-2, `team` P1-4, `todo` C-9, render L4, now retry). A flag
    // needs the `.option()` declaration below, a field on `CliFlags`, AND a line
    // here; miss this one and the flag is inert with no compile or runtime error.
    retry: opts.retry,
    retryMax: opts.retryMax,
    // Site three of three for the four `--fast*` flags — SIX features, one trap
    // (`mouse` P1-2, `team` P1-4, `todo` C-9, render L4, retry, now fast). It
    // bites hardest here: the tier is OFF by default, so a missing line would
    // make `--fast` a flag that reports nothing and does nothing.
    fast: opts.fast,
    fastModel: opts.fastModel,
    fastProvider: opts.fastProvider,
    fastReview: opts.fastReview,
    // …and again for `--fast-delegate` / `--no-fast-delegate`, one feature
    // later — NINE features, one trap. It is `fast.delegate`'s only channel:
    // there is no `ARAGON_FAST_DELEGATE`, so missing this line leaves a wrapper
    // with no way at all to say "do not delegate on this run".
    fastDelegate: opts.fastDelegate,
    // `--verbose` is just a shorthand for `--log-level debug`; an explicit
    // `--log-level` still wins, so the two can be combined without surprise.
    logLevel: opts.logLevel ?? (opts.verbose ? 'debug' : undefined),
    logFile: opts.logFile,
    logDir: opts.logDir,
    // Site three of three for the render-performance flags. A flag needs the
    // `.option()` declaration below, a field on `CliFlags`, AND a line here;
    // miss this one and it is inert with no compile error and no runtime error
    // (`mouse` P1-2, `team` P1-4, `todo` C-9 -- four features, same trap).
    transcriptRetain: opts.transcriptRetain,
    renderGovernor: opts.renderGovernor,
    maxRenderInterval: opts.maxRenderInterval,
    // Site three of three for `--diff-render` / `--sync-output` — EIGHT
    // features, one trap (`mouse` P1-2, `team` P1-4, `todo` C-9, render L4,
    // retry, fast, update, now frame diffing). A flag needs the `.option()`
    // declaration below, a field on `CliFlags`, AND a line here; miss this one
    // and the flag is inert with no compile error and no runtime error. It bites
    // hardest for `--no-diff-render`: that is the documented escape hatch for a
    // user whose terminal renders the diffed frame wrongly, and a user who has
    // been told to pass it and sees no change has no next move.
    diffRender: opts.diffRender,
    syncOutput: opts.syncOutput,
    // Site three of three for `--update` / `--no-update` — SEVEN features, one
    // trap (`mouse` P1-2, `team` P1-4, `todo` C-9, render L4, retry, fast, now
    // update). A flag needs the `.option()` declaration below, a field on
    // `CliFlags`, AND a line here; miss this one and the flag is inert with no
    // compile error and no runtime error. It bites hardest here of all: this is
    // the KILL SWITCH for a feature that installs software, so a missing line
    // means `--no-update` reports nothing, does nothing, and leaves the updater
    // running.
    update: opts.update,
    // Site three of three for `--compaction` / `--no-compaction` — NINE
    // features, one trap. A flag needs the `.option()` declaration below, a field
    // on `CliFlags`, AND a line here; miss this one and the flag is inert with no
    // compile error and no runtime error. It bites here for the same reason it
    // does one field up: this is the KILL SWITCH for a feature that spends the
    // user's money on a summarizer, so a missing line means `--no-compaction`
    // reports nothing, does nothing, and leaves compaction armed.
    compaction: opts.compaction,
    compactionThreshold: opts.compactionThreshold,
  };
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

/**
 * Build the controller for a mode.
 *
 * TWO DIFFERENT APPROVAL CHANNELS, AND THEY MUST NOT BE CONFLATED:
 *
 *   `confirm`  — the `--confirm` gate for mutating tools. Its `handler === null`
 *                fallback is `Promise.resolve(true)`, which is fine because that
 *                path is opt-in and only reachable with the TUI mounted.
 *
 *   `approval` — the skill-install gate. It PROBES for a human first and denies
 *                when there is none (D17 / §8.3.1). Passing the `confirm`
 *                closure here instead would inherit the auto-approve fallback
 *                and make `requireApproval: true` a no-op under `-p`, silently.
 *
 * `interactive: false` (the headless path) gets the deny-all gate, so a model
 * calling `skill_install` in `-p` mode is refused with an actionable message
 * instead of writing to disk unattended.
 */
function makeController(
  flags: CliFlags,
  opts: {
    interactive: boolean;
    /**
     * `aragon exec`'s tool policy (cli-integration-surface §4.2). Spread into
     * `ControllerDeps` so every other caller builds today's deps object exactly,
     * which is what keeps the tool array provably unchanged for the TUI and `-p`.
     */
    permission?: ToolPermission;
    /** `aragon exec --append-system-prompt` text (§4.1). */
    appendSystemPrompt?: string;
  } = { interactive: true },
): {
  controller: AgentController;
  confirmBridge: ConfirmBridge;
  humanInputBridge: HumanInputBridge;
} {
  const config = loadConfig(flags);
  // The authoritative log level lands here (§4.4.5). `installLogging()` only
  // resolved a bootstrap level — it ran before commander and before `.env` were
  // readable — and without this hand-off the fully resolved one never applies.
  getLogger().reconfigure(config.log);
  // Headless controllers never expose the task panel.
  const todoPanelCapable = opts.interactive;
  const confirmBridge: ConfirmBridge = { handler: null };
  // `cancelPending` is replaced by the App's own implementation on mount; this
  // no-op keeps the object total so nothing has to null-check it.
  const humanInputBridge: HumanInputBridge = { handler: null, cancelPending: () => {} };
  const controller = new AgentController(config, {
    version: VERSION,
    todoPanelCapable,
    confirm: (req: ConfirmRequest) =>
      confirmBridge.handler ? confirmBridge.handler(req) : Promise.resolve(true),
    approval: opts.interactive
      ? {
          // Read live on every call: the App's effect cleanup nulls the handler
          // on unmount, and a cached `true` would keep the gate open after the
          // human channel is gone.
          canPrompt: () => confirmBridge.handler !== null,
          request: (req: ConfirmRequest) =>
            confirmBridge.handler ? confirmBridge.handler(req) : Promise.resolve(false),
        }
      : DENY_ALL_APPROVAL,
    notify: (level, text) => {
      if (!opts.interactive) process.stderr.write(`[skills] ${level}: ${text}\n`);
    },
    // A THIRD approval channel, and it must not be conflated with the other two.
    // `confirm` auto-approves when unattached and `approval` denies; neither can
    // render a question wizard or a plan card. Headless gets the fail-closed
    // gate, whose STATIC `neverPrompts` is also what stops `createPlanTools`
    // registering two tools the model could never use there.
    humanInput: opts.interactive
      ? {
          // Live probe, never cached — same contract as `approval` above.
          canPrompt: () => humanInputBridge.handler !== null,
          request: (req, signal) =>
            humanInputBridge.handler
              ? humanInputBridge.handler(req, signal)
              : Promise.resolve(null),
        }
      : DENY_ALL_HUMAN_INPUT,
    ...(opts.permission ? { permission: opts.permission } : {}),
    ...(opts.appendSystemPrompt ? { appendSystemPrompt: opts.appendSystemPrompt } : {}),
  });
  return { controller, confirmBridge, humanInputBridge };
}

/**
 * The controller factory `aragon exec` runs on.
 *
 * IT REPRODUCES `runOneShot`'s SETUP EXACTLY, and that is the whole reason it
 * lives here rather than inside `exec/`: the deny-all approval gate, the
 * deny-all human-input channel, the two log attachments and the untrusted-skill
 * notices are decisions `makeController`'s own comment says must have ONE
 * definition. `exec/index.ts` receives this as a parameter, which also keeps
 * `cli.tsx -> exec/cli-commands.ts -> exec/index.ts` acyclic.
 */
function makeExecController(
  flags: CliFlags,
  deps: { permission?: ToolPermission; appendSystemPrompt?: string },
): AgentController {
  const { controller } = makeController(flags, { interactive: false, ...deps });
  const logger = getLogger();
  logger.info('cli', 'run_exec', {});
  logger.onFailure((reason) => process.stderr.write(`[log] ${reason}\n`));
  attachAgentEvents(logger, controller);
  attachTeamEvents(logger, controller);
  for (const dir of controller.getSkillService().untrustedDirs()) {
    // STDERR, NEVER STDOUT. In `json` / `stream-json` mode stdout carries
    // nothing but the schema, and a notice on it would corrupt every consumer.
    process.stderr.write(
      `[skills] project skills in ${dir} skipped (untrusted). Run: aragon skills trust ${dir}\n`,
    );
  }
  return controller;
}

/**
 * Raised once per session, on the 0->1 edge of the writer's `fallbacks` counter
 * (tui-input-flicker-fix §5.6 / AC-15).
 *
 * The characteristic failure of frame diffing is SILENT — absolute addressing
 * loses its origin and the user sees a subtly wrong screen — so leaving its only
 * signal behind a slash command the affected user has no reason to run is not an
 * acceptable end state for a fix whose whole premise is "the user should not have
 * to notice the renderer". `warn`, not `error`: a single fallback is self-healing
 * by construction (I-6), and it is worth reporting only because the PATTERN is
 * not.
 */
const FRAME_FALLBACK_NOTICE =
  'Frame diffing lost sync with the terminal and fell back to a full repaint. ' +
  'If the display looks wrong, restart with `--no-diff-render`.';

/**
 * Make this console deliver `CSI Z`, on a Node that will not do it for us
 * (shift-tab-mode-toggle-still-dead-on-windows, C1).
 *
 * Returns whether the console now reports; never throws. `false` means nothing
 * changed and the session runs exactly as it did before this feature existed,
 * with `MODE_TOGGLE_KEYS.fallback` carrying the mode toggle instead.
 *
 * RAW MODE IS RAISED HERE, AND THE ORDER IS THE ENTIRE MECHANISM. libuv rewrites
 * the whole console mode on every raw-mode TRANSITION, and its pre-22.17 path
 * does not know about this bit - so setting the bit first and letting Ink raise
 * raw mode afterwards clears it again, measured (analysis section 3.3). Raising
 * it first inverts that: `uv_tty_set_mode` returns early when the mode is
 * unchanged, so Ink's own `setRawMode(true)` at mount is a no-op and the bit
 * survives to the first keypress.
 *
 * That same asymmetry is why there is no restore call anywhere. Ink lowers raw
 * mode when it unmounts, and that transition IS the restore - it is the only
 * thing that ever clears the bit, since neither Windows nor the console does
 * (section 3.5b). The `exit` hook exists for the paths that never unmount
 * (`taskkill`, a closed terminal window, a crash), which are exactly the
 * unattended ones where a console left in VT-input mode has nobody to notice.
 *
 * WHY THIS RUNS BEFORE `render()` rather than from an effect inside `App`: the
 * answer gates `wantMouse`, which decides the `?1000h` write and the filter
 * BEFORE Ink mounts. Learning the truth one tick too late would mean the wheel
 * stays off for the whole session on a console we just repaired.
 */
function forceVtInputForThisConsole(): boolean {
  if (process.platform !== 'win32' || !process.stdin.isTTY) return false;
  const logger = getLogger();
  try {
    process.stdin.setRawMode(true);
  } catch (err) {
    // A TTY that refuses raw mode is not a console we can repair; C2 carries it.
    logger.warn('cli', 'vt_input_rawmode_failed', { error: (err as Error).message });
    return false;
  }
  process.on('exit', () => {
    try {
      process.stdin.setRawMode(false);
    } catch {
      /* Stream already torn down — nothing left to restore. */
    }
  });
  const result = forceWindowsVtInput();
  if (result.ok) {
    logger.info('cli', 'vt_input_forced', { before: result.before, after: result.after });
    return true;
  }
  // Constrained Language Mode kills `Add-Type`, an old conhost drops the bit it
  // does not implement, and `wrong_console` means we configured somebody else's
  // console. All three are ordinary on the fleets this bug keeps landing on, so
  // they degrade in silence and only the log says which one happened.
  logger.warn('cli', 'vt_input_force_failed', {
    reason: result.reason,
    ...(result.detail ? { detail: result.detail } : {}),
  });
  return false;
}

/**
 * The interactive TUI — and the ONLY place that may touch the screen.
 *
 * Screen take-over stays inside this function on purpose (§4.4). Hoisting it up
 * to `buildProgram()` / `parseAsync` would push `\x1b[?1049h` into `aragon -p
 * "…" > out.txt`, `aragon config set`, and `aragon --version`, because the
 * interactive and headless paths are disjoint branches: `runInteractive()`
 * renders Ink, `runOneShot()` goes to `runHeadless()`, which never does.
 */
function runInteractive(
  flags: CliFlags,
  extras: { initialPrompt?: string; initialOverlay?: Overlay } = {},
): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write('Interactive UI requires a TTY. Use -p "<prompt>", exec, or config list / config set.\n');
    process.exitCode = 2;
    return;
  }
  const { controller, confirmBridge, humanInputBridge } = makeController(flags);
  const config = controller.getConfig();
  const logger = getLogger();
  logger.info('cli', 'run_interactive', { mode: 'fullscreen', provider: config.provider, model: config.model });
  attachAgentEvents(logger, controller);
  // The team stream is CLI-local (D-10), so `attachAgentEvents` cannot see it.
  // Without this a dispatch leaves NO trace in the log file at all — the wrong
  // outcome for the one feature here that runs five agents the user cannot
  // watch (§3.13 / P1-2 / R-19).
  attachTeamEvents(logger, controller);

  let screen: ScreenHandle | null = null;
  let replayed = false;

  // --- Mouse wheel region routing (mouse-wheel-region-routing §4.2). -------
  //
  // BUILD THE FILTER FIRST, THEN ENABLE REPORTING. The order is invariant I-8
  // and it is not negotiable: `\x1b[?1000h` tells the terminal to send SGR
  // reports, and Ink 5.2.1 has no mouse branch at all, so any report that
  // reaches its key parser is INSERTED INTO THE USER'S MESSAGE (`[` is 0x5B, so
  // `PromptInput`'s `isControlSeq` guard passes it). A window in which
  // reporting is on and Ink holds the raw stream is not a degraded feature — it
  // is every click typing `[<0;12;5M` into the composer, strictly worse than
  // the bug being fixed.
  //
  // `tryCreateMouseFilter` returns `null` rather than throwing, so a
  // construction failure degrades to "the wheel is inert" (rung 3 of the
  // fail-safe ladder), never to "reporting on, no filter".
  // BOTH streams have to be terminals. `stdout.isTTY` is what decides whether
  // `enterAltScreen` writes anything at all, but the reports come back on
  // STDIN, so a TTY stdout with a piped stdin (`aragon config < file`, which
  // reaches `runInteractive` without the stdin check the default action makes)
  // would wrap a stream no report can ever arrive on and ask the terminal to
  // start reporting anyway. §4.2's "non-TTY ⇒ no filter" covers both ends.
  //
  // R-1 IS DECIDED HERE, AND ONLY HERE (shift-tab-and-mouse-wheel-dead-on-some-
  // terminals, F1'). On a Windows console whose Node never sets
  // `ENABLE_VIRTUAL_TERMINAL_INPUT`, libuv drops every non-KEY_EVENT record
  // before it reaches this process, so `\x1b[?1000h` is a pure no-op and the
  // filter has nothing to filter. Gating `wantMouse` — rather than the three
  // things downstream of it — is what keeps the three in agreement: the
  // `?1000h` write (`enterAltScreen(..., { mouse: mouseOn })`), the
  // filter itself, and the `mouseSource` prop that decides whether the user is
  // advised about a mode that is not running. Wiring any of them separately
  // re-opens the gap where the app claims a capability it does not have.
  //
  // AND `vtInputSupported` IS NOW A MEASUREMENT, NOT A PREDICTION
  // (shift-tab-mode-toggle-still-dead-on-windows, C1). It used to be exactly
  // `supportsWindowsVtInput(...)` - "is this Node new enough to turn the bit on
  // for us?". We now turn it on ourselves when it is not, so continuing to gate
  // on the Node version would switch the wheel off, and keep the warning up, on
  // a console this process just repaired.
  const vtInputByNode = supportsWindowsVtInput(process.platform, process.versions.node);
  const vtInputSupported = vtInputByNode || forceVtInputForThisConsole();
  const wantMouse =
    config.mouse &&
    !!process.stdout.isTTY &&
    !!process.stdin.isTTY &&
    vtInputSupported;

  // --- Paste handling (tui-paste-handling section 5.1.1 / D-13 / D-17). ----
  //
  // THE GATE IS WIDER THAN THE MOUSE'S, AND `paste` DEFAULTS TO TRUE. Paste
  // needs no `vtInputSupported` and no full-screen: Tier 2 is a heuristic on
  // chunk shape and needs no terminal cooperation at all, which is exactly why
  // it exists for the consoles that never deliver `\x1b[200~` (R-11).
  //
  // WHAT THIS WIDENING BREAKS IF IT IS NOT PAIRED WITH `mouseOn` BELOW (P0-1).
  // `filter !== null` used to be the answer to FIVE questions, only one of which
  // is really about the stream. With paste able to build a filter on its own,
  // `aragon --no-mouse` would get a non-null handle and every one of those five
  // would flip true: `?1000h`/`?1006h`/`?1002h` written, terminal selection taken
  // away (the ONLY reason anyone passes `--no-mouse`), and a startup notice
  // advising the user about a mode they just disabled.
  const wantPaste = config.paste && !!process.stdin.isTTY;
  const pasteBridge: PasteBridge = { notify: null };
  const filter =
    process.stdin.isTTY
      ? tryCreateStdinFilter(
          process.stdin,
          { mouse: wantMouse, paste: wantPaste },
          (reason: string) => logger.warn('cli', 'stdin_filter_failed', { reason }),
          pasteBridge,
        )
      : null;

  /**
   * THE ONE EXPRESSION EVERY MOUSE SITE READS (I-11 / D-17).
   *
   * `filter !== null` now answers exactly one question -- "is a stream wrapped?"
   * -- and the only site allowed to keep reading it is the `stdin` handed to
   * `render()`.
   */
  const mouseOn = wantMouse && filter !== null;
  /** Same discipline for DEC 2004: already decided here, never re-derived. */
  const pasteOn = wantPaste && filter !== null;
  const disposeStdinFilter = (): void => filter?.dispose();

  // --- Drag-select (tui-selection-and-scroll-follow §4.4). ------------------
  //
  // Selection owns its controller, decoration and notice. Button motion follows
  // mouseOn independently so --no-mouse-select still permits scrollbar dragging.
  const wantSelect = mouseOn && config.mouseSelect;
  let mouseCaptured = mouseOn;
  const scrollbar = createScrollbarBridge(() => mouseCaptured);
  const pointerRouter = mouseOn && filter ? createPointerRouter({
    source: filter.source, handle: (event) => scrollbar.controller?.handle(event) ?? false,
  }) : null;
  const selectionBridge: SelectionBridge = {
    controller: null,
    onCopied: null,
    requestRedraw: null,
  };

  const frameWriter =
    config.diffRender
      ? wrapStdoutForFrames(
          process.stdout,
          createFrameDiffer({
            sync: config.syncOutput && process.env.TERM !== 'dumb',
            rows: () => process.stdout.rows,
            // Rows that fill the line skip `CSI K` so the scrollbar's last column
            // is not erased on pending-wrap terminals (frame-differ I-4).
            cols: () => process.stdout.columns,
            // The console bridge (`App.tsx`, full-screen only) turns this into
            // `dispatch({type:'notice', level:'warn'})`, which is the only legal
            // user-visible channel with the TUI mounted — a direct write would
            // itself be the foreign write being reported. Latched on the 0->1
            // edge inside the differ: a notice per fallback would be a repaint
            // storm triggered by a repaint problem (§5.6).
            onFirstFallback: () => console.warn(FRAME_FALLBACK_NOTICE),
            // ABSENT ENTIRELY without drag-select, not a no-op function: the
            // differ's identity path then allocates nothing and copies nothing,
            // which is what makes `mouseSelect: false` a statement about the code
            // rather than about how cheap an empty function is.
            ...(wantSelect
              ? {
                  decorate: (lines: string[]) =>
                    selectionBridge.controller?.decorate(lines) ?? lines,
                  // P1-7: a pass-through frame writes the RAW Ink frame verbatim,
                  // so the highlight is wiped off the terminal while the
                  // controller still believes it is painted. Deferred out of the
                  // current stack because this fires from inside `transform`,
                  // which is inside Ink's own `stdout.write`.
                  onInvalidate: () => {
                    const controller = selectionBridge.controller;
                    if (controller) setImmediate(() => controller.clear());
                  },
                }
              : {}),
          }),
        )
      : null;
  // `null` when no writer was built, so `/perf` can say "diff render off" rather
  // than printing zeroes that read like a writer doing nothing (§5.4).
  if (frameWriter) setFrameStatsProvider(frameWriter.stats);
  const frameObserver = createFrameObserver({
    stdout: frameWriter?.stdout ?? process.stdout, terminal: process.stdout, scrollbar,
  });
  const disposeFrameWriter = (): void => {
    frameObserver.dispose();
    pointerRouter?.dispose();
    scrollbar.controller?.dispose();
    if (!frameWriter) return;
    setFrameStatsProvider(null);
    frameWriter.dispose();
  };

  const replayTranscript = (): void => {
    if (replayed || !config.exitTranscript) return;
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
        // Names what the retain ring removed, so a long session's replay never
        // starts mid-conversation without saying why (tui-render-performance
        // L1 / K-6).
        ...(snapshot.droppedEntries ? { droppedEntries: snapshot.droppedEntries } : {}),
      }),
    );
  };

  {
    // `mouse` here means "a mouse-parsing filter is installed", NOT "the user
    // wants mouse support" — see `AltScreenOptions`. `screen.ts` must never
    // derive it for itself, or a later refactor re-opens the gap I-8 closes.
    // `motion` carries the same discipline for `?1002h`, and `bracketedPaste`
    // for `?2004h`: all three are already decided, none is re-derived.
    //
    // IT IS `mouseOn`, NOT `filter !== null` (P0-1). A `--no-mouse` session with
    // paste at its default `true` still builds a filter, and passing the handle
    // here would write `?1000h` at a user who disabled the mouse precisely to
    // keep their terminal's own selection.
    screen = enterAltScreen(process.stdout, {
      mouse: mouseOn,
      motion: mouseOn,
      bracketedPaste: pasteOn,
    });
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

    // The signal listeners themselves now belong to `installLogging()`, which
    // registered them before this function ever ran — and a second listener per
    // signal would race the first. This branch owns the SCREEN, so it supplies
    // the two screen-shaped pieces and nothing else: the crash handler calls
    // `screenRestore` before printing a stack (otherwise the stack vanishes with
    // the alternate screen), and the signal path restores before exiting.
    setScreenRestore(restore);
    setSignalTerminator((signo) => {
      restore(); // Synchronous: stdout.write on a TTY is sync on every platform.
      process.exit(128 + signo);
    });
  }

  const writeForeign: ((text: string) => void) | null = frameWriter
    ? (text: string) => { frameObserver?.invalidate(); frameWriter.writeForeign(text); }
    : process.stdout.isTTY
    ? (text: string) => {
        try {
          process.stdout.write(text);
        } catch {
          // A closed or broken stdout must never turn a copy into a crash.
        }
      }
    : null;

  // --- The selection controller (§4.4). ------------------------------------
  //
  // BUILT AFTER `enterAltScreen` AND BEFORE `render()`. After, because it must
  // not exist on a session that never asked the terminal to report motion;
  // before, because `decorate` is read by the differ from the very first frame
  // Ink produces.
  //
  // `mouseCaptured` is the run-time answer for `/mouse`, and it lives here rather
  // than inside `screen.ts`'s closure because `App` needs to READ it and the
  // handle's own flag is private (it has to be — `restore()` reads it, and
  // exposing a setter would be a second way to get the two out of step).
  if (wantSelect && filter) {
    selectionBridge.controller = createSelectionController({
      source: pointerRouter?.selectionSource ?? filter.source,
      // The frame writer is absent under `--no-diff-render`, where there is no
      // cache to repaint from at all; the controller then falls back to asking
      // `App` for a React redraw on every drag flush, which is slower and
      // correct. That is rung 2 of the fail-safe ladder doing its job.
      repaint: () => frameWriter?.repaint() ?? false,
      requestRedraw: () => selectionBridge.requestRedraw?.(),
      // The copy decision moved UP to `App` (tui-shift-enter-copy-queue
      // 4.2.4): Ctrl+C with a settled selection is routed there, through
      // the SAME `copyText` door and the SAME bridge `onCopied` toast
      // funnel -- the controller keeps only the selection state machine.
      // Read at PAINT time, not captured: `/theme` rebuilds the theme mid-session.
      theme: () => getTheme(config.theme, detectCapabilities(process.env, process.stdout)),
      caps: detectCapabilities(process.env, process.stdout),
      cols: () => process.stdout.columns ?? 80,
      // The STATIC half of the gate. The dynamic half — "no overlay is open" —
      // belongs to `App`, which owns that state and calls `setEnabled`.
      isSelectable: () => mouseCaptured,
    });
  }
  const disposeSelection = (): void => {
    selectionBridge.controller?.dispose();
    selectionBridge.controller = null;
  };

  const terminalBridge: AppProps['terminal'] =
    {
          mouseSelect: wantSelect,
          deleteDisambiguated: filter !== null,
          scrollbar,
          ...(mouseOn
            ? {
                setMouseCapture: (on: boolean) => {
                  screen?.setMouseCapture(on);
                  mouseCaptured = on;
                  if (!on) scrollbar.controller?.cancel();
                  // A released mouse cannot be dragging, and a selection left
                  // painted over a screen the terminal is now selecting on its
                  // own would be two highlights claiming the same rows.
                  if (!on) selectionBridge.controller?.clear();
                },
                isMouseCaptured: () => mouseCaptured,
              }
            : {}),
          // The same door the controller copies through, so `/copy` and a
          // drag-release can never disagree about which stream OSC 52 goes to.
          ...(writeForeign ? { writeForeign } : {}),
          ...(selectionBridge.controller ? { selection: selectionBridge } : {}),
        };

  const updateBridge: UpdateBridge = { service: null, onAttach: null };
  let updateService: { dispose(): void } | null = null;
  let interactiveClosed = false;
  const failInteractive = (error: unknown): void => {
    // Ink consumes render exceptions; retain failure even if a disposer throws.
    process.exitCode = 1;
    interactiveClosed = true;
    logger.error('cli', 'render_failed', { error: String(error) });
    for (const cleanup of [
      () => screen?.restore(), disposeSelection, disposeStdinFilter, disposeFrameWriter,
      () => controller.abort(), () => controller.dispose(), () => updateService?.dispose(),
      () => { process.stdin.pause(); process.stdin.unref?.(); },
    ]) {
      try { cleanup(); }
      catch (cleanupError) {
        logger.error('cli', 'render_cleanup_failed', { error: String(cleanupError) });
      }
    }
  };
  const updateEligible =
    !!process.stdout.isTTY &&
    !!process.stdin.isTTY &&
    !process.env.CI &&
    config.update.mode !== 'off';

  let instance: ReturnType<typeof render>;
  try {
    instance = render(
    <App
      controller={controller}
      version={VERSION}
      confirmBridge={confirmBridge}
      humanInputBridge={humanInputBridge}
      initialPrompt={extras.initialPrompt}
      initialOverlay={extras.initialOverlay}
      mouseSource={mouseOn && filter ? filter.source : undefined}
      // Present ONLY when this console swallows `CSI Z` and mouse reports.
      // Passed in rather than probed inside `App` so that every test renders
      // the same tree on every machine — reading `process.versions.node` from
      // a component would make the notice appear or vanish according to which
      // Node the developer happened to have installed.
      vtInputWarning={
        vtInputSupported ? undefined : { nodeVersion: process.versions.node }
      }
      updateBridge={updateEligible ? updateBridge : undefined}
      // Absent when nothing can refuse a paste, so a `--no-paste` tree is
      // byte-identical to a build without this feature.
      pasteBridge={pasteOn ? pasteBridge : undefined}
      terminal={terminalBridge}
    />,
    // Full-screen owns console.* itself (I-4): Ink's patchConsole writes
    // straight to stdout and permanently shifts the fixed frame's accounting.
    {
      exitOnCtrlC: false,
      patchConsole: false,
      // I-5: with mouse support off the REAL stdin is handed over unwrapped, so
      // every existing path is provably unchanged.
      stdin: filter?.stdin ?? process.stdin,
      stdout: frameObserver.stdout,
    },
  );

  } catch (error) {
    failInteractive(error);
    throw error;
  }

  // H1's primary disarm, and this is the earliest moment at which "this build
  // STARTS" is proven: the module graph loaded, config resolved, Ink mounted
  // (cli-auto-update-hardening section 5.1.4). It is what makes a long session
  // that is later `SIGKILL`ed - terminal window closed, machine slept badly, OOM
  // killer - still count as healthy.
  //
  // UNGATED BY `updateEligible` ON PURPOSE. The guard is armed only by an
  // auto-install, which `mode: 'off'` already prevents, so on a machine that
  // never armed it this is one read and one string compare. Gating it would mean
  // a user who switches `mode` to `off` between the install and the next launch
  // leaves the guard armed with nothing able to disarm it.
  markBootHealthy(VERSION);

  if (updateEligible) {
    // DYNAMIC, and fire-and-forget AFTER `render()` (D-25). Dynamic because a
    // static import would make AC-1 false for `aragon -p`, which shares this
    // module and has no bundler to shake the subsystem out; after `render()`
    // because the service must never be able to delay or fail the first frame.
    // The `.catch` is not decoration: a subsystem that cannot even be imported
    // must degrade to "no updater", never to a crashed TUI.
    void import('./update/service.js')
      .then(({ UpdateService }) => {
        if (interactiveClosed) return;
        const service = new UpdateService({ config: config.update, currentVersion: VERSION });
        updateService = service;
        updateBridge.service = service;
        // `App` may have mounted first and parked its listener here; it may also
        // not have mounted yet, in which case its own effect reads
        // `bridge.service` directly. Both orders happen (IF-4).
        updateBridge.onAttach?.(service);
        service.start();
      })
      .catch((err: unknown) => {
        logger.warn('update', 'update_service_unavailable', {
          reason: err instanceof Error ? err.message : String(err),
        });
      });
  }

  // The return value MUST be captured — `waitUntilExit()` is the normal-exit
  // restore path and it cannot be registered otherwise. `dispose()` runs on
  // BOTH branches (I-7): a live `'data'` listener on stdin keeps the event loop
  // alive and `aragon` would never return to the shell. The signal path does
  // not need it — it calls `process.exit()`.
  //
  // RESTORE BEFORE DISPOSE. `restore()` writes `?1000l`, so the terminal stops
  // reporting first and anything already in flight is still consumed by a live
  // filter. Disposing first leaves a window — narrow, but real — in which the
  // terminal is still reporting and nothing is draining stdin, so a notch taken
  // in that instant survives in the OS buffer and is handed to the shell as
  // `[<64;12;5M` on exit. That is the I-2 failure mode, just smaller.
  void instance
    .waitUntilExit()
    .then(() => {
      interactiveClosed = true;
      screen?.restore();
      // BEFORE `disposeStdinFilter()`, which clears the listener set it subscribed to,
      // and after `restore()` for the reason that call records: the terminal must
      // stop reporting first, and anything already in flight is still consumed by
      // a live filter.
      disposeSelection();
      disposeStdinFilter();
      // BOTH BRANCHES, the same discipline `controller.dispose()` and
      // `updateService?.dispose()` already follow. It drops the `'resize'`
      // listener of I-8 and detaches the `/perf` provider so a later `/perf` in a
      // torn-down tree reports honestly instead of reading a dead closure.
      disposeFrameWriter();
      // Orphaned subagents survive `Ctrl+C` otherwise, and a live child holds
      // the event loop open so `aragon` never returns to the shell (R-15). The
      // App's unmount cleanup also calls this; `dispose()` is idempotent.
      controller.dispose();
      // BOTH BRANCHES, exactly as `controller.dispose()` is (section 3.6 / P2-6),
      // and idempotent for the same reason. It clears the timers and drops the
      // listeners; it NEVER signals the installer child (U-3), because killing a
      // running `npm install -g` is the one action here that can leave the
      // user's global installation broken - and it would be triggered by the
      // most ordinary event there is, the user pressing Ctrl+C. The signal path
      // above calls `process.exit()` and reaches neither branch, which is
      // correct and is precisely WHY U-3 matters: the detached child survives
      // that exit and completes.
      updateService?.dispose();
      replayTranscript();
    })
    .catch(failInteractive);
}

async function runOneShot(flags: CliFlags, prompt: string, quiet: boolean): Promise<void> {
  // Headless: no App is ever rendered, so there is no human to approve a skill
  // install. The gate must know that up front rather than discovering a null
  // handler and defaulting to "yes" (§7.4 / AC-13).
  const { controller } = makeController(flags, { interactive: false });
  const logger = getLogger();
  logger.info('cli', 'run_oneshot', { quiet });
  // Headless has no frame, so a logging failure can safely reach stderr — the
  // toast channel `App.tsx` uses does not exist here.
  logger.onFailure((reason) => process.stderr.write(`[log] ${reason}\n`));
  attachAgentEvents(logger, controller);
  // The team stream is CLI-local (D-10), so `attachAgentEvents` cannot see it.
  // Without this a dispatch leaves NO trace in the log file at all — the wrong
  // outcome for the one feature here that runs five agents the user cannot
  // watch (§3.13 / P1-2 / R-19).
  attachTeamEvents(logger, controller);

  const untrusted = controller.getSkillService().untrustedDirs();
  for (const dir of untrusted) {
    process.stderr.write(
      `[skills] project skills in ${dir} skipped (untrusted). Run: aragon skills trust ${dir}\n`,
    );
  }
  // `followThrough` is read off the REAL controller here rather than through
  // `HeadlessController`, which is deliberately the minimal surface a test can
  // satisfy with an object literal (todo-plan-followthrough §3.6).
  const code = await runHeadless(controller, prompt, {
    quiet,
    followThrough: controller.getTodoConfig().followThrough,
  });
  // Flushed HERE and not inside `runHeadless`: that module is deliberately
  // injectable (its own controller interface, its own stdout/stderr) and has an
  // early `return 2`, so a singleton dependency in there would be both a new
  // coupling and a branch that skips the flush. `process.on('exit')` remains the
  // real backstop; this just makes the common path immediate.
  getLogger().flushSync();
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
  // context-usage-gauge-accuracy §3.6. Listed here AND given its own branch in
  // `runConfigSet` below - a key present here but absent there falls through
  // every case, writes nothing, and still prints `Set contextWindow = 1000000`
  // (P1-2).
  'contextWindow',
  'theme',
  'confirmTools',
  'toolTimeoutMs',
  'idleTimeoutMs',
  'exitTranscript',
  'transcriptWindow',
  // tui-render-performance L1 / L4. Listed here AND cased in the switch
  // below: a key present here but absent there falls through, writes
  // nothing, and still prints `Set <key> = <value>` (P1-2).
  'transcriptRetain',
  'renderGovernor',
  'maxRenderIntervalMs',
  // tui-input-flicker-fix §5.1. Listed here AND cased in the switch below, for
  // the reason `transcriptRetain` records three lines up.
  'diffRender',
  'syncOutput',
  // Without these two, `density` and `hints` would be settable only as one-shot
  // flags and never persist -- inconsistent with every other config field.
  'density',
  'hints',
  // agent-activity-presentation §4.1. Listed here AND cased in the switch below,
  // for the reason `transcriptRetain` records above.
  'showThinking',
  // agent-activity-presentation-live §4.1. Listed here AND cased in the switch
  // below, for the reason `transcriptRetain` and `showThinking` both record.
  'liveToolOutput',
  // MEMBERSHIP HERE ONLY DECIDES THAT THE KEY IS NOT REJECTED. The `switch`
  // below is what builds the patch, and a key present here but absent there
  // falls through every case, writes nothing, and still prints
  // `Set mouse = false` (P1-2) -- exactly what happened to `density`/`hints`.
  'mouse',
  // Both cased in the switch below, for the reason the note above `mouse`
  // records: a key listed here but absent there writes nothing and still prints
  // `Set mouseSelect = false`.
  'mouseSelect',
  // Listed here AND cased in the switch below, for the reason the note above
  // `mouse` records: a key present here but absent there falls through every
  // case, writes nothing, and still prints `Set paste = false`.
  'paste',
  'scrollResumeMs',
  'historyEnabled',
  'planModeDefault',
  'planModeMaxAskRounds',
  'planModeHumanTimeoutMs',
  // Dotted keys route into the nested `skills` object; see the switch below.
  'skills.enabled',
  'skills.requireApproval',
  'skills.catalogMaxBytes',
  'skills.bodyMaxBytes',
  'skills.integrity',
  'skills.usageTracking',
  'skills.toolPolicy',
  // `log.*` keys are handled by `applyLogConfigSet` below, NOT by the switch:
  // that switch is already past this package's complexity ceiling.
  ...LOG_CONFIG_SET_KEYS,
  // `team.*` keys are handled by `applyTeamConfigSet`, for the same reason
  // `log.*` are: the switch below is already past this package's complexity
  // ceiling, and a key listed here but forgotten there writes nothing while
  // still printing `Set team.enabled = false`.
  ...TEAM_CONFIG_SET_KEYS,
  // `retry.*` keys are handled by `applyRetryConfigSet`, same reasoning again.
  ...RETRY_CONFIG_SET_KEYS,
  // `fast.*` keys are handled by `applyFastConfigSet`, same reasoning again.
  ...FAST_CONFIG_SET_KEYS,
  // `update.*` keys are handled by `applyUpdateConfigSet`, same reasoning again.
  ...UPDATE_CONFIG_SET_KEYS,
  // `compaction.*` keys are handled by `applyCompactionConfigSet`, same
  // reasoning again — and this set is what makes the kill switch reachable from
  // a script at all: `config list` enumerates the section dynamically and so
  // shows these keys whether they are here or not, while `config set` does not.
  ...COMPACTION_CONFIG_SET_KEYS,
]);

/**
 * `aragon config set maxTokens <n|auto|default>`.
 *
 * REJECTS nonsense rather than clamping it, unlike `theme` and `thinkingLevel`.
 * Those two clamp because their bad values are out-of-VOCABULARY; here a
 * non-numeric argument is almost always a typo for a number the user meant, and
 * storing 64000 for `3200O` would quietly discard their intent. An out-of-RANGE
 * number is still clamped, in both directions, by the store's single gate.
 */
function runConfigSetMaxTokens(value: string): void {
  const raw = value.trim().toLowerCase();
  const parsed = raw === 'default'
    ? ({ kind: 'value', value: DEFAULT_MAX_TOKENS, clamped: false } as const)
    : parseMaxTokensInput(value);

  if (parsed.kind === 'invalid') {
    process.stderr.write(
      `Invalid maxTokens "${value}". Use a number, "auto", or "default".\n`,
    );
    process.exitCode = 2;
    return;
  }

  const stored = parsed.kind === 'auto' ? null : parsed.value;
  const merged = updatePersistedConfig({ maxTokens: stored });
  process.stdout.write(`Set maxTokens = ${merged.maxTokens ?? 'auto'}\n`);
}

/**
 * `aragon config set contextWindow <n|auto>`.
 *
 * ITS OWN BRANCH, AHEAD OF THE SWITCH, for the reason `maxTokens` has one: it
 * must echo the STORED value rather than the typed one, so
 * `config set contextWindow 99999999` reports the clamped 5000000 instead of a
 * number that was never written. It also REJECTS nonsense rather than clamping
 * it - a non-numeric argument here is almost always a typo for a number, and
 * storing AUTO for `20O000` would quietly discard the user's intent.
 */
function runConfigSetContextWindow(value: string): void {
  const trimmed = value.trim();
  const auto = isAutoToken(trimmed);
  if (!auto && !/^\d+$/.test(trimmed)) {
    process.stderr.write(
      `Invalid contextWindow "${value}". Use a number of tokens or "auto".\n`,
    );
    process.exitCode = 2;
    return;
  }
  // `null` GOES IN UNCLAMPED (RV-12). Running AUTO through the clamp yields
  // 8000 and removes "auto" from the config permanently.
  const stored = auto ? null : clampContextWindow(trimmed, null);
  const merged = updatePersistedConfig({ contextWindow: stored });
  process.stdout.write(`Set contextWindow = ${merged.contextWindow ?? 'auto'}\n`);
}

function runConfigSet(key: string, value: string): void {
  try { runConfigSetValue(key, value); }
  catch (error) {
    const invalid = error instanceof ModelProfileConfigError
      && !['read_failed', 'write_failed'].includes(error.code);
    process.stderr.write(error instanceof ModelProfileConfigError
      ? `${error.message}\n` : 'Could not write config. Check file permissions.\n');
    process.exitCode = invalid ? 2 : 1;
  }
}

function runConfigSetValue(key: string, value: string): void {
  if (!CONFIG_SET_KEYS.has(key)) {
    process.stderr.write(
      `Unknown config key "${key}". Known keys: ${[...CONFIG_SET_KEYS].join(', ')}.\n`,
    );
    process.exitCode = 2;
    return;
  }

  const logPatch = applyLogConfigSet(key, value);
  if (logPatch) {
    updatePersistedConfig(logPatch);
    warnIfRedactionDisabled(key, value);
    process.stdout.write(`Set ${key} = ${value}\n`);
    return;
  }

  // Handled ahead of the switch because it needs to echo the STORED value, not
  // the typed one: `config set maxTokens 900000` must not report a number that
  // was never written. Same reason `team.*` has its own branch.
  if (key === 'maxTokens') {
    runConfigSetMaxTokens(value);
    return;
  }

  // The second tri-state key, and it needs its own branch for the same reason.
  if (key === 'contextWindow') {
    runConfigSetContextWindow(value);
    return;
  }

  const teamPatch = applyTeamConfigSet(key, value);
  if (teamPatch) {
    // The written value is echoed from the CLAMPED result rather than from the
    // input, so `config set team.maxSubagents 40` says 10 instead of silently
    // reporting a number that was never stored (R-g).
    const merged = updatePersistedConfig(teamPatch);
    const field = key.slice('team.'.length) as keyof typeof merged.team;
    process.stdout.write(`Set ${key} = ${String(merged.team[field])}\n`);
    return;
  }

  const retryPatch = applyRetryConfigSet(key, value);
  if (retryPatch) {
    // Echoed from the STORED value for the same reason `team.*` is, and it matters
    // more here: `config set retry.maxRetries 0` used to be the value that
    // silently became 10, so reporting the input would have hidden the bug rather
    // than the fix (R-16).
    const merged = updatePersistedConfig(retryPatch);
    const field = key.slice('retry.'.length) as keyof typeof merged.retry;
    process.stdout.write(`Set ${key} = ${String(merged.retry[field])}\n`);
    return;
  }

  const fastPatch = applyFastConfigSet(key, value);
  if (fastPatch) {
    // Echoed from the STORED value, so `config set fast.reviewEveryTurns 400`
    // prints the clamped 50 rather than reporting a number that was never
    // written (AC-13) — the rule `team.*` and `retry.*` each state above.
    const merged = updatePersistedConfig(fastPatch);
    const field = key.slice('fast.'.length) as keyof typeof merged.fast;
    process.stdout.write(`Set ${key} = ${String(merged.fast[field])}\n`);
    return;
  }

  const updatePatch = applyUpdateConfigSet(key, value);
  if (updatePatch) {
    // Echoed from the STORED value, so `config set update.checkIntervalMs 5`
    // prints the clamped 900000 rather than reporting a number that was never
    // written (AC-20) — the rule `team.*`, `retry.*` and `fast.*` each state
    // above.
    const merged = updatePersistedConfig(updatePatch);
    const field = key.slice('update.'.length) as keyof typeof merged.update;
    process.stdout.write(`Set ${key} = ${String(merged.update[field])}\n`);
    return;
  }

  const compactionPatch = applyCompactionConfigSet(key, value);
  if (compactionPatch) {
    // Echoed from the STORED value, so `config set compaction.threshold 0.2`
    // prints the clamped 0.5 rather than reporting a number that was never
    // written — the rule `team.*`, `retry.*`, `fast.*` and `update.*` each state
    // above. It matters most for `warnThreshold`, which is clamped against the
    // stored `threshold` and so can move for a reason the caller cannot see.
    const merged = updatePersistedConfig(compactionPatch);
    const field = key.slice('compaction.'.length) as keyof typeof merged.compaction;
    process.stdout.write(`Set ${key} = ${String(merged.compaction[field])}\n`);
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
    case 'exitTranscript':
      patch.exitTranscript = value === 'true' || value === '1';
      break;
    case 'transcriptWindow':
      patch.transcriptWindow = clampTranscriptWindow(value, DEFAULT_TRANSCRIPT_WINDOW);
      break;
    case 'transcriptRetain':
      patch.transcriptRetain = clampTranscriptRetain(value, DEFAULT_TRANSCRIPT_RETAIN);
      break;
    case 'renderGovernor':
      patch.renderGovernor = value === 'true' || value === '1';
      break;
    case 'maxRenderIntervalMs':
      patch.maxRenderIntervalMs = clampMaxRenderInterval(value, DEFAULT_MAX_RENDER_INTERVAL_MS);
      break;
    case 'diffRender':
      patch.diffRender = value === 'true' || value === '1';
      break;
    case 'syncOutput':
      patch.syncOutput = value === 'true' || value === '1';
      break;
    case 'density':
      patch.density = clampDensity(value, 'comfortable');
      break;
    case 'showThinking':
      patch.showThinking = value === 'true' || value === '1';
      break;
    case 'liveToolOutput':
      patch.liveToolOutput = value === 'true' || value === '1';
      break;
    case 'hints':
      patch.hints = value === 'true' || value === '1';
      break;
    case 'mouse':
      patch.mouse = value === 'true' || value === '1';
      break;
    case 'mouseSelect':
      patch.mouseSelect = value === 'true' || value === '1';
      break;
    case 'paste':
      patch.paste = value === 'true' || value === '1';
      break;
    // Clamped rather than rejected, for the same reason `planModeDefault` below
    // records: hardening only the READ path leaves a bad value on disk that
    // reverts to the default on every launch, which presents as "my setting
    // won't stick". `0` is a legal value here and its documented off switch.
    case 'scrollResumeMs':
      patch.scrollResumeMs = clampScrollResumeMs(value, DEFAULT_SCROLL_RESUME_MS);
      break;
    // Turning this off stops new prompts being recorded; it does NOT delete
    // what is already in `prompt-history.jsonl` (that is `aragon history clear`).
    case 'historyEnabled':
      patch.historyEnabled = value === 'true' || value === '1';
      break;
    // Clamped rather than rejected, for the same reason as `theme` and
    // `skills.integrity`: hardening only the READ path leaves a bad value on
    // disk that reverts to the default on every launch, which presents as
    // "my setting won't stick".
    case 'planModeDefault':
      patch.planModeDefault = value === 'true' || value === '1';
      break;
    case 'planModeMaxAskRounds':
      patch.planModeMaxAskRounds = clampAskRounds(value, DEFAULT_PLAN_MAX_ASK_ROUNDS);
      break;
    case 'planModeHumanTimeoutMs':
      patch.planModeHumanTimeoutMs = clampHumanTimeout(value, DEFAULT_PLAN_HUMAN_TIMEOUT_MS);
      break;
    // The dotted keys write a PARTIAL `skills` object. That is safe only
    // because `updatePersistedConfig` deep-merges this section (§10.3.2) —
    // with the old shallow merge each of these would wipe trustedProjectDirs.
    case 'skills.enabled':
      patch.skills = { enabled: value === 'true' || value === '1' } as PersistedConfig['skills'];
      break;
    case 'skills.requireApproval':
      patch.skills = {
        requireApproval: value === 'true' || value === '1',
      } as PersistedConfig['skills'];
      break;
    case 'skills.catalogMaxBytes':
      patch.skills = { catalogMaxBytes: coercePositiveInt(value, 6000) } as PersistedConfig['skills'];
      break;
    case 'skills.bodyMaxBytes':
      patch.skills = { bodyMaxBytes: coercePositiveInt(value, 30_000) } as PersistedConfig['skills'];
      break;
    // Clamped rather than rejected, exactly like `theme` and `thinkingLevel`:
    // hardening only the READ path leaves a bad value on disk that reverts to
    // the default on every launch, which presents as "my setting won't stick".
    case 'skills.integrity':
      patch.skills = {
        integrity: clampSkillsIntegrity(value, DEFAULT_SKILLS_CONFIG.integrity),
      } as PersistedConfig['skills'];
      break;
    case 'skills.usageTracking':
      patch.skills = {
        usageTracking: value === 'true' || value === '1',
      } as PersistedConfig['skills'];
      break;
    case 'skills.toolPolicy':
      patch.skills = {
        toolPolicy: clampSkillsToolPolicy(value, DEFAULT_SKILLS_CONFIG.toolPolicy),
      } as PersistedConfig['skills'];
      break;
  }
  updatePersistedConfig(patch);
  process.stdout.write(`Set ${key} = ${value}\n`);
}

// ---------------------------------------------------------------------------
// `aragon update`
// ---------------------------------------------------------------------------

interface UpdateCliOptions {
  check?: boolean;
  to?: string;
  json?: boolean;
  rollback?: boolean;
}

/**
 * Exit codes (cli-auto-update section 4.3): `0` = up to date, or installed;
 * `1` = the check or the install failed; `2` = an install source we will not
 * install for (the advice line is printed); `4` = `--rollback` had nothing to
 * roll back to (cli-auto-update-hardening section 6.2 / P2-8).
 *
 * A SOURCE WE DECLINE IS `2` AND NOT `1`, and the difference matters to the only
 * consumer that reads an exit code - a script. `1` says "try again later"; `2`
 * says "this machine will never auto-update, run the command we printed".
 */
function updateExitCode(snapshot: UpdateSnapshot): number {
  // REASON BEFORE PHASE, and the order is the whole change (P1-1). The three
  // classified failures all arrive with `phase: 'failed'` - they come from
  // `recordFailure` - so leaving the phase test first, as it was, means these
  // two lines can never be reached and the mapping is a silent no-op.
  //
  // THIS IS A BEHAVIOUR CHANGE FOR SCRIPTS AND IS CALLED ONE (R-23). A
  // `blocked-by-os` install used to exit `1` ("try again later") and now exits
  // `2` ("this machine will never auto-update, run the command we printed").
  // That is the honest answer - on Windows the same `npm i -g` from the same
  // shell fails the same way until the user closes something - and it is
  // recorded in the CHANGELOG under the version that ships it.
  if (snapshot.reason === 'blocked-by-os' || snapshot.reason === 'no-space') return 2;
  if (snapshot.reason === 'source-ineligible' || snapshot.reason === 'not-writable') return 2;
  if (snapshot.phase === 'failed') return 1;
  if (snapshot.reason === 'install-ineffective') return 1;
  return 0;
}

/** Human output: three lines at most (section 4.3). */
function formatUpdateResult(snapshot: UpdateSnapshot): string {
  const lines: string[] = [];
  switch (snapshot.phase) {
    case 'ready':
      lines.push(`Installed ${snapshot.latestVersion ?? ''}. Restart aragon to apply.`);
      break;
    case 'available':
      lines.push(
        snapshot.reason === 'install-ineffective'
          ? `${snapshot.latestVersion ?? 'The new version'} installed somewhere else - ` +
            'check your npm prefix.'
          : `${snapshot.latestVersion ?? 'A new version'} is available ` +
            `(running ${snapshot.currentVersion}).`,
      );
      if (snapshot.advice) lines.push(`  ${snapshot.advice}`);
      break;
    case 'failed':
      lines.push('Update failed. See the log for details.');
      if (snapshot.advice) lines.push(`  ${snapshot.advice}`);
      break;
    default:
      lines.push(`aragon ${snapshot.currentVersion} is up to date.`);
      break;
  }
  if (snapshot.reason && snapshot.phase !== 'ready') lines.push(`  (${snapshot.reason})`);
  return lines.slice(0, 3).join('\n');
}

/**
 * `aragon update --rollback` - the MANUAL form of the boot guard's rollback
 * (cli-auto-update-hardening section 6.2).
 *
 * It exists because a release can be BAD WITHOUT FAILING TO START, which is the
 * case non-goal 2 declines to detect automatically precisely because a human
 * detects it in one second. It shares `performRollback` verbatim, so the latch,
 * the re-classification, the lock and the post-install verification are the same
 * code the automatic path uses.
 *
 * Exit `4` for "nothing to roll back to" is a fourth code on a documented
 * contract, so the contract's own comment above moves with it (P2-8). A rollback
 * that RAN and failed is an ordinary failed install and keeps exit `1`.
 */
async function runRollbackCommand(): Promise<number> {
  const { readUpdateState, updateUpdateState } = await import('./update/state.js');
  const good = readUpdateState().lastGoodVersion;
  if (!good) {
    process.stderr.write(
      'Nothing to roll back to: no previous version was recorded by an auto-update.\n',
    );
    return 4;
  }
  if (good === VERSION) {
    process.stdout.write(`aragon ${VERSION} is already the last known-good version.\n`);
    return 0;
  }
  const { performRollback } = await import('./boot/rollback.js');
  const result = await performRollback(VERSION, good);
  if (!result.ok) {
    process.stderr.write(`Rollback to ${good} did not complete (${result.failure}).\n`);
    return 1;
  }
  // THE NOTICE IS FOR A DOWNGRADE THE USER DID NOT ASK FOR, AND THIS ONE WAS
  // TYPED. `performRollback` sets `rolledBackFrom` because it cannot tell which
  // caller it has, and the field has exactly one rendering: `rolled back to <to>
  // after <bad> FAILED TO START` (section 8). On this path that sentence is
  // false - the version started fine, the user simply did not want it - and a
  // bottom row asserting a crash that never happened is worse than no row.
  //
  // Clearing it here rather than teaching `performRollback` a mode keeps the
  // "verbatim shared mechanism" of section 6.2 intact and adds no fifth state
  // field under C-17. D-38's purpose survives: the notice exists so a SILENT
  // downgrade cannot go unnoticed, and the line below is this one's notice.
  // `/update status` still shows `lastgood`, and `update_rolled_back` is in the
  // log either way.
  updateUpdateState({ rolledBackFrom: '' });
  process.stdout.write(`Rolled back to ${good}. Restart aragon to apply.\n`);
  return 0;
}

/**
 * `aragon update` - a deliberate, foreground check.
 *
 * PRINTS TO STDOUT, unlike every other update surface in this package: here the
 * update IS the command's output, so C-10's "the TUI is the only legal visible
 * channel" does not apply - there is no TUI.
 *
 * Reached through the SAME dynamic `import()` the interactive gate uses, so
 * `dist/cli.js` still carries no static specifier under `update/` (AC-1).
 */
async function runUpdateCommand(flags: CliFlags, opts: UpdateCliOptions): Promise<number> {
  const config = loadConfig(flags);
  getLogger().reconfigure(config.log);
  const { UpdateService } = await import('./update/service.js');
  const service = new UpdateService({
    // `--check` is exactly `mode: 'notify'` FOR THIS RUN, and expressing it that
    // way rather than with a second flag through the service means there is one
    // code path deciding whether to install, not two.
    config: opts.check ? { ...config.update, mode: 'notify' } : config.update,
    currentVersion: VERSION,
  });
  try {
    if (opts.rollback) return await runRollbackCommand();
    const target = opts.to?.trim();
    if (target) {
      // REPORTED, not silently ignored. `installNow` also refuses a malformed
      // version (it is the one entry point whose target comes straight from
      // argv), but there the refusal is a no-op snapshot that would exit 0 and
      // tell the user they are up to date — which is a lie about the command
      // they actually typed.
      const { STRICT_VERSION_RE } = await import('./update/semver.js');
      if (!STRICT_VERSION_RE.test(target)) {
        process.stderr.write(`Not a version: "${target}". Use e.g. --to 0.6.0\n`);
        return 1;
      }
    }
    const snapshot = target
      ? await service.installNow(target)
      : await service.checkNow({ force: true });
    process.stdout.write(
      opts.json ? `${JSON.stringify(snapshot)}\n` : `${formatUpdateResult(snapshot)}\n`,
    );
    return updateExitCode(snapshot);
  } catch (err) {
    process.stderr.write(`update failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  } finally {
    service.dispose();
  }
}

// ---------------------------------------------------------------------------
// CLI definition
// ---------------------------------------------------------------------------

function buildProgram(): Command {
  const program = new Command();

  program
    .name('aragon')
    .description('AragonAgent - a Claude-Code / Codex-style terminal UI for the AragonAgent engine.')
    .version(VERSION, '-v, --version', 'Print the version')
    .argument('[prompt]', 'Task prompt (starts the TUI, or a one-shot run with -p / piped stdin)')
    .option('-p, --print', 'Headless: stream the answer to stdout, then exit')
    .option('--provider <id>', 'anthropic | openai | google')
    .option('--model <id>', 'Model id')
    .option('--base-url <url>', 'Override the provider base URL')
    .option('--api-key <key>', 'One-shot API key override (not persisted)')
    .option('--thinking <level>', 'off|minimal|low|medium|high|xhigh')
    .option(
      '--max-tokens <n|auto>',
      'Output token cap: a number, or "auto" for the model ceiling (default 64000)',
    )
    .option('--cwd <dir>', 'Working directory for tools')
    .option('--confirm', 'Confirm each mutating tool call')
    .option('--tool-timeout <ms>', 'Per-tool executor ceiling (default 180000)')
    .option('--idle-timeout <ms>', 'Watchdog idle timeout (auto-raised to >= tool-timeout+30s)')
    .option('--theme <name>', 'auto|warm|cool|light ("dark" is an alias for "cool")')
    .option('--compact', 'Compact transcript density (no blank rows between turns)')
    .option('--no-compact', 'Comfortable transcript density')
    .option('--hints', 'Always show the composer hint row')
    .option('--no-hints', 'Hide the composer hint row')
    .option('--show-thinking', 'Show the reasoning blocks the model returns')
    .option('--no-show-thinking', 'Hide reasoning blocks (the default)')
    .option('--live-tool-output', 'Show a running command output tail (the default)')
    .option('--no-live-tool-output', 'Keep a running tool card to one line')
    .option('--mouse', 'Wheel scrolls the transcript (full-screen mode)')
    .option('--no-mouse', 'Leave the mouse to the terminal (the wheel does nothing)')
    .option('--mouse-select', 'Drag with the mouse to select text; Ctrl+C copies it')
    .option('--no-mouse-select', 'Keep wheel scrolling, but leave drag-select off')
    // Positive form FIRST, same tri-state reason as `--mouse-select` above:
    // `paste` is persisted and defaults to `true`, so a lone `--no-paste` would
    // make commander default `opts.paste` to `true` -- indistinguishable from
    // silence, and silently overriding a stored `false` on every run.
    .option('--paste', 'Collapse large pastes into a placeholder (the default)')
    .option('--no-paste', 'Treat pasted bytes as keystrokes (pre-0.6.3 behavior)')
    .option('--no-exit-transcript', 'Do not replay the session summary after exiting')
    .option('--plan', 'Start the session in PLAN mode (read-only research + review)')
    .option('--no-plan', 'Start the session in BUILD mode (overrides planModeDefault)')
    // BOTH FORMS, positive first, and the pair is mandatory (team-subagents
    // §4.4 / P1-4). Declaring only `--no-team` would make commander default
    // `opts.team` to `true`, at which point the flag is indistinguishable from
    // its own default and silently overrides `config.json` on every run.
    .option('--team', 'Enable team subagents for this session (the default)')
    .option('--no-team', 'Disable team subagents (the task tool is not registered at all)')
    .option('--team-max <n>', 'Max subagents per dispatch for this run (1-10)')
    // BOTH PAIRS, positive first (todo-plan-execution §4.3 / P1-8). `--todo` is
    // the `--team` story verbatim; `--todo-panel` needs the pair for a second
    // reason on top of it — `panel` is PERSISTED, so a lone `--no-todo-panel`
    // would make commander default `opts.todoPanel` to `true` and silently
    // overwrite a stored `panel: false` on every run that passed no flag.
    .option('--todo', 'Enable todo planning for this session (the default)')
    .option('--no-todo', 'Disable todo planning (the todo_write tool is not registered at all)')
    .option('--todo-panel', 'Show the todo plan in a right-hand rail (the default)')
    .option('--no-todo-panel', 'Keep todo planning but do not render the rail')
    // NOT A PAIR, and it does not need to be: a value flag is absent unless
    // passed, so `!== undefined` in `resolveTodoConfig` already distinguishes it
    // from silence. An unrecognized mode is clamped to `notify`, not rejected.
    .option(
      '--todo-follow <mode>',
      'What to do when a run ends with unfinished steps: notify (default) | auto | off',
    )
    // BOTH FORMS, positive first, for the reason recorded five times above:
    // `retry.enabled` is PERSISTED, so a lone `--no-retry` would make commander
    // default `opts.retry` to `true` and silently overwrite a stored `false`.
    .option('--retry', 'Retry failed provider calls with backoff (the default)')
    .option('--no-retry', 'Do not retry a failed provider call (fail on the first error)')
    .option('--retry-max <n>', 'Retries after the first attempt for this run (0-20; 0 = off)')
    // BOTH FORMS, positive first, for the reason recorded six times above — and
    // with the polarity reversed from every other pair here: `fast.enabled`
    // defaults to FALSE, so a lone `--fast` would be indistinguishable from
    // silence and the off-by-default guarantee (R-d) would rest on a commander
    // detail rather than on the config layer.
    .option('--fast', 'Enable the fast model tier for this session')
    .option('--no-fast', 'Disable the fast model tier (the default)')
    .option('--fast-model <id>', 'The fast model id (implies nothing about --fast)')
    .option('--fast-provider <id>', 'Provider for the fast model (default: the main provider)')
    .option('--fast-review <n|off>', 'Turns between automatic fast reviews, or "off"')
    // BOTH FORMS, POSITIVE FIRST, and here it matters more than anywhere above:
    // `fast.delegate` is PERSISTED and defaults to TRUE, so declaring only
    // `--no-fast-delegate` would make commander default `opts.fastDelegate` to
    // `true` and force `delegate: true` on EVERY run that passed no flag at all
    // — silently overwriting a user's stored `false`. Same polarity, same trap
    // and same fix as `--update` / `--compaction`.
    .option('--fast-delegate', 'Let the fast tier take mechanical sub-steps (the default)')
    .option('--no-fast-delegate', 'Run every sub-step on the main model')
    // BOTH FORMS, positive first, for the reason recorded seven times above —
    // and this is the pair whose omission would be worst. `update.mode` is
    // PERSISTED and defaults to `'auto'`, so a lone `--no-update` would make
    // commander default `opts.update` to `true` and silently overwrite a stored
    // `off` on EVERY run that passed no flag at all: the kill switch for a
    // feature that installs software would quietly un-set itself (C-11).
    .option('--update', 'Check for and install updates in the background (the default)')
    .option('--no-update', 'Disable auto-update for this session')
    // BOTH FORMS, positive first, for the reason recorded eight times above —
    // and this pair shares `--update`'s polarity, which is the worst one.
    // `compaction.enabled` is PERSISTED and defaults to `true`, so a lone
    // `--no-compaction` would make commander default `opts.compaction` to `true`
    // and silently overwrite a stored `false` on EVERY run that passed no flag at
    // all: the kill switch for a feature that spends the user's money on a
    // summarizer would quietly un-set itself (C-13 / P1-5).
    .option('--compaction', 'Compact the conversation when the context window fills (the default)')
    .option('--no-compaction', 'Never compact; a full context window ends the run as before')
    .option(
      '--compaction-threshold <n>',
      'Occupancy that triggers compaction for this run: 0.9 or 90% (0.5-0.95)',
    )
    .option('--no-skills', 'Disable the skill system entirely (no catalog, no skill tools)')
    .option(
      '--skill <name>',
      'Force-load a skill at Level 2 for this run (repeatable)',
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .option('--skills-yes', 'Approve skill installs for this run (CI / headless)')
    .option(
      '--skill-tool-policy <mode>',
      'Tool ceiling from allowed-tools for this run: off | warn | enforce (not persisted)',
    )
    // `--log-file` is declared BEFORE `--no-log-file` for the tri-state reason
    // recorded twice above: negative-only would default it to `true` and make a
    // persisted `log.toFile: false` permanently unreachable.
    .option('--log-file', 'Write this run to a log file')
    .option('--no-log-file', 'Do not write this run to a log file')
    .option('--log-level <level>', 'silent|error|warn|info|debug|trace (this run only)')
    // No short form: `-v` is already `--version`.
    .option('--verbose', 'Shorthand for --log-level debug')
    .option('--log-dir <dir>', 'Absolute log directory for this run')
    // Render performance (tui-render-performance §5.2). `--render-governor` is
    // declared BEFORE its negative form for the tri-state reason recorded four
    // times above: `renderGovernor` is persisted, so negative-only would default
    // `opts.renderGovernor` to `true` and silently overwrite a stored `false`.
    .option('--transcript-retain <n>', 'Entries kept in memory (200-20000, default 1000)')
    .option('--render-governor', 'Adapt the frame interval under load (the default)')
    .option('--no-render-governor', 'Pin the frame interval at 33ms however expensive a frame is')
    .option('--max-render-interval <ms>', 'Governor ceiling in ms (33-1000, default 320)')
    // Composer flicker (tui-input-flicker-fix §5.2). Positive form FIRST for the
    // tri-state reason recorded five times above: both keys are persisted and
    // default to `true`, so a negative-only declaration would let commander
    // synthesize `true` and overwrite a stored `false` on every run — turning the
    // one documented escape hatch for a mis-rendering terminal into a no-op.
    .option('--diff-render', 'Repaint only changed rows (default, full-screen only)')
    .option('--no-diff-render', 'Repaint the whole frame every time (pre-fix behavior)')
    .option('--sync-output', 'Ask the terminal to present each repaint atomically (the default)')
    .option('--no-sync-output', 'Do not emit DEC 2026 begin/end synchronized update')
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

  configCmd
    .command('get <key>')
    .description('Print a single config value (secrets are masked)')
    .action((key: string) => runConfigGet(key));

  configCmd
    .command('list')
    .description('Print the whole config (secrets are masked)')
    .option('--json', 'Machine-readable output')
    .action((opts: { json?: boolean }) => runConfigList(opts));

  configCmd
    .command('edit')
    .description('Open config.json in $VISUAL / $EDITOR (backs it up first)')
    .action(async () => {
      await runConfigEdit();
    });

  configCmd
    .command('home')
    .description('Print the user-state root directory')
    .action(() => runConfigHome());

  // aragon logs <sub> [-n N] [--follow] [--level lv] [--json] [--yes]
  program
    .command('logs [subcommand]')
    .description('Inspect the log files: path | list | tail | clear | open')
    .option('-n, --lines <n>', 'Lines for `logs tail` (default 100)')
    .option('--follow', 'Keep printing new records (`logs tail`)')
    .option('--level <level>', 'Only show records at this level or more severe')
    .option('--json', 'Print raw JSONL instead of rendered lines')
    .option('--yes', 'Confirm destructive actions (required by `logs clear`)')
    .action(async (subcommand: string | undefined, opts: LogsCliOptions) => {
      process.exitCode = await runLogsCommand(subcommand ?? 'path', opts, toFlags(program.opts()));
    });

  // aragon history <sub> [-n N] [--json] [--yes]
  program
    .command('history [subcommand]')
    .description('Inspect the prompt history: path | list | clear')
    .option('-n, --lines <n>', 'Entries for `history list` (default 20)')
    .option('--json', 'Print raw entries instead of rendered lines')
    .option('--yes', 'Confirm destructive actions (required by `history clear`)')
    .action((subcommand: string | undefined, opts: HistoryCliOptions) => {
      process.exitCode = runHistoryCommand(subcommand ?? 'path', opts);
    });

  // aragon skills <sub> [arg] [--scope] [--name] [--description] [--yes] [--json]
  program
    .command('skills [subcommand] [argument]')
    .description(
      'Manage skills: list | info | install | update | remove | create | path | doctor | usage | trust | untrust',
    )
    .option('--scope <scope>', 'user | project')
    .option('--name <name>', 'Override the installed skill name')
    .option('--description <text>', 'Description for `skills create`')
    .option('--yes', 'Approve without prompting (required for non-interactive installs)')
    .option('--json', 'Machine-readable output for list / info')
    .option('--all', 'Apply `skills update` to every skill that has an upstream')
    .option('--force', 'Let `skills update` overwrite local edits to an installed skill')
    .option('--dry-run', 'Show what `skills update` would change without writing anything')
    .option('--check', 'Ask whether an update exists, without downloading it')
    .option('--sort <order>', 'name | recent (for `skills list`)')
    .option('--reset', 'Delete the local usage counters (`skills usage`; needs --yes)')
    .action(async (subcommand: string | undefined, argument: string | undefined, opts: SkillsCliOptions) => {
      const code = await runSkillsCommand(
        subcommand ?? 'list',
        argument,
        opts,
        toFlags(program.opts()),
        VERSION,
      );
      process.exitCode = code;
    });

  // aragon update [--check] [--to <version>] [--json]
  //
  // THE GUARANTEED REPORTING SURFACE (C-12 / D-18), and the only update path
  // available to a headless user at all - `runInteractive` is the sole place the
  // background service is constructed, so without this command `aragon -p` users
  // could never update deliberately.
  program
    .command('update')
    .description('Check for a new release and install it')
    .option('--check', 'Report only; never install')
    .option('--to <version>', 'Install an exact version (an explicit escape hatch)')
    .option('--rollback', 'Reinstall the version that ran before the last auto-update')
    .option('--json', 'Machine-readable result on stdout')
    .action(async (opts: UpdateCliOptions) => {
      process.exitCode = await runUpdateCommand(toFlags(program.opts()), opts);
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

  // --- The machine-facing face (cli-integration-surface §3.1). --------------
  //
  // FOUR CALL SITES, ~10 LINES. Each module owns its own `.command()` and
  // `.option()` declarations, because this file is already 60% over the
  // repository's 1000-line guideline and twenty more declarations would make
  // that worse for the audience `aragon --help` exists for.
  registerExecCommand(program, toFlags, {
    version: VERSION,
    makeController: makeExecController,
  });
  registerSessionsCommand(program);
  registerInfoCommand(program, toFlags, VERSION);
  registerDoctorCommand(program, toFlags);

  return program;
}

async function main(): Promise<void> {
  // ① and ② are the first two statements on purpose: everything below reads
  // config or skills. THE ORDER IS NOT INTERCHANGEABLE — ① moves 0.4.x data out
  // of the pre-rename env-paths tree, and only then does ② have anything to
  // move into `~/.aragon-agent`. Run the other way round, `config.json` is
  // stranded permanently (see migrate-home.ts). Neither ever throws.
  const legacy = migrateLegacyState();
  const home = migrateToHome();
  for (const notice of [formatMigrationNotice(legacy), formatHomeMigrationNotice(home)]) {
    if (notice) process.stderr.write(`${notice}\n`);
  }

  // ③ comes after both because the log directory lives inside a home that ②
  // may just have created. What ① and ② did is replayed from `pending` rather
  // than lost.
  installLogging({ pending: migrationNotes(legacy, home) });

  // ③.5 — after ③ because it writes a log record, and before anything that
  // resolves config because every `loadConfig()` from here on must already see
  // the post-migration world. Never throws, never prints (D-8).
  migrateStateOutOfConfig();

  // An unparseable config.json still falls back to defaults — the CLI has to
  // start — but it must not do so in silence, or a stray comma presents as
  // "every setting I ever chose is gone". stderr, never stdout, so
  // `aragon -p "…" > out.txt` keeps carrying model output and nothing else.
  const { parseError } = readConfigFile();
  if (parseError) {
    process.stderr.write(`config: using defaults, could not parse ${parseError}\n`);
  }

  const program = buildProgram();
  await program.parseAsync(process.argv);
}

/** The ①/② outcomes, as records for `installLogging` to write once it exists. */
function migrationNotes(
  legacy: ReturnType<typeof migrateLegacyState>,
  home: ReturnType<typeof migrateToHome>,
): PendingNote[] {
  const notes: PendingNote[] = [
    { level: 'info', scope: 'cli', msg: 'cli_start', data: { version: VERSION } },
  ];
  if (legacy.mode !== 'none' || legacy.error) {
    notes.push({
      level: legacy.error ? 'warn' : 'info',
      scope: 'migrate',
      msg: 'migrate_brand',
      data: { ...legacy },
    });
  }
  if (home.mode !== 'none' || home.error) {
    notes.push({
      level: home.error ? 'warn' : 'info',
      scope: 'migrate',
      msg: 'migrate_home',
      data: { ...home },
    });
  }
  return notes;
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exitCode = 1;
});
