/**
 * One-shot / print mode (spec §3.7). No Ink: stream `text_delta` to stdout,
 * compact tool lines to stderr, then a usage footer. Exit-code correctness is
 * derived from the event stream (R2), not from the resolved promise:
 *   0 = success, 1 = agent error (incl. a silently-swallowed throw), 2 = config.
 */

import type { AgentEvent, ModelInfo, TokenUsage } from '@aragon-agent/core';
import { formatCost, formatTokens, formatDuration, computeCost } from './usage.js';
import { formatStreamError } from './reducer.js';
import type { PreflightResult } from './controller.js';
import type { TeamEvent } from '../team/types.js';
import type { TodoEvent, TodoSnapshot } from '../todo/types.js';
import type { FastEvent } from '../fast/types.js';
import type { CompactionEvent } from '../compaction/types.js';
import {
  advanceBudget,
  decideFollowThrough,
  emptyBudget,
  type FollowThroughMode,
} from '../todo/follow-through.js';

/** The minimal controller surface headless mode needs (real or stubbed). */
export interface HeadlessController {
  preflight(): PreflightResult;
  subscribe(listener: (event: AgentEvent) => void): () => void;
  prompt(text: string): Promise<void>;
  getModelInfo(): ModelInfo;
  /**
   * The CLI-local team stream — OPTIONAL, deliberately (team-subagents §3.12 /
   * P1-6).
   *
   * This interface is minimal so tests can satisfy it with an object literal.
   * Making the member REQUIRED would break every existing stub for no benefit,
   * and the subscription genuinely is optional: a controller with no team
   * runtime has no team events. `runHeadless` calls it with `?.`, which keeps
   * the `--no-team` headless path byte-identical to today's.
   */
  subscribeTeam?(listener: (event: TeamEvent) => void): () => void;
  /**
   * The CLI-local todo stream — OPTIONAL, for the identical reason
   * `subscribeTeam` is (todo-plan-execution §3.12). This interface is minimal so
   * tests can satisfy it with an object literal; making the member REQUIRED
   * would break every existing stub for no benefit, and a controller with no
   * store genuinely has no todo events. `runHeadless` calls it with `?.`, which
   * keeps a `--no-todo` headless run byte-identical to today's.
   */
  subscribeTodos?(listener: (event: TodoEvent) => void): () => void;
  /**
   * The CLI-local fast-tier stream — OPTIONAL, for the identical reason the two
   * above are (fast-model-tier §3.9). A controller with no tier has no fast
   * events, and `runHeadless` calls it with `?.`, which keeps a default `-p` run
   * byte-identical to today's.
   */
  subscribeFast?(listener: (event: FastEvent) => void): () => void;
  /**
   * The CLI-local compaction stream — OPTIONAL, for the identical reason the
   * three above are (context-auto-compaction §4.7). A controller with no
   * `ContextManager` has no compaction events, and `runHeadless` calls it with
   * `?.`, which keeps a `--no-compaction` headless run byte-identical to today's.
   */
  subscribeCompaction?(listener: (event: CompactionEvent) => void): () => void;
  /**
   * The current plan — OPTIONAL, for the identical reason the two subscriptions
   * above are (todo-plan-followthrough §3.6 rule 2). ABSENT MEANS THE
   * CONTINUATION LOOP NEVER RUNS, which is what keeps a stubbed controller's
   * stdout, stderr and exit code byte-identical to today's (AC-23).
   */
  getTodoSnapshot?(): TodoSnapshot | null;
}

export interface HeadlessOptions {
  quiet?: boolean;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  /**
   * Follow-through mode for `-p` (todo-plan-followthrough §3.6). Defaults to
   * `'notify'`, so an omitted option behaves exactly as the resolved default
   * config does.
   *
   * PASSED IN RATHER THAN READ OFF THE CONTROLLER, because `HeadlessController`
   * is deliberately the minimal surface a test can satisfy with an object
   * literal; `runOneShot` holds the real `AgentController` and reads
   * `getTodoConfig().followThrough` there.
   */
  followThrough?: FollowThroughMode;
}

