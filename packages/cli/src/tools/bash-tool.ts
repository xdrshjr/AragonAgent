/**
 * bash tool — run a shell command at full permission (spec §3.6), and, since
 * background-service-supervision, supervise the ones that do not exit.
 *
 * Shell selection: Windows uses `process.env.ComSpec` (cmd.exe by default);
 * POSIX uses `/bin/sh -c`. The command's stdout+stderr and exit code are
 * captured. The `timeout?` param can only SHRINK within the executor ceiling
 * (the core ToolExecutor owns the real timeout + 100 KB truncation — R4), so
 * this tool does not re-implement an output cap.
 *
 * I-1 — THIS TOOL NEVER LEAVES ITS PROMISE PENDING. Every exit path goes through
 * `settle`, and `settle` is reachable from FIVE places: `'error'`, `'close'`,
 * `'exit'` plus a drain timer, an abort plus a kill grace, and the `timeout`
 * param plus the same grace. That is the whole of W1, and each of the five
 * closes a way the old implementation could hang:
 *
 *   1. It settled on `'close'`, which fires only when the process has exited AND
 *      every stdio stream is closed. A child that spawns a detached grandchild
 *      inheriting the pipe — `Start-Process`, `&`, `nohup`, and every
 *      `npm run dev` that re-execs — keeps that pipe open after the shell is
 *      long gone. The shell exited; the promise did not.
 *   2. `stdio` defaulted to `'pipe'` for stdin, so a command that PROMPTS —
 *      `npm init`, a package manager asking to install something, `sudo`, a git
 *      credential prompt — blocked on a read that could never be satisfied.
 *   3. An abort killed the tree and then went on waiting for a `'close'` that a
 *      detached grandchild was still holding.
 *
 * The happy path is BYTE-IDENTICAL to the pre-change build: `$ cmd\n<output>\n
 * [exit code N]`, same truncation, same footer. That is what keeps the existing
 * `bash` assertions meaningful rather than rewritten.
 */

import { spawn } from 'node:child_process';
import process from 'node:process';
import {
  defineTool,
  errorResult,
  textResult,
  type AgentTool,
  type ToolResult,
} from '@aragon-agent/core';
import { looksLongRunning } from '../proc/classify.js';
import { killTree } from '../proc/kill-tree.js';
import { PROC_LIMITS } from '../proc/limits.js';
import type { ProcSupervisorPort, ServiceSnapshot } from '../proc/types.js';
import type { ToolDeps } from './fs-tools.js';

/**
 * The two sentences appended to the tool description when background launches
 * are available.
 *
 * MODEL-FACING POLICY, so their wording is versioned with the prompt block in
 * `proc/prompt.ts` rather than treated as a comment. They are appended
 * CONDITIONALLY, which is half of what keeps I-2 true: with the feature off the
 * description — and therefore the system prompt's tool list — is the pre-feature
 * string, byte for byte.
 */
const BACKGROUND_DESCRIPTION =
  ' Set `background: true` for anything that does not exit on its own - dev ' +
  'servers, watchers, `docker compose up`. Never use `Start-Process`, `&`, ' +
  '`nohup` or `screen` to detach a command yourself; the runtime supervises ' +
  'background commands, and a self-detached process cannot be reported on or ' +
  'stopped.';

/**
 * The settle window used when a supervisor is supplied WITHOUT one.
 *
 * Only reachable from a test that builds the tool by hand: `AgentController`
 * always passes `cfg.bash.startupSettleMs`. It mirrors `DEFAULT_BASH_CONFIG`
 * rather than importing it, because nothing in `tools/` imports `config/` — a
 * tool takes its policy through the closures below, which is what
 * `startupSettleMs` is. It is NOT expressed in terms of `PROC_LIMITS`: those are
 * structural bounds, this is policy, and a multiple of `killGraceMs` that
 * happens to equal the default today would silently move if that bound ever did.
 */
const FALLBACK_STARTUP_SETTLE_MS = 4000;

