/**
 * `job_wait` and `job_list`, plus the notice tail every tool result carries
 * (long-task-jobs §4.4.2 / §4.4.3 / §4.6).
 *
 * ASCII ONLY: `src/tools/**` is inside the glyph scanner's scope.
 *
 * WHY TWO NEW TOOLS RATHER THAN A `block` PARAMETER ON `bash_output` (D-10):
 * the tool list IS the discoverable capability surface. A model that can SEE
 * `job_wait` knows that waiting is a legal step in a plan; a hidden `block: 30`
 * parameter is a feature it will never use, and extending `bash_output`'s output
 * would also rewrite assertions that pin its current grammar word for word.
 *
 * EVERY RESULT IS A FIXED GRAMMAR OF AT MOST TWELVE LINES. That is not tidiness:
 * the entire economic argument for this feature is that one wait costs ~150
 * tokens instead of a 200-row tail, so an unbounded result would delete the
 * reason the feature exists.
 */

import { defineTool, errorResult, textResult, type AgentTool, type ToolResult } from '@aragon-agent/core';
import { formatDuration } from '../agent/usage.js';
import { JOB_WAIT_MARGIN_MS, PROC_LIMITS } from '../proc/limits.js';
import { renderJobNotices, type JobNotice } from '../proc/notices.js';
import { isTerminalStatus } from '../proc/types.js';
import type {
  JobKind,
  ProcSupervisorPort,
  ServiceLogPage,
  ServiceSnapshot,
  ServiceStatus,
} from '../proc/types.js';
import { waitForJob } from '../proc/wait.js';

export interface JobToolDeps {
  supervisor: ProcSupervisorPort;
  /** `cfg.jobs.waitSeconds`, read LIVE (same rule as `startupSettleMs`). */
  waitSeconds: () => number;
  /** `cfg.jobs.stallSeconds`, read LIVE; only the `[stalled]` sentence uses it. */
  stallSeconds: () => number;
  /** `cfg.toolTimeoutMs`, read LIVE: I-4's second convergence. */
  toolTimeoutMs: () => number;
  /** `PROC_LIMITS.maxConsecutiveWaits`. */
  maxConsecutiveWaits: number;
  /**
   * The terminal record for an id this session has already reported and then
   * lost to `evictTerminal()` (RV-P2-7).
   *
   * WITHOUT IT "reclaimed" and "never existed" are the same message, and a model
   * told `No job "t9"` about a 40-minute training run that finished successfully
   * will start it again.
   */
  terminalRecord?: (id: string) => { kind: JobKind; status: ServiceStatus } | undefined;
}

/** Per-job wait memory: the text last reported, the last carry, and the silence. */
interface WaitMemory {
  lastProgress?: string;
  /**
   * The carry line as it was when this job was last reported.
   *
   * A `\r`-rewritten progress bar completes no rows, so `LogRing.page()` hands it
   * back as the last element of `rows` on EVERY wait. Without this memory the same
   * line is reprinted each time it is identical, and - worse - it counts as "new
   * output", which resets the spin guard so a genuinely stalled job never earns
   * its `[guard]` line (RV-P1-5).
   */
  lastCarry?: string;
  noChange: number;
}

/**
 * Split a page into "completed rows" and "the carry line".
 *
 * THE PAGE NAMES ITS CARRY: `LogRingPage.carryRow` is the not-yet-terminated line,
 * and `rows` ends with it when it is non-empty. A page from a caller that does not
 * provide it (a test double, `bash_output`) is treated as all-completed, which
 * keeps this a pure refinement rather than a new requirement.
 */
function splitCarry(page: ServiceLogPage | undefined): {
  rows: readonly string[];
  carry: string;
} {
  const rows = page?.rows ?? [];
  const carry = page?.carryRow ?? '';
  if (carry.length === 0) return { rows, carry };
  const last = rows[rows.length - 1];
  return last === carry ? { rows: rows.slice(0, -1), carry } : { rows, carry };
}

/**
 * Clamp `timeoutSeconds` into `[jobs.waitSeconds, 60]` and then into the tool
 * ceiling (I-4).
 *
 * TWO CONVERGENCES, BOTH REQUIRED. The first honours `WAIT_SECONDS_RANGE`; the
 * second is what makes it impossible for a wait to outlive the tool that is
 * hosting it, which is the difference between "a bounded wait" and "another
 * `Command timed out after 180000ms`".
 */
