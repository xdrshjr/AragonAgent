/**
 * Assembly: bootstrap level resolution, replay of what happened before the
 * logger existed, ownership of the four process hooks, and the agent-event
 * mapping.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * SINGLE-OWNER MODEL — the part that is easiest to get wrong and hardest to
 * notice, because getting it wrong still compiles and still passes a smoke test.
 *
 *   The logger owns FLUSHING and never owns EXITING.
 *   The screen owns RESTORING and never owns FLUSHING.
 *
 * All four hooks below change Node's default behaviour merely by existing:
 *
 *   `uncaughtException`  — registering a listener REPLACES Node's "print the
 *       stack and exit". `main().catch()` in `cli.tsx` is not that hook; it is a
 *       promise chain's catch and only ever sees rejections of that one chain.
 *       So there is no prior behaviour to inherit: without an explicit
 *       `process.exit(1)` here, an exception thrown inside an Ink render
 *       callback or a timer stops terminating the process. In full-screen that
 *       means the alternate screen is never restored and Ink keeps drawing onto
 *       a broken controller — the user's only way out is `reset`.
 *
 *   `unhandledRejection` — Node 18 defaults to `--unhandled-rejections=throw`.
 *       Adding a listener suppresses it, turning a crash into a silent hang.
 *
 *   `SIGINT` / `SIGTERM` / `SIGHUP` — the handlers in `runInteractive()` exist
 *       ONLY in its full-screen branch, so `-p` and every
 *       subcommand had no handler at all and took Node's default termination,
 *       which does not run `'exit'` listeners: the whole queue was lost. But a
 *       signal listener registered here runs BEFORE the one `runInteractive`
 *       would add (EventEmitter order), and merely having one stops Node from
 *       terminating — so it must exit itself, and would then beat the screen
 *       restore. Hence: this module flushes and then calls a REPLACEABLE
 *       terminator. The default is a bare exit, which covers headless and every
 *       subcommand; the full-screen branch swaps in one that restores first.
 * ══════════════════════════════════════════════════════════════════════════
 */

import process from 'node:process';
import { getHomeResolutionWarning } from '../config/app-paths.js';
import { readConfigFile } from '../config/store.js';
import { clampLogConfig, type LogConfig } from '../config/schema.js';
import { clampLogLevel, type LogLevelName } from './levels.js';
import { Logger, setActiveLogger, type LogScope } from './logger.js';
import { registerProfileSecrets, registerSecretsFrom } from './secret-registry.js';

/** POSIX signal numbers for the `128 + signo` exit-code convention. */
const SIGNAL_NUMBERS: Record<string, number> = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 };

let screenRestore: () => void = () => {};

/**
 * `null` means "use the default", which is a bare exit through the same process
 * port the hooks were installed on. Holding the default here as a closure over
 * the global `process` instead would make it a second exit channel — invisible
 * to anything that injected a port, which is exactly the sort of divergence
 * these hooks must not have.
 */
let signalTerminator: ((signo: number) => void) | null = null;

/**
 * Hand the screen-restore duty to whoever actually owns the screen.
 * Called by `runInteractive()`'s full-screen branch and by nobody else.
 */
export function setScreenRestore(fn: () => void): void {
  screenRestore = fn;
}