export interface BashToolOptions {
  /**
   * Present only when background launches are on for this session.
   *
   * ITS ABSENCE IS WHAT MAKES I-2 CHECKABLE: no `background` property in the
   * schema, no supervisor call, no readiness timer, and a description string
   * identical to the pre-feature one.
   */
  supervisor?: ProcSupervisorPort;
  /** `cfg.bash.autoBackground`, read LIVE. */
  autoBackground?: () => boolean;
  /** `cfg.bash.startupSettleMs`, read LIVE. */
  startupSettleMs?: () => number;
  /**
   * Whether a card can be rendered and a user can keep a service alive (D-15 /
   * P1-8).
   *
   * FALSE IN `aragon exec` AND `-p`. It suppresses only the CLASSIFIER: an
   * explicit `background: true` is still honoured — the model asked for it —
   * and the result then carries one extra line saying the service dies with the
   * run. Without this rule `aragon -p "npm run dev"` would background a server,
   * return in `startupSettleMs`, and reap it at process exit with no card, no
   * `/bg`, no event and nothing in the result saying so.
   */
  interactive?: boolean;
}

/**
 * The foreground registry a `bash` child registers with, so `forceStop()` can
 * reach it. `undefined` on the paths that build tools without a supervisor
 * (every existing test), which is what keeps those byte-identical.
 */
function trackForeground(
  supervisor: ProcSupervisorPort | undefined,
  pid: number | undefined,
): () => void {
  return supervisor ? supervisor.trackForeground(pid) : () => {};
}

/** Render a background launch's result block for the model (§3.5). */
function renderServiceResult(
  service: ServiceSnapshot,
  opts: { ephemeral: boolean },
): ToolResult {
  const lines: string[] = [`$ ${service.command}`];
  lines.push(`[background] service ${service.id} started (pid ${service.pid ?? '?'})`);

  const elapsed = ((service.readyAt ?? service.endedAt ?? Date.now()) - service.startedAt) / 1000;
  if (service.status === 'ready') {
    const how = service.detectedBy === 'probe' ? 'port probe' : 'output';
    const where = service.url ?? (service.port ? `port ${service.port}` : '');
    lines.push(`[ready] ${where}  (detected from ${how} after ${elapsed.toFixed(1)}s)`);
  } else if (service.status === 'running') {
    lines.push(`[running] still alive, nothing to connect to (a watcher, most likely)`);
  } else if (service.status === 'exited' || service.status === 'failed') {
    const code = service.exitCode === null ? `signal ${service.signal}` : `code ${service.exitCode}`;
    lines.push(`[exited] ${code} after ${elapsed.toFixed(1)}s`);
  } else {
    lines.push(`[starting] not ready yet after ${elapsed.toFixed(1)}s - still coming up`);
  }

  if (service.portPreoccupied && service.port !== undefined) {
    lines.push(`[note] port ${service.port} was already in use before start`);
  }

  if (service.rows.length > 0) {
    lines.push('[log tail]');
    for (const row of service.rows) lines.push(`  ${row}`);
  }

  if (opts.ephemeral) {
    // D-15 / P1-8: headless has no user who could keep it alive, and saying so
    // is the difference between a surprise and a documented behaviour.
    lines.push('[note] this service will be stopped when the run ends.');
  }

  lines.push(
    `Read more with bash_output({ service: "${service.id}" }); ` +
      `stop it with bash_kill({ service: "${service.id}" }).`,
  );

  const body = lines.join('\n');
  // A service that DIED is an error result, so the model treats it as one: this
  // is the failure the user actually cares about, reported in 400 ms instead of
  // three minutes of stall (G1).
  return service.status === 'exited' && service.exitCode !== 0
    ? errorResult(body)
    : service.status === 'failed'
    ? errorResult(body)
    : textResult(body);
}