function clampWaitSeconds(deps: JobToolDeps, requested: number | undefined): number {
  const configured = deps.waitSeconds();
  const asked =
    requested === undefined || !Number.isFinite(requested) || requested < PROC_LIMITS.waitMinSeconds
      ? configured
      : requested;
  const bounded = Math.max(
    PROC_LIMITS.waitMinSeconds,
    Math.min(Math.floor(asked), PROC_LIMITS.waitMaxSeconds),
  );
  const ceiling = Math.floor((deps.toolTimeoutMs() - JOB_WAIT_MARGIN_MS) / 1000);
  // `Math.max(1, ...)` rather than `Math.max(waitMinSeconds, ...)`: when an
  // operator sets a tool ceiling below the margin, "the wait fits inside the
  // ceiling" is the invariant that must win. Nothing here ever silently produces
  // a wait longer than the tool call that hosts it.
  return Math.max(1, Math.min(bounded, ceiling));
}

/** `JOB t3  task  running  12m34s` - the one header grammar for every outcome. */
function headerLine(job: ServiceSnapshot, nowMs: number): string {
  const elapsed = formatDuration((job.endedAt ?? nowMs) - job.startedAt);
  const code =
    job.exitCode !== null
      ? ` code ${job.exitCode}`
      : job.signal !== null
        ? ` signal ${job.signal}`
        : '';
  return `JOB ${job.id}  ${job.kind}  ${job.status}${code}  ${elapsed}`;
}

/** `[stalled] ...` - only for a live job whose silence passed the threshold. */
function stalledLine(job: ServiceSnapshot, nowMs: number, stallSeconds: number): string | undefined {
  // A FINISHED JOB CANNOT BE STALLED. `snapshot()` derives the flag only for a
  // live job, so this guard is about the OTHER direction: a snapshot captured
  // while the job was quiet and delivered after it ended must not claim silence.
  if (job.stalled !== true || isTerminalStatus(job.status)) return undefined;
  const quiet = formatDuration(Math.max(0, nowMs - job.lastOutputAt));
  return (
    `[stalled] no output for ${quiet} (threshold ${stallSeconds}s). Keep waiting, ` +
    `stop it with bash_kill({ job: "${job.id}" }), or read the tail with bash_output.`
  );
}

/**
 * Assemble one job's block.
 *
 * THE ROW BLOCK IS THE ONLY ELASTIC PART, and it shrinks first when the fixed
 * lines grow - which is how "at most twelve lines" survives a job that is both
 * stalled and truncated without either sentence being dropped.
 */
function renderJobBlock(args: {
  job: ServiceSnapshot;
  rows: readonly string[];
  cursor: number;
  since: number | undefined;
  nowMs: number;
  stalledSeconds: number;
  waitSeconds: number;
  progressUnchanged: boolean;
  truncatedNote: string | undefined;
}): string[] {
  const { job, rows, cursor, since, nowMs } = args;
  const terminal = isTerminalStatus(job.status);
  const fixed: string[] = [headerLine(job, nowMs)];

  const progress = job.progress?.text;
  if (progress !== undefined) {
    fixed.push(`[progress] ${progress}${args.progressUnchanged ? ' (unchanged)' : ''}`);
  }
  const stalled = stalledLine(job, nowMs, args.stalledSeconds);
  if (stalled !== undefined) fixed.push(stalled);
  if (args.truncatedNote !== undefined) fixed.push(args.truncatedNote);

  const tail: string[] = [`[cursor ${cursor}]`];
  if (terminal) {
    tail.push(
      `[done] the job finished. Read more with bash_output({ service: "${job.id}" }) if you need it.`,
    );
  } else {
    const quiet = formatDuration(Math.max(0, nowMs - job.lastOutputAt));
    tail.push(`[wait ${args.waitSeconds}s] still running. No output for ${quiet}.`);
    tail.push(
      `[next] job_wait({ job: "${job.id}", since: ${cursor} }) to keep waiting, ` +
        'or continue with other work.',
    );
  }

  // TWELVE LINES, AND THE ROW BLOCK IS THE ONLY ELASTIC PART. Its header costs a
  // line of its own, so the budget is computed with it already deducted; a stalled
  // or truncated job therefore loses output rows rather than the sentence that
  // says what is wrong.
  const rowLineHint = rows.length > 0 ? 1 : 0;
  const budget = Math.max(0, 12 - fixed.length - tail.length - rowLineHint);
  const shown = rows.slice(-Math.min(PROC_LIMITS.waitTailRows, budget));
  const sinceClause = since === undefined ? '' : ` since ${since}`;
  return [
    ...fixed,
    ...(shown.length > 0 ? [`[... ${shown.length} row(s)${sinceClause} ...]`] : []),
    ...shown.map((row) => `  ${row}`),
    ...tail,
  ];
}