/**
 * Replace what a signal does after the flush. The default (a bare
 * `exit(128 + signo)`) is correct for headless and every subcommand;
 * full-screen substitutes one that restores the terminal first.
 *
 * A TERMINATOR MAY NOW RETURN WITHOUT EXITING, AND THAT IS A CONTRACT CHANGE
 * WORTH WRITING DOWN (cli-integration-surface section 3.6 / D-15). The module
 * header above says of the default "it must exit itself" - true of THAT
 * terminator, and true because nothing before now had anything to settle.
 * `aragon exec` does: it aborts the run, persists the session and emits its one
 * `result` line, so a wrapper reading NDJSON learns the run ended instead of
 * timing out. Returning is safe here for one specific reason - the logger has
 * ALREADY FLUSHED by the time this is called, so a terminator that returns
 * cannot lose log records.
 *
 * THE PRICE IS THAT SUCH A TERMINATOR MUST OWN AN EXIT PATH OF ITS OWN. Merely
 * having a signal listener stops Node terminating by default, so one that
 * returns and then never exits turns Ctrl-C into "nothing happens". exec's pays
 * for it with a second-signal escape (a second SIGINT within 2s exits
 * immediately) and with `process.exitCode` on the settle path. Any future
 * terminator that returns needs the same two.
 *
 * REPLACING, NOT ADDING, IS ALSO NOT OPTIONAL for a caller that wants to be
 * heard: the listeners registered by `installProcessHooks` run FIRST
 * (EventEmitter order) and the default terminator exits, so a
 * `process.on('SIGINT')` added later never runs at all (P0-1).
 */
export function setSignalTerminator(fn: (signo: number) => void): void {
  signalTerminator = fn;
}

/**
 * Work to run BEFORE whatever `signalTerminator` does, on every signal and on a
 * fatal crash (background-service-supervision §3.6 / P1-2).
 *
 * AN APPEND-ONLY LIST, NOT A SECOND SINGLE SLOT, AND THAT IS THE WHOLE POINT.
 * `setSignalTerminator` is a SINGLE SLOT that `cli.tsx` already claims for the
 * alternate-screen restore; registering a second terminator from anywhere else
 * would REPLACE it, which that file's own comment names as the bug that leaves
 * the user staring at a blank alternate screen. So a subsystem that needs to run
 * on the way out — the process supervisor, which must reap its children — adds a
 * hook instead, and nothing about the screen path changes.
 *
 * IT ALSO RUNS FROM `handleFatal`, so a crash reaps too. And it is deliberately
 * SYNCHRONOUS: `signalTerminator` calls `process.exit()` synchronously and
 * `process.on('exit')` permits only synchronous work, so a hook that awaited
 * anything would simply not finish (I-9).
 *
 * A THROWING HOOK MUST NOT STOP THE EXIT. Each one is wrapped, for the reason
 * `handleFatal`'s own two wrapped steps record: a failure on the way out must
 * never be the reason the process fails to leave.
 */
const signalHooks: Array<() => void> = [];

/** Register a synchronous hook to run before the signal terminator. */
export function addSignalHook(fn: () => void): () => void {
  signalHooks.push(fn);
  return () => {
    const at = signalHooks.indexOf(fn);
    if (at >= 0) signalHooks.splice(at, 1);
  };
}

function runSignalHooks(): void {
  for (const hook of [...signalHooks]) {
    try {
      hook();
    } catch {
      // A hook that throws must not stop the exit; see the note above.
    }
  }
}

/** Tests only: undo the hook swaps so cases cannot leak into each other. */
export function resetProcessHooksForTest(): void {
  screenRestore = () => {};
  signalTerminator = null;
  signalHooks.length = 0;
}

export interface PendingNote {
  level: 'info' | 'warn' | 'error';
  scope: LogScope;
  msg: string;
  data?: Record<string, unknown>;
}

/** The process surface the hooks need, so tests can pass a stub. */
export interface ProcessHookPort {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  exit(code: number): never;
  stderr: { write(chunk: string): unknown };
}

export interface InstallLoggingOptions {
  /** Notes accumulated before a logger existed (migrations, path warnings). */
  pending?: PendingNote[];
  /** Injectable for tests; defaults to `process.argv`. */
  argv?: string[];
  /** Injectable for tests; defaults to the real `process`. */
  processPort?: ProcessHookPort;
}

/**
 * Resolve the BOOTSTRAP level.
 *
 * Inputs are only `process.env`, the config file, and a deliberately tiny argv
 * scan. Not commander (it has not parsed yet) and not `.env` (`loadDotenv()`
 * runs inside `loadConfig()`, much later). This level covers exactly the window
 * before `loadConfig()` — migrations, path warnings, an early crash — after
 * which `Logger.reconfigure()` installs the authoritative one.
 *
 * The duplication with `loadConfig()` is intentional and cheap. The alternative
 * is to install the logger after config resolution, which would leave precisely
 * the events that are hardest to debug with nowhere to be recorded.
 */
