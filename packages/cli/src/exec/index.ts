/**
 * `aragon exec` - wiring only (cli-integration-surface section 3.3 / 6.1).
 *
 * ASCII ONLY - `src/exec/**` is inside the glyph scanner's scope.
 *
 * NO PROCESS-GLOBAL STATE, AND THAT IS A RULE RATHER THAN A HABIT (section 2.2).
 * A programmatic Node API is the deferral most likely to be asked for first, and
 * the only thing that makes it cheap later is `runExec()` holding nothing the
 * process owns: the controller arrives through a factory, both streams are
 * parameters, and the exit code is RETURNED rather than assigned.
 *
 * THE CONTROLLER COMES FROM A FACTORY BECAUSE `makeController` LIVES IN
 * `cli.tsx` (see the note on `ExecControllerFactory`). Reaching for it directly
 * would make `cli.tsx -> exec/cli-commands.ts -> exec/index.ts -> cli.tsx` a
 * cycle, and duplicating it here would give the headless approval gates a second
 * definition - the one thing `makeController`'s own comment says must not
 * happen.
 */

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import process from 'node:process';
import type { AgentController } from '../agent/controller.js';
import { runHeadless } from '../agent/headless.js';
import { computeCost } from '../agent/usage.js';
import { loadConfig, type CliFlags } from '../config/load.js';
import {
  latestSessionForCwd,
  readSessionFile,
  resolveSessionRef,
  resumedSessionId,
  sessionPathFor,
  tryAcquireSessionLock,
  writeSession,
  type SessionLockHandle,
} from '../session/store.js';
import type { SavedSession, SessionMeta } from '../session/persist.js';
import { createEmitter, type ExecEmitter } from './emitter.js';
import type { ExecPermissionMode, ExecResultParams } from './events.js';
import { resolveExecOptions, type ExecOptions, type RawExecOptions } from './options.js';
import { resolvePermission, type ToolPermission } from './permission.js';
import { ExecRunner, singlePrompt, type ExecPromptSource } from './runner.js';
import { createStdinPromptSource, prefixSource } from './stdin-stream.js';

/**
 * How `runExec` obtains a controller.
 *
 * `cli.tsx` supplies `(flags, deps) => makeController(flags, { interactive:
 * false, ...deps }).controller`, already wired for headless: the deny-all
 * approval gate, the deny-all human-input gate, the log attachments and the
 * untrusted-skill notices. Everything this module needs and nothing it should
 * decide for itself.
 */
export type ExecControllerFactory = (
  flags: CliFlags,
  deps: { permission?: ToolPermission; appendSystemPrompt?: string },
) => AgentController;

export interface RunExecContext {
  version: string;
  makeController: ExecControllerFactory;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  stdin?: NodeJS.ReadableStream;
  /** Injected by tests so a run never touches the real clock. */
  now?: () => number;
}

/**
 * Run one `aragon exec` invocation and resolve with the process exit code.
 *
 * EXIT 2 MEANS THE RUN NEVER STARTED, AND STDOUT CARRIES NOTHING ON THAT PATH.
 * Option errors, prompt errors and session errors are all reported on stderr
 * alone: emitting a lone `result` line for them would break the guarantee
 * `system/init` is the FIRST stream-json line (AC-5), and a wrapper that got a
 * `result` without an `init` could not tell a run that failed to start from one
 * that failed. A preflight failure is different - the format is settled and the
 * schema has begun - so that one DOES emit a `result` with `exitCode: 2`.
 */