export function makeBash(deps: ToolDeps, options: BashToolOptions = {}): AgentTool {
  const supervisor = options.supervisor;
  const backgroundAvailable = supervisor !== undefined;

  return defineTool({
    name: 'bash',
    label: 'Shell',
    description:
      'Run a shell command at full permission and return its combined ' +
      'stdout+stderr and exit code. `timeout` (ms) may only shrink within the ' +
      'agent tool-timeout ceiling; `cwd` defaults to the working directory. ' +
      'Emit shell syntax compatible with the OS/shell stated in the system prompt.' +
      (backgroundAvailable ? BACKGROUND_DESCRIPTION : ''),
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to run.' },
        timeout: { type: 'number', description: 'Optional timeout in milliseconds (shrinks within the ceiling).' },
        cwd: { type: 'string', description: 'Working directory for this command.' },
        // SPREAD CONDITIONALLY. With the feature off the schema is the object it
        // is today, which is what `buildSystemPrompt`'s byte-identity claim (I-2)
        // is measured against.
        ...(backgroundAvailable
          ? {
              background: {
                type: 'boolean',
                description:
                  'true = supervise this command and return immediately with a ' +
                  'service id. false = never background it. Omit to let the ' +
                  'runtime decide from the command.',
              },
            }
          : {}),
      },
      required: ['command'],
    },
    // `id` rather than `_id`: the tool-call id is what keys the live-output side
    // channel (agent-activity-presentation-live §3.1.2).
    async execute(id, rawParams, ctx) {
      const params = rawParams as {
        command: string;
        timeout?: number;
        cwd?: string;
        background?: boolean;
      };
      const command = params.command;
      const cwd = params.cwd ? params.cwd : deps.getCwd();

      // --- The three-valued background decision (D-2 / §3.5) ----------------
      //
      // `true`  -> background, always.
      // `false` -> foreground, always. The escape hatch; nothing overrides it.
      // absent  -> the classifier, and only where a card can be rendered.
      if (supervisor && params.background !== false) {
        const auto =
          options.interactive !== false &&
          options.autoBackground?.() !== false &&
          looksLongRunning(command);
        if (params.background === true || auto) {
          return runBackground(supervisor, {
            command,
            cwd,
            toolCallId: id,
            settleMs: options.startupSettleMs?.() ?? FALLBACK_STARTUP_SETTLE_MS,
            ephemeral: options.interactive === false,
          });
        }
      }

      return new Promise((resolvePromise) => {
        let child;
        try {
          // shell:true delegates to ComSpec (Windows) / /bin/sh (POSIX) and
          // handles command-line quoting far more reliably than a hand-built
          // cmd.exe arg array, which double-escapes nested quotes on Windows.
          child = spawn(command, {
            shell: true,
            cwd,
            env: process.env,
            windowsHide: true,
            // W1.2 — NO UNANSWERABLE READ. `spawn` defaults every descriptor to
            // a pipe, so a command that prompts blocks on a read nobody will
            // ever satisfy and the promise never settles. `'ignore'` turns that
            // into an EOF the command can react to.
            stdio: ['ignore', 'pipe', 'pipe'],
          });
        } catch (err) {
          resolvePromise(errorResult(err instanceof Error ? err.message : String(err)));
          return;
        }

        const releaseForeground = trackForeground(supervisor, child.pid);

        let output = '';
        let settled = false;
        let drainTimer: NodeJS.Timeout | undefined;
        let graceTimer: NodeJS.Timeout | undefined;
        let selfTimer: NodeJS.Timeout | undefined;
        /**
         * WHY the child is being killed, when it is.
         *
         * THE FLAG OUTRANKS `'close'`, AND THAT ORDERING IS THE WHOLE POINT.
         * Killing a tree usually DOES produce a prompt `'close'`, so a `'close'`
         * handler that rendered the ordinary `[signal SIGTERM]` body would win
         * the race in the common case and the honest footer would only ever be
         * seen in the rare one - the model would be told "the command was
         * signalled" instead of "the command was still running when the ceiling
         * fired, re-run it in the background", which is precisely the sentence
         * that stops it reaching for `Start-Process`. The pre-change build made
         * the same choice for its `killedByTimeout` flag, for the same reason.
         */
        let killReason: 'timeout' | 'abort' | undefined;

        /**
         * The result body, from whatever is known at settle time.
         *
         * ONE BUILDER FOR ALL FIVE SETTLE PATHS, so a footer can never depend on
         * WHICH of them got there first - the property that makes the abort and
         * timeout wordings deterministic rather than a race.
         */
        const buildBody = (opts: {
          code: number | null;
          signalName: NodeJS.Signals | null;
          note?: boolean;
        }): ToolResult => {
          const body = captured();
          if (killReason === 'timeout') {
            // BYTE-IDENTICAL TO THE PRE-CHANGE BUILD for the `timeout` param.
            return errorResult(`Command timed out after ${params.timeout}ms.\n${body}`);
          }
          if (killReason === 'abort') {
            // P1-5. The captured output is the evidence the model needs, and
            // `ctx.abortCause` is what separates "the ceiling fired" (which earns
            // the advice) from "the user pressed Esc" (which does not - they did
            // not ask for a workaround).
            const footer =
              ctx.abortCause === 'timeout'
                ? '[aborted - the command was still running]\n' +
                  'It does not look like this command terminates on its own. ' +
                  'Re-run it with `background: true` if it is a server or a watcher.'
                : '[aborted]';
            return errorResult(`$ ${command}\n${body}\n${footer}`);
          }
          const status =
            opts.code === null ? `signal ${opts.signalName}` : `exit code ${opts.code}`;
          const note = opts.note
            ? '[note] the command exited but a background child is still holding its ' +
              'output stream.\n'
            : '';
          const text = `$ ${command}\n${body}\n${note}[${status}]`;
          return opts.code === 0 ? textResult(text) : errorResult(text);
        };

        /**
         * THE ONE FUNNEL. Idempotent, clears every timer, removes the abort
         * listener and releases the foreground registration. Five call sites;
         * see the module header for which ways of hanging each one closes.
         */
        const settle = (build: () => ToolResult): void => {
          if (settled) return;
          settled = true;
          if (drainTimer) clearTimeout(drainTimer);
          if (graceTimer) clearTimeout(graceTimer);
          if (selfTimer) clearTimeout(selfTimer);
          ctx.signal?.removeEventListener('abort', onAbort);
          releaseForeground();
          resolvePromise(build());
        };

        const captured = (): string => (output.length > 0 ? output : '(no output)');

        /**
         * Arm the post-kill force-settle. AT MOST ONCE.
         *
         * Both kill paths reach it and the executor's ceiling aborts through
         * `ctx.signal` a moment after the tool's own timer fires, so a plain
         * assignment would overwrite a pending timer with a second one — and
         * `settle` clears only the reference it can see, leaving the orphan to
         * hold the loop for another `killGraceMs` after the promise resolved.
         */
        const armGrace = (): void => {
          if (graceTimer) return;
          graceTimer = setTimeout(() => {
            settle(() => buildBody({ code: null, signalName: null }));
          }, PROC_LIMITS.killGraceMs);
        };

        // Self-timer for the `timeout` param (shrinks within the executor ceiling).
        if (params.timeout && params.timeout > 0) {
          selfTimer = setTimeout(() => {
            killReason = 'timeout';
            killTree(child.pid, 'SIGKILL');
            // THE SAME GRACE THE ABORT PATH USES. Killing is not settling: a
            // detached grandchild can hold the pipe open past the kill, and the
            // old build then waited for a `'close'` that never came.
            armGrace();
          }, params.timeout);
        }

        /**
         * Cooperative cancellation via the executor/agent AbortSignal.
         *
         * THE FORCE-SETTLED BODY CARRIES THE CAPTURED OUTPUT AND NAMES THE CAUSE
         * (P1-5), and that is not a nicety. Today an abort kills the tree,
         * `'close'` fires, and the model receives `$ cmd`, everything printed,
         * and `[signal SIGTERM]`. The executor's own ceiling
         * (`DEFAULT_TOOL_TIMEOUT_MS`) aborts through this SAME signal — so a bare
         * `Command aborted.` would hand the model three words and no evidence at
         * exactly the moment it needs to learn that the command does not
         * terminate, which is the evidence that makes it reach for
         * `background: true` instead of `Start-Process`.
         *
         * `ctx.abortCause` is what separates the two: `'timeout'` earns the
         * advice, `'external'` (an Esc) does not — the user did not ask the model
         * for a workaround.
         */
        const onAbort = (): void => {
          // NOT OVERWRITTEN when a `timeout` kill is already in force: the
          // executor's ceiling aborts through this same signal a moment after
          // the tool's own timer fired, and the `timeout` wording is the more
          // specific of the two.
          killReason ??= 'abort';
          killTree(child.pid, 'SIGKILL');
          armGrace();
        };
        ctx.signal?.addEventListener('abort', onAbort, { once: true });

        // `output` IS UNTOUCHED BY THE RECORDER, and that is what makes AC-30
        // checkable by comparison rather than by inspection: the string the
        // model receives, its truncation and the `[exit code N]` footer are all
        // byte-identical to the pre-round build. The recorder is a SECOND
        // consumer of a chunk this tool already had (R-7).
        //
        // No throttle here, deliberately: `append` is O(chunk), and a per-chunk
        // throttle in the tool would drop the LAST chunk of a burst -- the one
        // that matters. What must be throttled is the view update, and `App`
        // does that where the machinery for it already lives (§3.1.2 / D-34).
        child.stdout?.on('data', (d) => {
          const s = d.toString();
          output += s;
          deps.recordOutput?.(id, s);
        });
        child.stderr?.on('data', (d) => {
          const s = d.toString();
          output += s;
          deps.recordOutput?.(id, s);
        });

        child.on('error', (err) => {
          settle(() => errorResult(`Failed to run command: ${err.message}`));
        });

        /**
         * DEFENCE 1. `'exit'` fires when the PROCESS ends; `'close'` waits for
         * every stdio stream, which a detached grandchild can hold open forever.
         * So `'exit'` starts a short drain and `'close'` — if it arrives — wins
         * the race and produces the byte-identical happy-path body.
         */
        child.on('exit', (code, signalName) => {
          if (settled || drainTimer) return;
          drainTimer = setTimeout(() => {
            settle(() => buildBody({ code, signalName, note: true }));
          }, PROC_LIMITS.drainMs);
        });

        child.on('close', (code, signalName) => {
          settle(() => buildBody({ code, signalName }));
        });
      });
    },
  });
}