export function resolveBootstrapLogConfig(argv: string[] = process.argv): LogConfig {
  const file = readConfigFile().config ?? {};
  const base = clampLogConfig({
    ...(file.log ?? {}),
    ...(process.env.ARAGON_LOG_LEVEL ? { level: process.env.ARAGON_LOG_LEVEL } : {}),
    ...(process.env.ARAGON_LOG_DIR ? { dir: process.env.ARAGON_LOG_DIR } : {}),
  });

  const scanned = scanLoggingArgv(argv);
  const toFile = scanned.toFile ?? readEnvToFile() ?? (file.log?.toFile === false ? false : true);

  return clampLogConfig({
    ...base,
    ...(scanned.level ? { level: scanned.level } : {}),
    ...(scanned.dir ? { dir: scanned.dir } : {}),
    toFile,
  });
}

function readEnvToFile(): boolean | undefined {
  const raw = process.env.ARAGON_LOG_FILE?.trim().toLowerCase();
  if (raw === undefined || raw.length === 0) return undefined;
  return !(raw === '0' || raw === 'false' || raw === 'off' || raw === 'no');
}

interface ScannedLogFlags {
  level?: LogLevelName;
  dir?: string;
  toFile?: boolean;
}

/**
 * The minimal hand scan of argv.
 *
 * `-vv` is NOT accepted, and must not be added: `-v` is already `--version`
 * (`cli.tsx`), so commander would reject `-vv` as an unknown option before this
 * level was ever used. A flag that internal docs promise and the parser refuses
 * is worse than no flag.
 */
function scanLoggingArgv(argv: string[]): ScannedLogFlags {
  const out: ScannedLogFlags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === '--verbose') out.level = 'debug';
    else if (arg === '--no-log-file') out.toFile = false;
    else if (arg === '--log-file') out.toFile = true;
    else if (arg === '--log-level') out.level = clampLogLevel(argv[i + 1], 'info');
    else if (arg.startsWith('--log-level=')) out.level = clampLogLevel(arg.slice(12), 'info');
    else if (arg === '--log-dir') out.dir = argv[i + 1];
    else if (arg.startsWith('--log-dir=')) out.dir = arg.slice(10);
  }
  return out;
}

/**
 * Build the logger, replay what came before it, and take ownership of the four
 * process hooks. Returns the logger, which is also installed as the singleton.
 */
export function installLogging(opts: InstallLoggingOptions = {}): Logger {
  const port = opts.processPort ?? (process as unknown as ProcessHookPort);
  const logger = new Logger(resolveBootstrapLogConfig(opts.argv));
  setActiveLogger(logger);

  // Registration site 1 (§4.4.3): whatever the config file already holds. Sites
  // 2, 3, 4 and 5 add the env, the merged view plus `--api-key`, the settings
  // screen, and every persisted write respectively.
  const persisted = readConfigFile().config;
  registerSecretsFrom(persisted?.apiKeys ?? undefined);
  registerProfileSecrets(persisted);

  const warning = getHomeResolutionWarning();
  if (warning) logger.warn('cli', 'home_resolution_fallback', { reason: warning });

  for (const note of opts.pending ?? []) {
    logger[note.level](note.scope, note.msg, note.data);
  }

  installProcessHooks(logger, port);
  return logger;
}