export async function runExec(
  flags: CliFlags,
  raw: RawExecOptions,
  promptArg: string | undefined,
  ctx: RunExecContext,
): Promise<number> {
  const out = ctx.stdout ?? process.stdout;
  const err = ctx.stderr ?? process.stderr;
  const now = ctx.now ?? Date.now;

  const resolved = resolveExecOptions(raw);
  if (!resolved.ok) {
    err.write(`${resolved.message}\n`);
    return 2;
  }
  const options = resolved.options;
  for (const warning of options.warnings) err.write(`${warning}\n`);

  const appended = readOptionalText(
    options.appendSystemPrompt,
    options.appendSystemPromptFile,
    err,
    '--append-system-prompt-file',
  );
  if (appended === null) return 2;

  const cwd = loadConfig(flags).cwd;
  const plan = planSession(options, cwd, err);
  if (!plan) return 2;

  const prompts = resolvePromptSource(options, promptArg, ctx, err);
  if (!prompts) return 2;

  const lock = plan.saving ? tryAcquireSessionLock(plan.id) : null;
  if (plan.saving && !lock) {
    err.write(
      `session_busy: another aragon exec run holds session "${plan.id}". ` +
        'Retry, or use a different --session-id.\n',
    );
    return 2;
  }

  try {
    return await execute({ flags, options, plan, prompts, ctx, out, err, now, appended });
  } finally {
    lock?.release();
  }
}

// ---------------------------------------------------------------------------
// The run itself
// ---------------------------------------------------------------------------

interface ExecuteInput {
  flags: CliFlags;
  options: ExecOptions;
  plan: SessionPlan;
  prompts: ExecPromptSource;
  ctx: RunExecContext;
  out: NodeJS.WritableStream;
  err: NodeJS.WritableStream;
  now: () => number;
  appended: string;
}

async function execute(input: ExecuteInput): Promise<number> {
  const { options, plan, ctx, out, err, now } = input;
  const startedAt = now();
  const permission = resolvePermission({
    mode: options.permissionMode,
    allow: options.allowTools,
    deny: options.denyTools,
  });
  const controller = ctx.makeController(withPermissionMode(input.flags, options.permissionMode), {
    ...(permission ? { permission } : {}),
    ...(input.appended ? { appendSystemPrompt: input.appended } : {}),
  });

  const emitter: ExecEmitter = createEmitter(options.outputFormat, out);
  const runner = new ExecRunner({
    emitter,
    sessionId: plan.id,
    ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
    ...(options.maxDurationMs !== undefined ? { maxDurationMs: options.maxDurationMs } : {}),
    partialMessages: options.partialMessages,
    includeThinking: options.includeThinking,
    followThrough: controller.getTodoConfig().followThrough,
    quiet: options.quiet,
    stderr: err,
    now,
  });

  if (plan.saved) {
    controller.replaceMessages(plan.saved.messages);
    controller.restoreTodos(plan.saved.todos);
  }

  const config = controller.getConfig();
  emitter.init({
    sessionId: plan.id,
    cli: ctx.version,
    cwd: controller.getCwd(),
    startedAt,
    model: {
      provider: config.provider,
      id: config.model,
      baseUrl: config.baseUrl ?? null,
    },
    permissionMode: options.permissionMode,
    tools: controller.listTools().map((t) => t.name),
    resumed: plan.saved !== null,
  });

  runner.attach(controller);

  const pre = controller.preflight();
  if (!pre.ok) {
    runner.detach();
    controller.dispose();
    err.write(`${pre.message ?? 'Configuration error.'}\n`);
    emitter.result(
      failedResult(plan.id, config, pre.message ?? 'Configuration error.', 'config', now() - startedAt),
    );
    return 2;
  }

  let exitCode = 0;
  try {
    exitCode = await drive(input, controller, runner);
  } finally {
    runner.detach();
    controller.dispose();
  }

  // PERSIST FIRST, ANNOUNCE SECOND (D-2). A caller that reads `result` and
  // immediately respawns with the same `--session-id` must not race the writer
  // of the file it is about to read.
  const stats = runner.stats();
  if (plan.saving) persist(plan, controller, stats.turns, stats.usage, ctx.version, now());

  const todo = controller.getTodoSnapshot?.() ?? null;
  emitter.result({
    sessionId: plan.id,
    isError: exitCode === 1,
    stopReason: stats.stopReason,
    exitCode,
    result: stats.lastAssistantText,
    turns: stats.turns,
    durationMs: now() - startedAt,
    usage: {
      inputTokens: stats.usage.inputTokens,
      outputTokens: stats.usage.outputTokens,
      totalTokens: stats.usage.inputTokens + stats.usage.outputTokens,
    },
    cost: buildCost(controller, stats.usage),
    model: { provider: config.provider, id: config.model },
    todos: todo ? { total: todo.total, done: todo.doneCount } : null,
    error:
      stats.errorCode && stats.errorMessage
        ? { code: stats.errorCode, message: stats.errorMessage }
        : null,
  });
  return exitCode;
}