/** The three-state "no such id" answer (RV-P2-7). */
function unknownJobMessage(deps: JobToolDeps, requested: string): ToolResult {
  // RECLAIMED FIRST, AND THAT ORDER IS THE POINT (RV-P2-7). State two is the one
  // that costs money if it is missed: a model told `No job "t9"` about a
  // forty-minute training run that FINISHED will start it again. The live-id list
  // is only useful once we know the id never named a job this session.
  const reclaimed = deps.terminalRecord?.(requested);
  if (reclaimed) {
    return errorResult(
      `Job "${requested}" already finished (${reclaimed.kind} ${reclaimed.status}) and was ` +
        'reclaimed; its outcome was delivered in a <job_notices> block. Do not re-run it.',
    );
  }
  const live = deps.supervisor
    .list()
    .filter((job) => !isTerminalStatus(job.status))
    .slice(0, PROC_LIMITS.listRows)
    .map((job) => `${job.id} (${job.status} ${formatDuration(Date.now() - job.startedAt)})`);
  if (live.length > 0) {
    return errorResult(
      `No job "${requested}". Live: ${live.join(', ')}. ` +
        'Call job_list for detail.',
    );
  }
  return errorResult(
    `No job "${requested}". Start one with bash({ command, background: true }).`,
  );
}

function isLive(job: ServiceSnapshot): boolean {
  return !isTerminalStatus(job.status);
}

export function makeJobWait(deps: JobToolDeps): AgentTool {
  const memory = new Map<string, WaitMemory>();

  return defineTool({
    name: 'job_wait',
    label: 'Wait for job',
    description:
      'Wait a bounded time for a background job (service or task) and return its ' +
      'status, one line of progress, and only the output since `since`. Returns ' +
      'immediately when the job is already finished. Waiting is bounded (5-60s), ' +
      'so call it again only after deciding what to do.',
    parameters: {
      type: 'object',
      properties: {
        job: { type: 'string', description: '"t3", "s1", or "all".' },
        timeoutSeconds: {
          type: 'number',
          description: '5-60. Omit for the configured default.',
        },
        since: {
          type: 'number',
          description: 'Cursor from a previous call; omit for the smallest useful window.',
        },
      },
      required: ['job'],
    },
    async execute(_id, rawParams, ctx) {
      const params = rawParams as { job: string; timeoutSeconds?: number; since?: number };
      const requested = String(params.job);
      const targets =
        requested === 'all'
          ? deps.supervisor.list().filter(isLive).map((job) => job.id)
          : [requested];

      if (requested !== 'all' && !deps.supervisor.get(requested)) {
        return unknownJobMessage(deps, requested);
      }
      if (targets.length === 0) {
        return textResult(
          'No background jobs are running. Start one with ' +
            'bash({ command, background: true }).',
        );
      }

      const waitSeconds = clampWaitSeconds(deps, params.timeoutSeconds);
      const outcome = await waitForJob(deps.supervisor, {
        targets,
        timeoutMs: waitSeconds * 1000,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        ...(params.since !== undefined ? { since: params.since } : {}),
      });
      if (outcome.aborted) {
        return errorResult(
          `The wait on ${targets.join(', ')} was aborted after ` +
            `${formatDuration(outcome.waitedMs)}. The job was not stopped; ` +
            'call job_wait again when you want to keep waiting.',
        );
      }

      const nowMs = Date.now();
      const stallSeconds = deps.stallSeconds();
      const blocks: string[][] = [];
      for (const job of outcome.jobs) {
        const page = outcome.pages.get(job.id);
        // THE CARRY LINE IS NOT AN INCREMENT WHEN IT HAS NOT MOVED (RV-P1-5). A
        // carriage-return-rewritten progress bar completes no rows, so the ring
        // hands the same line back on every wait: reprinting it would spend the
        // six-row budget on one unchanging sentence, and counting it as new output
        // would reset the spin guard so a genuinely stalled job never earns its
        // `[guard]` line. It still reports through `[progress] (unchanged)`.
        const { rows: rowsNew, carry } = splitCarry(page);
        const carryUnchanged = carry.length > 0 && carry === memory.get(job.id)?.lastCarry;
        const carryMoved = carry.length > 0 && !carryUnchanged;
        const shownRows = carryMoved ? [...rowsNew, carry] : rowsNew;
        const memoryForJob = memory.get(job.id) ?? { noChange: 0 };
        const previous = memoryForJob.lastProgress;
        const current = job.progress?.text;
        // TWO DIFFERENT QUESTIONS, deliberately kept apart:
        //  - `progressUnchanged` is a RENDERING decision (print `(unchanged)`);
        //  - `advanced` is the SPIN-GUARD decision, and the first wait of a job is
        //    always "advanced" because it establishes the baseline. Counting it
        //    otherwise would put the guard line on the sixth wait instead of the
        //    seventh (AC-20).
        const hasBaseline = previous !== undefined;
        const progressUnchanged = hasBaseline && current === previous;
        const newRows = shownRows.length;
        const advanced = !hasBaseline || newRows > 0 || !progressUnchanged;
        memoryForJob.noChange = advanced ? 0 : memoryForJob.noChange + 1;
        if (current !== undefined) memoryForJob.lastProgress = current;
        if (carry.length > 0) memoryForJob.lastCarry = carry;
        memory.set(job.id, memoryForJob);

        // THE SPIN GUARD (R-3): counted per job, reset by ANY change. It never
        // refuses the wait; it prepends one line naming four ways out.
        const guard =
          memoryForJob.noChange >= deps.maxConsecutiveWaits
            ? [
                `[guard] ${memoryForJob.noChange} waits with no change. This job may be stalled. ` +
                  'Options: keep waiting, stop it (bash_kill), read the tail (bash_output), or ask the user.',
              ]
            : [];

        blocks.push([
          ...guard,
          ...renderJobBlock({
            job,
            rows: shownRows,
            cursor: page?.cursor ?? job.rowsSeen,
            since: params.since,
            nowMs,
            stalledSeconds: stallSeconds,
            waitSeconds,
            progressUnchanged,
            truncatedNote:
              page?.truncated === true
                ? '[note] older rows were dropped - the tail keeps the last ' +
                  `${PROC_LIMITS.serviceTailRows} rows` +
                  (job.logPath ? `. Full log: ${job.logPath}` : '.')
                : undefined,
          }),
        ]);
      }

      const shown = blocks.slice(0, PROC_LIMITS.listRows);
      const lines = shown.flat();
      if (blocks.length > shown.length) {
        lines.push(`[... ${blocks.length - shown.length} more job(s): job_list ...]`);
      }
      return textResult(lines.join('\n'));
    },
  });
}