function installProcessHooks(logger: Logger, port: ProcessHookPort): void {
  port.on('uncaughtException', (err: unknown) => {
    handleFatal(logger, port, 'uncaught_exception', err);
  });

  port.on('unhandledRejection', (reason: unknown) => {
    handleFatal(logger, port, 'unhandled_rejection', reason);
  });

  // Normal exit. Only synchronous work is possible here, and the whole write
  // path is synchronous precisely so this can be one line — plus the hooks,
  // which are synchronous for exactly that reason (I-9).
  port.on('exit', () => {
    runSignalHooks();
    logger.flushSync();
  });

  for (const [name, signo] of Object.entries(SIGNAL_NUMBERS)) {
    port.on(name, () => {
      // BEFORE the flush and before the terminator: the terminator exits the
      // process, so anything that has to happen on the way out has to happen
      // first, and a child process left running outlives its parent.
      runSignalHooks();
      logger.flushSync();
      // Exiting is NOT optional here: merely having a signal listener stops Node
      // from terminating by default, so skipping this would turn Ctrl+C into
      // "nothing happens" for every path that has not replaced the terminator.
      if (signalTerminator) {
        signalTerminator(signo);
        return;
      }
      port.exit(128 + signo);
    });
  }
}

/**
 * The crash path, in an order that is not negotiable:
 *
 *   record -> flush -> restore the screen -> write the stack -> EXIT
 *
 * Restoring before writing matters: a stack printed into the alternate screen
 * disappears together with it. Exiting at all matters more — see the module
 * header. A failure inside logging must not stop the last two steps, so the
 * first two are wrapped.
 */
function handleFatal(logger: Logger, port: ProcessHookPort, msg: string, err: unknown): never {
  const error = err instanceof Error ? err : new Error(String(err));
  // FIRST, and outside the try below: a crash must still reap the children it
  // spawned, and it must do so before the screen restore and the stack write,
  // both of which can themselves fail (R-10).
  runSignalHooks();
  try {
    logger.error('cli', msg, { message: error.message, stack: error.stack });
    logger.flushSync();
  } catch {
    // Logging must never be the reason a crash fails to surface.
  }
  screenRestore();
  port.stderr.write(`${error.stack ?? error.message}\n`);
  return port.exit(1);
}

// ---------------------------------------------------------------------------
// Agent event mapping
// ---------------------------------------------------------------------------

/**
 * What `attachAgentEvents` needs from a controller.
 *
 * Structural rather than a direct `AgentController` import: it keeps this module
 * off the controller's dependency graph, and it lets the tests feed the nine
 * event shapes through a few lines of fake instead of a live agent.
 */
export interface AgentEventSource {
  subscribe(listener: (event: AgentLogEvent) => void): () => void;
  getConfig(): { provider: string; model: string; thinkingLevel: string };
}

/**
 * The ELEVEN members of the core `AgentEvent` union, as this module reads them.
 *
 * THIS UNION MUST STAY A SUPERSET OF CORE'S, and the failure when it does not is
 * a COMPILE error rather than a silent one (implementation finding IF-3): the
 * `AgentEventSource` interface above takes a listener of THIS type, so a core
 * union member missing here makes `AgentController` structurally incompatible
 * with `attachAgentEvents` and every call site fails to type-check. That is the
 * right failure mode, but it means adding an event to core is also a change
 * here — the two `compaction_*` members below arrived that way.
 */