/**
 * `text` DELEGATES TO `runHeadless` VERBATIM (D-1 / AC-1).
 *
 * Same controller, same `quiet`, same `followThrough`, same streams. That is the
 * entire text path: reimplementing it inside the emitter would make "the human
 * CLI is unchanged" an argument someone has to trust instead of a fact anyone
 * can check, and the two would drift the first time a retry line changed.
 */
async function drive(
  input: ExecuteInput,
  controller: AgentController,
  runner: ExecRunner,
): Promise<number> {
  const { options, prompts, out, err } = input;
  if (options.outputFormat !== 'text') {
    await runner.run(prompts);
    return runner.exitCode();
  }
  const first = await prompts.next();
  if (first === null) {
    err.write('No prompt provided for `aragon exec`.\n');
    return 2;
  }
  const code = await runHeadless(controller, first, {
    quiet: options.quiet,
    followThrough: controller.getTodoConfig().followThrough,
    stdout: out,
    stderr: err,
  });
  // An interrupt still wins: `runHeadless` cannot know a signal arrived, and
  // reporting 0 for a run the user stopped would be a lie a shell script acts on.
  return runner.stats().stopReason === 'interrupted' ? runner.exitCode() : code;
}

/**
 * `--permission-mode plan` IS `--plan`, and something has to carry it there.
 *
 * `resolvePermission` returns `undefined` for `plan` ON PURPOSE (P0-2): the mode
 * contributes NOTHING to the registration filter, because `--plan` does not
 * unregister the five in `PLAN_MODE_BLOCKED_TOOLS` - it registers them and
 * refuses at call time, which is what keeps the refusal text that steers the
 * model to `submit_plan`. But that leaves the mode with no carrier at all unless
 * something turns it on, and `AgentController` reads it from exactly ONE place:
 * `config.startInPlanMode`, which `loadConfig` resolves from `flags.plan`.
 *
 * WITHOUT THIS LINE THE FLAG IS A SILENT NO-OP OF THE WORST KIND (IF-6). The run
 * would report `permissionMode: "plan"` in `system/init` while the plan gate was
 * never armed and the system prompt carried no plan block - so a caller who
 * asked for "read-only research and a written plan", the README's own example,
 * would get a run that edits files, with nothing anywhere reporting it. Note
 * that comparing `listTools()` against `-p --plan` does NOT catch it: both
 * spellings register the same names either way, because the plan gate wraps
 * rather than removes.
 *
 * ONLY `plan` TOUCHES THE FLAGS. `auto` and `strict` return the SAME object, so
 * every other path builds today's config exactly - which is what keeps text mode
 * byte-identical to `-p` (AC-1), and leaves a user whose `config.json` sets
 * `planModeDefault: true` with the plan mode `-p` would have given them.
 */
function withPermissionMode(flags: CliFlags, mode: ExecPermissionMode): CliFlags {
  return mode === 'plan' ? { ...flags, plan: true } : flags;
}

function buildCost(
  controller: AgentController,
  usage: { inputTokens: number; outputTokens: number },
): { amount: number; currency: 'USD'; known: boolean } {
  const config = controller.getConfig();
  const known = controller.isPricedModel({
    providerId: config.provider,
    modelId: config.model,
  });
  // `amount` is `0` when the price is unknown, mirroring the fast tier's rule
  // that a feature which looks free while it is spending money is worse than one
  // that admits it does not know.
  return {
    amount: known ? computeCost(usage, controller.getModelInfo().cost) : 0,
    currency: 'USD',
    known,
  };
}