export function makeJobList(deps: JobToolDeps): AgentTool {
  return defineTool({
    name: 'job_list',
    label: 'List jobs',
    description:
      'One line per background job: id, kind, status, elapsed, progress. Use it ' +
      'when you need the id you started.',
    parameters: { type: 'object', properties: {} },
    async execute() {
      const jobs = deps.supervisor.list();
      if (jobs.length === 0) {
        return textResult(
          'No background jobs. Start one with bash({ command, background: true }).',
        );
      }
      const nowMs = Date.now();
      // LIVE FIRST, then by start time - the same trade `selectPanelRows` makes
      // for the team panel: what is running is what the reader wants.
      const ordered = [...jobs].sort((a, b) => {
        const liveDelta = Number(isLive(b)) - Number(isLive(a));
        return liveDelta !== 0 ? liveDelta : a.startedAt - b.startedAt;
      });
      const rows = ordered.slice(0, PROC_LIMITS.listRows).map((job) => oneRow(job, nowMs));
      const liveCount = jobs.filter(isLive).length;
      const serviceCount = jobs.filter((job) => job.kind === 'service').length;
      const taskCount = jobs.length - serviceCount;
      const summary =
        `${liveCount} live of ${jobs.length} (${taskCount} task, ${serviceCount} service). ` +
        'Wait: job_wait({ job: "<id>" }). Full tail: bash_output({ service: "<id>", since: <cursor> }).';
      if (ordered.length > rows.length) rows.push(`[+${ordered.length - rows.length} more]`);
      return textResult([...rows, summary].join('\n'));
    },
  });
}

/** `t3  task  running  12m34s  47%` - one line, fixed column count. */
function oneRow(job: ServiceSnapshot, nowMs: number): string {
  const elapsed = formatDuration((job.endedAt ?? nowMs) - job.startedAt);
  const aside = job.progress?.text ?? job.url ?? '';
  return `${job.id}  ${job.kind}  ${job.status}  ${elapsed}${aside ? `  ${aside}` : ''}`;
}

/**
 * Append pending `<job_notices>` to every tool result (the PULL channel).
 *
 * SAME SHAPE AS `withMailboxTail`, AND FOR THE SAME REASON: the engine is told
 * nothing, the wrapper rides `{...tool, execute}`, and the notice is delivered on
 * the next tool call whatever that call is. The queue is drained EVEN WHEN the
 * wrapped tool errored - a refused `bash` is still a delivery opportunity.
 */
export function withJobNoticeTail(tool: AgentTool, drain: () => JobNotice[]): AgentTool {
  const original = tool.execute;
  return {
    ...tool,
    async execute(id, params, ctx): Promise<ToolResult> {
      const result = await original(id, params, ctx);
      const block = renderJobNotices(drain());
      if (block.length === 0) return result;
      return { ...result, content: [...result.content, { type: 'text', text: block }] };
    },
  };
}