export type AgentLogEvent =
  | { type: 'agent_start' }
  | { type: 'steering_accepted'; ids: readonly string[] }
  | { type: 'agent_end'; messages: unknown[] }
  | { type: 'turn_start' }
  | { type: 'turn_end'; usage?: { inputTokens?: number; outputTokens?: number } }
  /**
   * `streamEvent` carries the retry fields OPTIONALLY (llm-api-retry-backoff
   * §6.8): this union is a deliberately loose structural mirror of core's
   * `AgentEvent` so a stub controller can satisfy it with an object literal, and
   * narrowing on `streamEvent.type` inside the handler is what makes the extra
   * fields safe to read.
   */
  | {
      type: 'message_update';
      streamEvent?: {
        type?: string;
        delta?: unknown;
        attempt?: number;
        maxRetries?: number;
        delayMs?: number;
        errorType?: string;
        retryAfterMs?: number;
        discardedToolCallIds?: string[];
      };
    }
  | { type: 'tool_execution_start'; toolCallId?: string; toolName?: string; args?: unknown }
  | {
      type: 'tool_execution_end';
      toolName?: string;
      duration?: number;
      isError?: boolean;
      result?: unknown;
    }
  | { type: 'code_execution_start'; language?: string; code?: string }
  | { type: 'code_execution_end'; duration?: number; error?: string; output?: string }
  /**
   * Context compaction (context-auto-compaction §5.1).
   *
   * RECORDED UNDER THE `agent` SCOPE HERE, not `compaction`. This module logs the
   * LEAD'S LIFECYCLE, and "the run paused to compact" is part of that story — a
   * support reader following a run's `agent` records must not find an unexplained
   * gap where a 40-second summarization was. The `compaction` scope carries the
   * subsystem's own detail (`compaction/compactor.ts`), which is a different
   * question.
   *
   * NO `summary` FIELD IS READ, ever: it can be tens of thousands of characters,
   * and this file's `message_update` case already records why a log larger than
   * the conversation is not a log.
   */
  | { type: 'compaction_start'; trigger?: string; messageCount?: number }
  | {
      type: 'compaction_end';
      applied?: boolean;
      mode?: string;
      reason?: string;
      messagesBefore?: number;
      messagesAfter?: number;
      droppedMessages?: number;
      /**
       * The tail-relief report (context-auto-compaction-hardening W2).
       *
       * THIS UNION MUST STAY A SUPERSET OF CORE'S (IF-3). A field added to
       * `CompactionEndEvent` and not mirrored here does not fail the build — the
       * structural type simply ignores it — so the only trace of a degradation
       * the user is entitled to know about would be missing from the log.
       */
      tailRelief?: { messages: number; charsRemoved: number };
      durationMs?: number;
    };

/** Trim user content to the configured preview budget (debug only). */
function preview(value: unknown, limit: number): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * Subscribe to the agent's events and record them.
 *
 * Returns the unsubscribe function `controller.subscribe()` gives back.
 *
 * `message_update` fires thousands of times per answer, so it is `trace`-only
 * AND records no content — a `debug` run would otherwise write a log larger
 * than the conversation. The turn timer is a closure variable rather than
 * module state because `turn_end` carries `{message, usage}` and NO duration,
 * so the elapsed time has to be measured here; module state would let one test
 * (or a future second controller) read another's clock.
 */