function failedResult(
  sessionId: string,
  config: { provider: string; model: string },
  message: string,
  code: string,
  durationMs: number,
): ExecResultParams {
  return {
    sessionId,
    isError: true,
    stopReason: 'error',
    exitCode: 2,
    result: '',
    turns: 0,
    durationMs,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    cost: { amount: 0, currency: 'USD', known: false },
    model: { provider: config.provider, id: config.model },
    todos: null,
    error: { code, message },
  };
}

// ---------------------------------------------------------------------------
// Prompt resolution (section 4.1)
// ---------------------------------------------------------------------------

/**
 * Positional argument, then `--prompt-file`, then stdin - first match wins.
 *
 * Returns `null` after writing the reason to stderr, so the caller can exit 2
 * without a second error vocabulary.
 */
function resolvePromptSource(
  options: ExecOptions,
  promptArg: string | undefined,
  ctx: RunExecContext,
  err: NodeJS.WritableStream,
): ExecPromptSource | null {
  const stdin = ctx.stdin ?? process.stdin;
  const opening: string[] = [];
  const positional = promptArg?.trim();
  if (positional) opening.push(positional);
  else if (options.promptFile) {
    const text = readTextFile(options.promptFile, err, '--prompt-file');
    if (text === null) return null;
    if (text.trim().length > 0) opening.push(text);
  }

  if (options.inputFormat === 'stream-json') {
    return prefixSource(
      opening,
      createStdinPromptSource({
        input: stdin,
        // Reported on stderr rather than as a schema event, because the runner
        // owns the emitter and this source is constructed before it exists. The
        // line is skipped either way, which is the property AC-20 pins.
        onBadLine: (message) => err.write(`${message}\n`),
        // The runner installs the signal terminator; a caller-requested
        // interrupt is the same intent arriving through a different channel.
        onInterrupt: () => process.kill(process.pid, 'SIGINT'),
      }),
    );
  }

  if (opening.length === 0 && !stdinIsTty(stdin)) {
    // Piped stdin, `--input-format text`: the whole of stdin is the prompt.
    return { next: makeOnce(() => readAllSync(stdin)) };
  }
  if (opening.length === 0) {
    err.write(
      'no_prompt: pass a prompt argument, --prompt-file <path>, or pipe one on stdin.\n',
    );
    return null;
  }
  return singlePrompt(opening[0] as string);
}

function makeOnce(read: () => Promise<string | null>): () => Promise<string | null> {
  let served = false;
  return async (): Promise<string | null> => {
    if (served) return null;
    served = true;
    return read();
  };
}

function stdinIsTty(stdin: NodeJS.ReadableStream): boolean {
  return (stdin as NodeJS.ReadStream).isTTY === true;
}

async function readAllSync(stdin: NodeJS.ReadableStream): Promise<string | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  const text = Buffer.concat(chunks).toString('utf-8').trim();
  return text.length > 0 ? text : null;
}

/** `''` when neither source is set, `null` when a file could not be read. */
function readOptionalText(
  inline: string | undefined,
  file: string | undefined,
  err: NodeJS.WritableStream,
  flag: string,
): string | null {
  const parts: string[] = [];
  if (inline) parts.push(inline);
  if (file) {
    const text = readTextFile(file, err, flag);
    if (text === null) return null;
    parts.push(text);
  }
  return parts.join('\n\n');
}

