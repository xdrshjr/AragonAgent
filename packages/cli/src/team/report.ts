/**
 * `buildDispatchReport` — the single text the lead receives back from `task`
 * (team-subagents §3.7).
 *
 * ASCII ONLY: `src/team/**` is inside the glyph scanner's scope.
 *
 * BUDGETS ARE IN BYTES, NOT CHARACTERS (D-8 / I-9). `ToolExecutor` truncates
 * combined tool text at 100 000 BYTES and appends `... [truncated]`; a 24 000
 * character CJK report is 72 000 bytes, so a character-denominated cap would let
 * the executor chop the report mid-section — and because the header is FIRST,
 * what it would chop off is the tail, but a report assembled the other way round
 * would lose its own failure count. Hence the second rule below.
 *
 * HEADER FIRST, ALWAYS. When the budget is exhausted the SUMMARIES are trimmed
 * (longest first, each to a floor, with an explicit `[trimmed]` marker); the
 * header, the per-agent status lines and the conflict warning are never dropped.
 * A report that loses its own failure count is worse than one that loses prose.
 *
 * A FAILED CHILD NEVER FAILS THE DISPATCH (D-14). Partial results are the normal
 * outcome of a fan-out; an all-or-nothing result would throw away four successes
 * because of one HTTP 429.
 */

import type { ModelCost } from '@aragon-agent/core';
import { computeCost, formatCost, formatDuration, formatTokens } from '../agent/usage.js';
import { TEAM_AGGREGATE_LABEL, TEAM_LIMITS } from './limits.js';
import type { DispatchOutcome, SubagentRun } from './types.js';

export interface ReportOptions {
  /** The lead's model cost table, so the header can state real spend (R-5).
   *
   * THE ONE TABLE, because every child runs the lead's own model
   * (main-agent parity): one tier, one price, one honest total. */
  cost?: ModelCost;
  /**
   * The FAST tier's cost table, so the supervisor's own spend line can
   * state real spend (subagent-overseer-v2 D-7 / R-P1-2). Supplied by
   * `TaskToolDeps.fastModelCost()`; ABSENT when the fast model is not
   * priced, in which case the spend line says `pricing unknown` rather
   * than `$0.00` - unknown pricing is not zero pricing (the C-11 / RV-4
   * rule the fast tier already follows everywhere else).
   */
  fastCost?: ModelCost;
}

/** The pseudo-label aggregate notices use; reserved at normalization. */
const SUPERVISOR_TEAM_LABEL = TEAM_AGGREGATE_LABEL;

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * Cut `text` to at most `maxBytes` WITHOUT splitting a UTF-8 sequence.
 *
 * Slicing the buffer blindly at a byte offset produces a replacement character
 * in the middle of a CJK report — the exact failure D-8 exists to prevent, just
 * one layer lower down.
 */