export function attachAgentEvents(logger: Logger, controller: AgentEventSource): () => void {
  let turnStartedAt = 0;

  return controller.subscribe((event) => {
    switch (event.type) {
      case 'agent_start': {
        // The event itself carries no fields; the three the reader wants are
        // the controller's current configuration.
        const cfg = controller.getConfig();
        logger.info('agent', 'run_start', {
          provider: cfg.provider,
          model: cfg.model,
          thinking: cfg.thinkingLevel,
        });
        break;
      }
      case 'turn_start':
        turnStartedAt = Date.now();
        logger.debug('agent', 'turn_start');
        break;
      case 'turn_end':
        logger.info('agent', 'turn_end', {
          in: event.usage?.inputTokens ?? 0,
          out: event.usage?.outputTokens ?? 0,
          ms: turnStartedAt > 0 ? Date.now() - turnStartedAt : 0,
        });
        break;
      // Context compaction (context-auto-compaction §5.1). At `info`, like
      // `turn_end`, so a run's `agent` records have no unexplained 40-second gap
      // where a summarization was.
      case 'compaction_start':
        logger.info('agent', 'compaction_start', {
          trigger: event.trigger,
          messages: event.messageCount,
        });
        break;
      case 'compaction_end':
        // `applied: false` is a WARN, not an info: it means the run is still at
        // the occupancy that triggered this and is about to send anyway.
        logger[event.applied ? 'info' : 'warn']('agent', 'compaction_end', {
          applied: event.applied,
          mode: event.mode,
          reason: event.reason,
          before: event.messagesBefore,
          after: event.messagesAfter,
          dropped: event.droppedMessages,
          ...(event.tailRelief
            ? {
                clipped: event.tailRelief.messages,
                clippedChars: event.tailRelief.charsRemoved,
              }
            : {}),
          ms: event.durationMs,
        });
        break;
      case 'message_update': {
        // API retry (llm-api-retry-backoff §6.8), ABOVE the `trace` line so a
        // three-minute pause is in the log at the DEFAULT level. Redaction is
        // unaffected: the payload carries no user content, and `message` is already
        // the truncated body `classifyHttpError` produces.
        const se = event.streamEvent;
        if (se?.type === 'retry_scheduled') {
          const cfg = controller.getConfig();
          logger.warn('agent', 'llm_retry_scheduled', {
            attempt: se.attempt,
            maxRetries: se.maxRetries,
            delayMs: se.delayMs,
            errorType: se.errorType,
            retryAfterMs: se.retryAfterMs,
            providerId: cfg.provider,
            modelId: cfg.model,
          });
          break;
        }
        if (se?.type === 'retry_attempt') {
          logger.debug('agent', 'llm_retry_attempt', {
            attempt: se.attempt,
            maxRetries: se.maxRetries,
          });
          break;
        }
        if (se?.type === 'stream_restart') {
          logger.warn('agent', 'llm_stream_restart', {
            attempt: se.attempt,
            discarded: se.discardedToolCallIds?.length ?? 0,
          });
          break;
        }
        logger.trace('agent', 'stream', {
          type: se?.type ?? 'unknown',
          // The SIZE of the increment, never the increment. It is what makes a
          // trace log usable for "where did the time go" without turning it
          // into a second copy of the conversation.
          delta:
            typeof (se as { delta?: unknown } | undefined)?.delta === 'string'
              ? (se as { delta: string }).delta.length
              : undefined,
        });
        break;
      }
      case 'tool_execution_start':
        logger.debug('tool', 'tool_start', {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          ...(logger.isEnabled('debug') ? { args: preview(event.args, logger.previewChars) } : {}),
        });
        break;
      case 'tool_execution_end':
        logger.info('tool', 'tool_end', {
          toolName: event.toolName,
          ms: event.duration ?? 0,
          isError: event.isError === true,
          ...(logger.isEnabled('debug')
            ? { result: preview(event.result, logger.previewChars) }
            : {}),
        });
        break;
      case 'code_execution_start':
        logger.debug('tool', 'code_start', {
          language: event.language,
          ...(logger.isEnabled('debug') ? { code: preview(event.code, logger.previewChars) } : {}),
        });
        break;
      case 'code_execution_end':
        logger.info('tool', 'code_end', {
          ms: event.duration ?? 0,
          isError: Boolean(event.error),
          ...(logger.isEnabled('debug')
            ? { output: preview(event.output, logger.previewChars) }
            : {}),
        });
        break;
      case 'agent_end':
        logger.info('agent', 'run_end', { messages: event.messages?.length ?? 0 });
        break;
    }
  });
}

// ---------------------------------------------------------------------------
// Team event mapping (team-subagents §3.13 / P1-2)
// ---------------------------------------------------------------------------

/**
 * What `attachTeamEvents` needs from a controller. Structural for the same
 * reason `AgentEventSource` is, and OPTIONAL on the method: a controller built
 * with team mode off has no runtime and therefore no events.
 */
export interface TeamEventSource {
  subscribeTeam?(listener: (event: TeamLogEvent) => void): () => void;
}

/** The five members of the CLI-local `TeamEvent` union, as this module reads them. */
export type TeamLogEvent =
  | {
      type: 'dispatch_start';
      dispatchId: string;
      requested: number;
      specs?: Array<{ label?: string; description?: string; prompt?: string }>;
    }
  | {
      type: 'agent_update';
      dispatchId: string;
      run?: { label?: string; phase?: string; lastTool?: string };
    }
  | { type: 'usage'; dispatchId: string; label?: string; usage?: unknown }
  | {
      type: 'message';
      dispatchId: string;
      message?: { from?: string; to?: string; subject?: string; body?: string };
    }
  | {
      type: 'dispatch_end';
      dispatchId: string;
      outcome?: {
        startedAt?: number;
        endedAt?: number;
        aborted?: boolean;
        runs?: Array<{ phase?: string; error?: string; filesTouched?: string[] }>;
        usage?: { inputTokens?: number; outputTokens?: number };
      };
    };