function readTextFile(path: string, err: NodeJS.WritableStream, flag: string): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch (e) {
    err.write(`${flag}: could not read ${path} (${(e as Error).message}).\n`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Session resolution (section 3.4)
// ---------------------------------------------------------------------------

interface SessionPlan {
  id: string;
  saved: SavedSession | null;
  /** `false` under `--no-save-session`: no lock, no file, no pointer. */
  saving: boolean;
  cwd: string;
}

/**
 * The three resume forms, and how they differ:
 *
 *   `--session-id <id>`  resume it, or CREATE it (the wrapper-friendly upsert)
 *   `--resume <id|path>` resume it, or exit 2 `session_not_found`
 *   `--continue`         the newest session for this cwd, or exit 2
 *
 * Returns `null` after writing the reason to stderr.
 */
function planSession(
  options: ExecOptions,
  cwd: string,
  err: NodeJS.WritableStream,
): SessionPlan | null {
  const saving = options.saveSession;
  if (options.resume !== undefined) {
    const path = resolveSessionRef(options.resume, cwd);
    const saved = path ? readSessionFile(path) : null;
    if (!path || !saved) {
      err.write(`session_not_found: no readable session for --resume "${options.resume}".\n`);
      return null;
    }
    // NOT `options.resume` AND NOT `meta.id` UNCHECKED (R-7). The flag accepts
    // `<id|path>`, so the value the caller typed is frequently a path, and
    // `meta.id` comes out of a file - neither is usable as a filename without
    // being checked. `resumedSessionId` is the one place that decision is made.
    return { id: resumedSessionId(path, saved), saved, saving, cwd };
  }
  if (options.continueSession) {
    const entry = latestSessionForCwd(cwd);
    const saved = entry ? readSessionFile(entry.path) : null;
    if (!entry || !saved) {
      err.write(`no_session_for_cwd: no previous aragon exec session for ${cwd}.\n`);
      return null;
    }
    return { id: resumedSessionId(entry.path, saved), saved, saving, cwd };
  }
  if (options.sessionId !== undefined) {
    // THE UPSERT. A wrapper that mints its own id must not have to ask whether
    // this is the first turn; that is the whole reason this form exists.
    return { id: options.sessionId, saved: readSessionFile(sessionPathFor(options.sessionId)), saving, cwd };
  }
  return { id: randomUUID(), saved: null, saving, cwd };
}

/**
 * Write the session, or leave the disk untouched.
 *
 * `entries: []` IS THE DECISION, NOT AN OMISSION (D-14 / P1-6). `Entry[]` is
 * produced by the renderer's reducer driven by `App.tsx`; `AgentController`
 * exposes `getMessages()` and no `getEntries()`, and the team / todo / fast /
 * retry entries arrive through separate dispatch paths inside the App.
 * Reconstructing a faithful transcript here means porting a meaningful slice of
 * the renderer into the headless path, for a payoff nobody asked for.
 *
 * The alternative was never "leave it undecided": `[]` PASSES `loadSession`'s
 * validation, so an implementer who skipped the work would ship a session that
 * resumes in the TUI with full model memory and a BLANK TRANSCRIPT, with no
 * error anywhere. Choosing that deliberately - and documenting it in the
 * README's Limits - is better than arriving at it by accident.
 */
function persist(
  plan: SessionPlan,
  controller: AgentController,
  turns: number,
  usage: { inputTokens: number; outputTokens: number },
  cli: string,
  at: number,
): void {
  const previous: SessionMeta | undefined = plan.saved?.meta;
  const config = controller.getConfig();
  const meta: SessionMeta = {
    id: plan.id,
    cwd: controller.getCwd(),
    createdAt: previous?.createdAt ?? at,
    updatedAt: at,
    // CUMULATIVE ACROSS INVOCATIONS. A wrapper budgeting a conversation cares
    // about the conversation, not about the process that happened to run one
    // turn of it.
    turns: (previous?.turns ?? 0) + turns,
    cli,
    provider: config.provider,
    model: config.model,
    usage: {
      inputTokens: (previous?.usage.inputTokens ?? 0) + usage.inputTokens,
      outputTokens: (previous?.usage.outputTokens ?? 0) + usage.outputTokens,
    },
  };
  try {
    writeSession({
      id: plan.id,
      session: {
        model: {
          providerId: config.provider,
          modelId: config.model,
          ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
        },
        messages: controller.getMessages(),
        entries: [],
        todos: controller.getTodoSnapshot?.()?.items ?? [],
      },
      meta,
    });
  } catch (e) {
    // A run that produced an answer must not be reported as a failure because
    // the home directory turned read-only. The caller still has the answer on
    // stdout; the next invocation will simply start fresh.
    process.stderr.write(
      `[session] could not save "${plan.id}": ${(e as Error).message}\n`,
    );
  }
}