/**
 * Start a supervised service and return as soon as there is something true to
 * say (D-3).
 *
 * THE FIRST OF THREE: ready, exit, or `startupSettleMs`. Never later. A 400 ms
 * crash is reported in 400 ms with the stack in the tool result, and a slow
 * server never costs more than the settle window of turn time.
 *
 * IT DOES NOT CALL `deps.recordOutput` (P2-9). The tool call settles within the
 * window and `tool_execution_end` then clears the live-output slot, so a tail
 * written there would flash and vanish; the `ServiceCard` owns this service's
 * output for its whole life and is the only surface that can keep it.
 */
async function runBackground(
  supervisor: ProcSupervisorPort,
  args: {
    command: string;
    cwd: string;
    toolCallId: string;
    settleMs: number;
    ephemeral: boolean;
  },
): Promise<ToolResult> {
  const started = await supervisor.start({
    command: args.command,
    cwd: args.cwd,
    toolCallId: args.toolCallId,
  });
  if (!started.ok || !started.service) {
    return errorResult(started.error ?? 'Could not start the background service.');
  }
  const id = started.service.id;

  const settled = await new Promise<ServiceSnapshot>((resolve) => {
    let done = false;
    const finish = (snapshot: ServiceSnapshot): void => {
      if (done) return;
      done = true;
      unsubscribe();
      clearTimeout(timer);
      resolve(snapshot);
    };
    const unsubscribe = supervisor.subscribe((event) => {
      if (event.service.id !== id) return;
      if (event.type === 'ready' || event.type === 'exited' || event.type === 'stopped') {
        finish(event.service);
      }
    });
    const timer = setTimeout(() => finish(supervisor.get(id) ?? started.service!), args.settleMs);
    timer.unref?.();
    // A service that finished between `start()` and this subscription (a crash
    // inside 1 ms is not hypothetical) would otherwise wait out the whole window.
    const now = supervisor.get(id);
    if (now && now.status !== 'starting') finish(now);
  });

  return renderServiceResult(settled, { ephemeral: args.ephemeral });
}