/** Run a single prompt headlessly and resolve with the process exit code. */
export async function runHeadless(
  controller: HeadlessController,
  prompt: string,
  options: HeadlessOptions = {},
): Promise<number> {
  const out = options.stdout ?? process.stdout;
  const err = options.stderr ?? process.stderr;
  const quiet = options.quiet ?? false;

  const pre = controller.preflight();
  if (!pre.ok) {
    err.write(`${pre.message ?? 'Configuration error.'}\n`);
    return 2;
  }

  let errored = false;
  let sawTurnEnd = false;
  let wroteText = false;
  const total: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  /** Retries seen this run, so the recovery line can name a count. */
  let retryCount = 0;

  const unsubscribe = controller.subscribe((event: AgentEvent) => {
    switch (event.type) {
      case 'message_update': {
        const se = event.streamEvent;
        if (se.type === 'text_delta') {
          out.write(se.delta);
          wroteText = true;
        } else if (se.type === 'error') {
          errored = true;
          err.write(`\n${formatStreamError(se.error)}\n`);
        } else if (se.type === 'retry_scheduled') {
          // STDERR, NEVER STDOUT (llm-api-retry-backoff §6.7). stdout is the
          // machine-readable answer and has to stay parseable by
          // `aragon -p | jq`; a retry line on it would corrupt every consumer.
          // Not `--quiet`-gated, unlike the tool lines: a three-minute pause with
          // no explanation anywhere is not a "compact" run, it is a hang.
          retryCount = se.attempt;
          // The em dash is a literal because `agent/headless.ts` is the CLI's one
          // documented glyph-scanner exemption: `aragon -p` does no capability
          // probe, so there is no `Glyphs` set to read here.
          err.write(
            `\n[retry ${se.attempt}/${se.maxRetries}] ${se.errorType} — ` +
              `waiting ${Math.round(se.delayMs / 1000)}s\n`,
          );
        } else if (se.type === 'stream_restart') {
          // The partial answer already on stdout is about to be replayed. Saying so
          // is the only way a piped consumer can tell a duplicated paragraph from
          // a model that repeated itself.
          err.write(`[retry] discarding a partial response and restarting\n`);
        }
        break;
      }
      case 'tool_execution_start':
        if (!quiet) err.write(`\n▸ ${event.toolName}`);
        break;
      case 'tool_execution_end':
        if (!quiet) {
          err.write(` (${event.duration}ms)${event.isError ? ' [error]' : ''}\n`);
        }
        break;
      case 'turn_end':
        sawTurnEnd = true;
        if (retryCount > 0) {
          err.write(
            `[retry] recovered after ${retryCount} ${retryCount === 1 ? 'retry' : 'retries'}\n`,
          );
          retryCount = 0;
        }
        total.inputTokens += event.usage.inputTokens;
        total.outputTokens += event.usage.outputTokens;
        break;
      case 'agent_end':
        // A swallowed throw (missing key / empty stream) produces no turn_end.
        if (!sawTurnEnd && !errored) errored = true;
        break;
      default:
        break;
    }
  });

  // Team mode is ON in headless: a fan-out needs no human (§3.12). What the
  // children's spend must NOT do is vanish from the footer — the `[usage]` line
  // is the only cost readout `-p` has, and a dispatch is where most of the
  // tokens go.
  const started = new Set<string>();
  const finished = new Set<string>();
  const unsubscribeTeam = controller.subscribeTeam?.((event) => {
    if (event.type === 'usage') {
      total.inputTokens += event.usage.inputTokens;
      total.outputTokens += event.usage.outputTokens;
      return;
    }
    if (quiet) return;
    if (event.type === 'dispatch_start') {
      err.write(`\n[team] dispatch ${event.specs.length} subagents\n`);
      return;
    }
    if (event.type === 'agent_update') {
      const { run } = event;
      if (run.phase !== 'queued' && !started.has(run.label)) {
        started.add(run.label);
        err.write(`[team] ${run.label} start "${run.description}"\n`);
      }
      const terminal = run.phase === 'done' || run.phase === 'failed' || run.phase === 'aborted';
      if (terminal && !finished.has(run.label)) {
        finished.add(run.label);
        const ms = Math.max(0, (run.endedAt ?? 0) - (run.startedAt ?? 0));
        const verdict = run.phase === 'done' && !run.error ? 'ok' : run.phase;
        err.write(`[team] ${run.label} ${verdict} ${formatDuration(ms)} ${run.toolCalls} tools\n`);
      }
      return;
    }
    if (event.type === 'dispatch_end') {
      const ok = event.outcome.runs.filter((r) => r.phase === 'done' && !r.error).length;
      err.write(
        `[team] done ${ok}/${event.outcome.runs.length} ok` +
          `${event.outcome.aborted ? ' (aborted)' : ''}\n`,
      );
    }
  });

  // ONE LINE PER TRANSITION OF THE ACTIVE ITEM, not one per call: a model that
  // rewrites the list without moving the cursor produces no output at all.
  //
  // These lines are interleaved with the generic `> todo_write (1ms)` pairs
  // above, because that loop keys on the EVENT and not on the tool name (P2-2).
  // `SELF_RENDERING_TOOLS` is a TRANSCRIPT concept and teaching this writer
  // about it would put the same name in two places for a cosmetic gain on a
  // stream that is already `--quiet`-able in full.
  let announcedTotal = 0;
  let lastActive = -1;
  const unsubscribeTodos = controller.subscribeTodos?.((event) => {
    if (quiet || event.type !== 'updated') return;
    const { total, doneCount, activeIndex, items } = event.snapshot;
    if (total !== announcedTotal) {
      announcedTotal = total;
      err.write(`\n[todo] ${total} ${total === 1 ? 'step' : 'steps'} planned\n`);
      lastActive = -1;
    }
    if (activeIndex < 0) {
      if (lastActive !== -2) {
        lastActive = -2;
        err.write(`[todo] ${doneCount}/${total} done\n`);
      }
      return;
    }
    if (activeIndex === lastActive) return;
    lastActive = activeIndex;
    err.write(`[todo] ${activeIndex + 1}/${total} ${items[activeIndex]?.content ?? ''}\n`);
  });

  // Fast-tier review spend must reach the `[usage]` footer, or `-p` under-reports
  // by however much the reviewer consumed (§3.6).
  //
  // NOTHING IS WRITTEN TO STDOUT, AND NOTHING TO STDERR EITHER (D-12). stdout is
  // the answer channel and is piped into other tools; stderr in `-p` carries the
  // tool trace, and an unrequested second opinion is not a tool the user asked
  // for. The reviews are in the log records either way, which is where a `-p`
  // user goes to ask what happened.
  const unsubscribeFast = controller.subscribeFast?.((event) => {
    if (event.type !== 'usage') return;
    total.inputTokens += event.usage.inputTokens;
    total.outputTokens += event.usage.outputTokens;
  });

  // Context compaction (context-auto-compaction §4.7).
  //
  // TWO STDERR LINES, AND UNLIKE THE FAST TIER THEY ARE WRITTEN (D-12's
  // reasoning does not carry over). A review is an unrequested second opinion
  // that changes nothing; a compaction PERMANENTLY DROPS MESSAGES from the
  // conversation, and a `-p` run whose middle third vanished with no line
  // anywhere saying so is not a compact run, it is an unexplained one — the same
  // argument the retry lines above make for a three-minute pause.
  //
  // stderr, never stdout: stdout is the machine-readable answer and has to stay
  // parseable by `aragon -p | jq`. Not `--quiet`-gated, for the reason the retry
  // line is not.
  //
  // The summary text is NOT written (D-18): it can be tens of thousands of
  // characters, and no consumer of `-p` asked for it.
  const unsubscribeCompaction = controller.subscribeCompaction?.((event) => {
    if (event.type === 'usage') {
      total.inputTokens += event.usage.inputTokens;
      total.outputTokens += event.usage.outputTokens;
      return;
    }
    if (event.type !== 'compaction_end') return;
    const r = event.record;
    if (!r.applied) {
      err.write(`\n[compaction] skipped: ${r.reason ?? 'unknown'}\n`);
      return;
    }
    const secs = (r.durationMs / 1000).toFixed(1);
    const how =
      r.mode === 'truncated'
        ? ' WITHOUT a summary (summarize failed)'
        : r.mode === 'relieved'
        ? ' by clipping the retained turns (nothing could be dropped)'
        : '';
    err.write(
      `\n[compaction] ${formatTokens(r.tokensBefore)} -> ${formatTokens(r.tokensAfter)} tokens, ` +
        `${r.messagesBefore} -> ${r.messagesAfter} messages${how} (${secs}s)\n`,
    );
    // ONE MORE LINE, AND ONLY WHEN RELIEF FIRED (§4.5). A clip inside the turns
    // the run is about to continue from is a real data loss, and a `-p` run whose
    // recent tool output was silently shortened is an unexplained run - the same
    // argument the compaction lines above make for a vanished middle third.
    if (r.tailRelief) {
      err.write(
        `[compaction] clipped ${r.tailRelief.messages} tool ` +
          `${r.tailRelief.messages === 1 ? 'result' : 'results'} in the retained turns ` +
          `(${formatTokens(r.tailRelief.charsRemoved)} chars)\n`,
      );
    }
  });

  // --- The bounded continuation loop (todo-plan-followthrough §3.6). --------
  //
  // THE THREE `unsubscribe` CALLS STAY OUTSIDE IT (rule 4). The loop wraps the
  // whole `try/finally` rather than sitting inside it, because unsubscribing per
  // iteration would silently cost iteration 2 onwards its `[todo]` progress
  // lines, its team usage accounting and — worst — the `agent_end` handler that
  // computes `errored`, so a failing second iteration would exit 0.
  //
  // Deciding the moment `prompt()` resolves is safe: `agent.prompt()` awaits
  // `runLoopWithLifecycle()`, whose `finally` emits `agent_end` BEFORE resolving,
  // and `emit` is synchronous — so `errored` and `sawTurnEnd` are already final.
  const followThrough = options.followThrough ?? 'notify';
  let budget = emptyBudget();
  let wasAutoContinuation = false;
  try {
    let message = prompt;
    for (;;) {
      // PER-ITERATION RESET (rule 1). `sawTurnEnd` is the silent-failure
      // detector; left sticky, a swallowed throw on iteration 2 is invisible
      // because iteration 1 set the flag. `errored` is deliberately NOT reset —
      // once a run has errored the exit code is 1 and the loop must stop.
      sawTurnEnd = false;
      await controller.prompt(message);

      const snapshot = controller.getTodoSnapshot?.() ?? null;
      budget = advanceBudget(budget, snapshot, wasAutoContinuation);
      wasAutoContinuation = false;
      const decision = decideFollowThrough({
        mode: followThrough,
        snapshot,
        // `aborted` is STRUCTURALLY false here (C-2): `-p` has no Esc and
        // installs no signal handler that marks one, so there is nothing to
        // derive and nothing to plumb. An errored run takes the `notify` branch
        // below and ends the loop, which is what keeps exit code 1 reachable.
        runEnd: { aborted: false, errored },
        budget,
        interactive: false,
      });

      if (decision.kind === 'none') break;
      if (decision.kind === 'notify') {
        if (!quiet) err.write(`\n[todo] ${decision.text}\n`);
        break;
      }
      // CHARGED BEFORE THE RE-PROMPT, and this line is the whole of the headless
      // cap (P1-2 / I-5 / AC-37). The TUI charges `used` in its grace-timer
      // callback; headless has no timer, so without this `maxAutoContinuesPerList`
      // would never bind in the one environment with no human to press Esc.
      budget = { ...budget, used: budget.used + 1 };
      wasAutoContinuation = true;
      if (!quiet) err.write(`\n[todo] ${decision.notice}\n`);
      message = decision.message;
    }
  } finally {
    unsubscribe();
    unsubscribeTeam?.();
    unsubscribeTodos?.();
    unsubscribeFast?.();
    unsubscribeCompaction?.();
  }

  // Ensure a trailing newline so piped output is well-formed.
  if (wroteText) out.write('\n');

  if (!quiet) {
    const cost = computeCost(total, controller.getModelInfo().cost);
    err.write(
      `\n[usage] in ${formatTokens(total.inputTokens)} · out ${formatTokens(
        total.outputTokens,
      )} · ${formatCost(cost)}\n`,
    );
  }

  return errored ? 1 : 0;
}