/**
 * Record a dispatch's lifecycle.
 *
 * WITHOUT THIS, A DISPATCH LEAVES NO TRACE IN THE LOG AT ALL (P1-2 / R-19).
 * `TeamEvent` is deliberately CLI-local (D-10), so `attachAgentEvents` cannot
 * see it — which is the wrong outcome for the one feature in this CLI that runs
 * five agents the user cannot watch, and whose only other artefact is a report
 * written by the thing that failed. A separate function rather than a branch in
 * `attachAgentEvents` (D-19): the two consume different unions and want
 * different level policies.
 *
 * TWO RULES, BOTH ABOUT NOT TURNING A LOG INTO A LIABILITY:
 *
 *  - A subagent's PROMPT and its SUMMARY are `trace` only, and go through the
 *    same redaction every other record does. A `prompt` is up to 8 000
 *    characters of whatever the lead decided to say; at `debug` it would
 *    dominate the file.
 *  - A `team_send` BODY is never recorded at any level. The subject is enough to
 *    reconstruct who talked to whom and when, which is the diagnostic question;
 *    the body is user content that reached no other sink.
 *
 * `agent_update` is recorded on PHASE TRANSITIONS ONLY, not on the 120 ms
 * coalescer tick: that throttle exists to protect React, and five children at
 * eight events a second each is 40 lines a second of noise that would push the
 * retention window down to minutes.
 */
export function attachTeamEvents(logger: Logger, controller: TeamEventSource): () => void {
  if (!controller.subscribeTeam) return () => {};
  const lastPhase = new Map<string, string>();

  return controller.subscribeTeam((event) => {
    switch (event.type) {
      case 'dispatch_start': {
        const specs = event.specs ?? [];
        logger.info('agent', 'team_dispatch_start', {
          dispatchId: event.dispatchId,
          requested: event.requested,
          accepted: specs.length,
          labels: specs.map((s) => s.label ?? '?'),
        });
        for (const spec of specs) {
          logger.trace('agent', 'team_subagent_brief', {
            dispatchId: event.dispatchId,
            label: spec.label,
            description: spec.description,
            prompt: spec.prompt,
          });
        }
        break;
      }
      case 'agent_update': {
        const key = `${event.dispatchId}:${event.run?.label ?? '?'}`;
        const phase = event.run?.phase ?? 'unknown';
        if (lastPhase.get(key) === phase) break;
        lastPhase.set(key, phase);
        logger.debug('agent', 'team_agent_update', {
          dispatchId: event.dispatchId,
          label: event.run?.label,
          phase,
          lastTool: event.run?.lastTool,
        });
        break;
      }
      case 'message':
        logger.debug('agent', 'team_message', {
          dispatchId: event.dispatchId,
          from: event.message?.from,
          to: event.message?.to,
          // SUBJECT ONLY. See the rule above; the body never leaves the process.
          subject: event.message?.subject,
        });
        break;
      case 'dispatch_end': {
        const outcome = event.outcome;
        const runs = outcome?.runs ?? [];
        const ok = runs.filter((r) => r.phase === 'done' && !r.error).length;
        logger.info('agent', 'team_dispatch_end', {
          dispatchId: event.dispatchId,
          durationMs: Math.max(0, (outcome?.endedAt ?? 0) - (outcome?.startedAt ?? 0)),
          ok,
          failed: runs.length - ok,
          aborted: outcome?.aborted === true,
          in: outcome?.usage?.inputTokens ?? 0,
          out: outcome?.usage?.outputTokens ?? 0,
          filesTouched: [...new Set(runs.flatMap((r) => r.filesTouched ?? []))],
        });
        break;
      }
      default:
        break;
    }
  });
}