export function truncateBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (byteLength(text) <= maxBytes) return text;
  const buf = Buffer.from(text, 'utf8');
  let end = Math.min(maxBytes, buf.length);
  // A continuation byte is 0b10xxxxxx; back off until `end` starts a sequence.
  while (end > 0 && (buf[end] !== undefined) && (buf[end]! & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString('utf8');
}

/** `ok` / `aborted` / `failed: <reason>` — the bracketed badge on a section head. */
function statusBadge(run: SubagentRun): string {
  if (run.phase === 'aborted') return '[aborted]';
  if (run.phase === 'failed' || run.error) {
    return `[failed: ${run.error ?? 'run produced no output'}]`;
  }
  if (run.truncated) return '[stopped: turn cap reached]';
  return '[ok]';
}

function elapsed(run: SubagentRun): string {
  if (run.startedAt === undefined) return '0.0s';
  return formatDuration(Math.max(0, (run.endedAt ?? run.startedAt) - run.startedAt));
}

function isOk(run: SubagentRun): boolean {
  return run.phase === 'done' && !run.error;
}

/**
 * Files written by more than one child.
 *
 * PHRASED AS A WARNING, NEVER AS A FACT. `filesTouched` only sees `write_file` /
 * `edit_file`, so a child that writes through `bash` is invisible to it (R-2).
 * "review before trusting either" is honest about that; "these two conflict"
 * would not be.
 */
export function findFileConflicts(runs: SubagentRun[]): Array<{ path: string; labels: string[] }> {
  const owners = new Map<string, string[]>();
  for (const run of runs) {
    for (const path of run.filesTouched) {
      const list = owners.get(path) ?? [];
      if (!list.includes(run.label)) list.push(run.label);
      owners.set(path, list);
    }
  }
  const out: Array<{ path: string; labels: string[] }> = [];
  for (const [path, labels] of owners) {
    if (labels.length > 1) out.push({ path, labels });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

function buildHeader(outcome: DispatchOutcome, options: ReportOptions): string[] {
  const lines: string[] = [];
  const durationMs = Math.max(0, outcome.endedAt - outcome.startedAt);

  if (outcome.aborted) {
    // FIRST LINE on an abort, so the model cannot present partial work as
    // complete without having read past it.
    lines.push(`Team dispatch ABORTED after ${formatDuration(durationMs)}; partial results below.`);
  }

  const ok = outcome.runs.filter(isOk).length;
  const failed = outcome.runs.length - ok;
  const counts = `${ok} ok, ${failed} failed`;
  lines.push(
    outcome.requested > outcome.runs.length
      ? `Team dispatch: ran ${outcome.runs.length} of ${outcome.requested} requested subagents ` +
        `(${counts}) in ${formatDuration(durationMs)}.`
      : `Team dispatch: ${outcome.runs.length} of ${outcome.runs.length} subagents finished ` +
        `(${counts}) in ${formatDuration(durationMs)}.`,
  );

  lines.push(
    `Tokens: in ${formatTokens(outcome.usage.inputTokens)}, out ` +
      `${formatTokens(outcome.usage.outputTokens)}. Cost: ${formatCost(
        computeCost(outcome.usage, options.cost),
      )}.`,
  );

  for (const conflict of findFileConflicts(outcome.runs)) {
    const who = conflict.labels.map((l) => `"${l}"`).join(' and ');
    lines.push(
      `WARNING: agents ${who} both wrote ${conflict.path} - review before trusting either.`,
    );
  }
  return lines;
}

function buildSection(run: SubagentRun): { head: string[]; summary: string } {
  // `retried Nx` on the head line, which is never trimmed. 11 bytes, and it is
  // the only place the lead learns that a child's first attempt died before it
  // did anything (F-4).
  const retried = run.retries ? `, retried ${run.retries}x` : '';
  // Same head-line position as `retried Nx`, for the same reason: the ONLY
  // place the lead learns that a supervisor looked at this child (N times) or
  // rebuilt it (team-overseer §3.7).
  const overseen = run.interventions ? `, overseer ${run.interventions}` : '';
  const replaced = run.replacements ? `, replaced ${run.replacements}x` : '';
  // `compacted N` in the same position `retried Nx` uses, and for the same
  // reason (context-auto-compaction-hardening §3.4.4 / W3): this is the ONLY
  // place the lead learns that a child's own history was summarized mid-task, so
  // a summary that reads thinner than the turn count suggests has a stated cause
  // rather than an unexplained one. Absent when it never happened.
  const compacted = run.compactions ? `, compacted ${run.compactions}` : '';
  const head = [
    `### ${run.label} "${run.description}"  ${statusBadge(run)}  ${elapsed(run)}, ` +
      `${run.turns} turns, ${run.toolCalls} tools${retried}${compacted}${overseen}${replaced}`,
  ];
  if (run.filesTouched.length > 0) head.push(`files: ${run.filesTouched.join(', ')}`);
  // A child that tried to reach a teammate and could not is a child whose brief
  // had a dependency the lead should not have split (F-3). One line, in a
  // section that is trimmed last, and only when it actually happened.
  if (run.blockedWaits) head.push(`blocked waits: ${run.blockedWaits} (no teammate could answer)`);
  const summary = (run.summary ?? '').trim();
  return { head, summary: summary.length > 0 ? summary : '(no summary)' };
}

/**
 * The supervisor's ledger (team-overseer §3.7): one line per APPLIED decision,
 * so the lead can see who was nudged or replaced, when, and why. Budgeted by
 * the same `reportMaxBytes` ladder as everything else - it renders as a block,
 * so trimming it means trimming the blocks, which the ladder already does.
 *
 * subagent-overseer-v2 appends three aggregates, each AT MOST ONCE (D-7 /
 * D-10): the fast-tier spend line, a degraded-cadence note and a
 * went-quiet note. Aggregates, never per-tick rows: a degraded dispatch
 * ticks for hours and the report's job is the fact, not the log.
 */
function buildOverseer(outcome: DispatchOutcome, options: ReportOptions): string[] {
  const list = outcome.interventions ?? [];
  const calls = outcome.overseerCalls ?? 0;
  const degraded = outcome.overseerDegraded === true;
  // The pseudo-label aggregate (`team`) is a note, not a child's ledger row.
  const quietChildren = list.filter(
    (item) => item.trigger === 'quiet' && item.label !== SUPERVISOR_TEAM_LABEL,
  ).length;
  if (list.length === 0 && calls === 0 && !degraded) return [];
  const lines = ['### Supervisor'];
  for (const item of list) {
    const at = Math.max(0, Math.round((item.at - outcome.startedAt) / 1000));
    lines.push(
      `[${item.trigger} ${at}s] ${item.label}: ${item.action} - ${item.reason}`,
    );
  }
  // Honest accounting (D-7): rendered only when calls were actually made,
  // priced at the FAST table, `pricing unknown` when that table is absent.
  if (calls > 0 && outcome.overseerUsage !== undefined) {
    const price = options.fastCost
      ? formatCost(computeCost(outcome.overseerUsage, options.fastCost))
      : 'pricing unknown';
    lines.push(
      `supervisor: ${calls} call${calls === 1 ? '' : 's'}, ${formatTokens(
        outcome.overseerUsage.inputTokens,
      )} in / ${formatTokens(outcome.overseerUsage.outputTokens)} out tokens` +
        ` (fast tier), ${price}.`,
    );
  }
  if (degraded) {
    lines.push(
      `note: the fast tier was unavailable for ${outcome.overseerDegradedTicks ?? 1}` +
        ` cadence check(s); children waited unassisted and none were killed.`,
    );
  }
  if (quietChildren > 0) {
    lines.push(
      `note: supervision went quiet on ${quietChildren}` +
        ` child${quietChildren === 1 ? '' : 'ren'} after its look budget.`,
    );
  }
  return lines;
}

function buildLeadMail(outcome: DispatchOutcome): string[] {
  if (outcome.leadMail.length === 0) return [];
  const lines = ['### Messages to you'];
  for (const m of outcome.leadMail) {
    const at = Math.max(0, Math.round((m.at - outcome.startedAt) / 1000));
    lines.push(`[${m.from} -> lead] "${m.subject}" (${at}s in)`);
    if (m.body.length > 0) lines.push(m.body);
  }
  return lines;
}

/**
 * Assemble the report.
 *
 * Trimming order: every summary starts clamped to `summaryMaxBytes`; if the
 * whole document is still over `reportMaxBytes`, the LONGEST summary is halved
 * repeatedly (never below `summaryFloorBytes`) until it fits or every summary is
 * at the floor. Only then, as a last resort, are summaries dropped entirely —
 * and even then the status lines survive, because they carry the failure count.
 */
export function buildDispatchReport(
  outcome: DispatchOutcome,
  options: ReportOptions = {},
): string {
  const header = buildHeader(outcome, options);
  const sections = outcome.runs.map(buildSection);
  const mail = buildLeadMail(outcome);
  const overseer = buildOverseer(outcome, options);

  const summaries = sections.map((s) => truncateBytes(s.summary, TEAM_LIMITS.summaryMaxBytes));
  const trimmed = summaries.map((s, i) => s.length < sections[i]!.summary.length);

  const render = (bodies: (string | null)[]): string => {
    const blocks: string[] = [header.join('\n')];
    sections.forEach((section, i) => {
      const body = bodies[i];
      const lines = [...section.head];
      if (body !== null && body !== undefined) {
        lines.push(trimmed[i] ? `${body}\n[trimmed]` : body);
      }
      blocks.push(lines.join('\n'));
    });
    if (overseer.length > 0) blocks.push(overseer.join('\n'));
    if (mail.length > 0) blocks.push(mail.join('\n'));
    return blocks.join('\n\n');
  };

  let bodies: (string | null)[] = [...summaries];
  let out = render(bodies);
  let guard = 0;
  while (byteLength(out) > TEAM_LIMITS.reportMaxBytes && guard < 200) {
    guard += 1;
    let longest = -1;
    let longestBytes: number = TEAM_LIMITS.summaryFloorBytes;
    bodies.forEach((body, i) => {
      if (body === null) return;
      const size = byteLength(body);
      if (size > longestBytes) {
        longest = i;
        longestBytes = size;
      }
    });
    if (longest < 0) break; // Every summary is at the floor.
    const next = Math.max(TEAM_LIMITS.summaryFloorBytes, Math.floor(longestBytes / 2));
    bodies[longest] = truncateBytes(bodies[longest]!, next);
    trimmed[longest] = true;
    out = render(bodies);
  }

  if (byteLength(out) > TEAM_LIMITS.reportMaxBytes) {
    // Last resort. The header, the status lines and the conflict warning are
    // still here, which is the whole point of assembling them separately.
    bodies = bodies.map(() => null);
    out = render(bodies);
  }
  return out;
}
