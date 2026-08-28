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
import { TEAM_LIMITS } from './limits.js';
import type { DispatchOutcome, SubagentRun } from './types.js';

export interface ReportOptions {
  /** The lead's model cost table, so the header can state real spend (R-5). */
  cost?: ModelCost;
  /**
   * The FAST model's cost table (fast-model-tier §3.4 / R-7).
   *
   * A SECOND TABLE, not a second number derived from the first. Summing
   * fast-tier tokens at the lead's price over-reports a Haiku child under a
   * Sonnet lead by roughly an order of magnitude, and the whole justification
   * for delegating to a cheaper model is the figure on this line.
   */
  fastCost?: ModelCost;
  /**
   * The static price table has never heard of the fast model (C-11 / RV-4).
   *
   * UNKNOWN PRICING IS NOT ZERO PRICING. `buildRuntimeModel` hands back
   * `cost: { input: 0, output: 0 }` for an unrecognised id, and the fast tier is
   * precisely where an unrecognised id is LIKELY — so rendering it as `$0.00`
   * would make the feature look free while it is spending money.
   */
  fastPricingUnknown?: boolean;
}

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

  // A SECOND LINE, NOT A COMBINED TOTAL (fast-model-tier §3.4). Two tiers with
  // two price tables have two answers, and folding them into one figure is the
  // misattribution R-7 is about. Present only when a fast child actually ran, so
  // an ordinary dispatch's header is byte-identical.
  const fastUsage = outcome.fastUsage;
  if (fastUsage) {
    // `unknown` rather than a currency amount when the model has no price table
    // (RV-4): a lower bound rendered as a total is the same class of lie as
    // pricing a Haiku child at Sonnet rates.
    const fastCostLabel = options.fastPricingUnknown
      ? 'unknown (no price table)'
      : formatCost(computeCost(fastUsage, options.fastCost));
    lines.push(
      `Fast tier: in ${formatTokens(fastUsage.inputTokens)}, out ` +
        `${formatTokens(fastUsage.outputTokens)}. Cost: ${fastCostLabel}.`,
    );
  }

  // THE LINE THAT KEEPS A DOWNGRADE FROM BEING SILENT (R-6). Without it the
  // model asked for a cheap child, got an expensive one, and has no way to learn
  // that its cost model is wrong.
  if (outcome.downgraded && outcome.downgraded > 0) {
    const n = outcome.downgraded;
    lines.push(
      `${n} ${n === 1 ? 'subagent' : 'subagents'} ran on the main model (fast tier off).`,
    );
  }

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
  // `[fast]` after the LABEL, on the head line, which is never trimmed. Six
  // bytes, and it is the only place the lead learns which of its children were
  // cheap — the fact the whole second cost line is about.
  const tier = run.tier === 'fast' ? ' [fast]' : '';
  // `compacted N` in the same position `retried Nx` uses, and for the same
  // reason (context-auto-compaction-hardening §3.4.4 / W3): this is the ONLY
  // place the lead learns that a child's own history was summarized mid-task, so
  // a summary that reads thinner than the turn count suggests has a stated cause
  // rather than an unexplained one. Absent when it never happened.
  const compacted = run.compactions ? `, compacted ${run.compactions}` : '';
  const head = [
    `### ${run.label}${tier} "${run.description}"  ${statusBadge(run)}  ${elapsed(run)}, ` +
      `${run.turns} turns, ${run.toolCalls} tools${retried}${compacted}`,
  ];
  if (run.filesTouched.length > 0) head.push(`files: ${run.filesTouched.join(', ')}`);
  // A child that tried to reach a teammate and could not is a child whose brief
  // had a dependency the lead should not have split (F-3). One line, in a
  // section that is trimmed last, and only when it actually happened.
  if (run.blockedWaits) head.push(`blocked waits: ${run.blockedWaits} (no teammate could answer)`);
  const summary = (run.summary ?? '').trim();
  return { head, summary: summary.length > 0 ? summary : '(no summary)' };
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
