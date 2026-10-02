/**
 * The `/context` slash command (context-usage-gauge-accuracy §3.7 / W6).
 *
 * ASCII ONLY: `src/compaction/**` is inside the glyph scanner's scope, and this
 * text lands in a transcript `notice` - produced outside `src/ui/**`, where no
 * terminal capabilities are available, so it must be safe on a legacy `cmd.exe`.
 *
 * IT LIVES HERE RATHER THAN IN `builtins.ts` FOR THE REASON `/compact` DOES
 * (C-16 / P1-12): `CLAUDE.md` caps a source file at 1000 lines and `builtins.ts`
 * is already past it. `builtins.ts` gets the registration and nothing else.
 *
 * THIS IS THE GUARANTEED REPORTING SURFACE FOR OCCUPANCY. The status bar drops
 * readouts on a narrow terminal, the gauge is a bar and a rounded percentage,
 * and neither can say WHERE the denominator came from or WHAT the session total
 * includes. Every question a user asks after distrusting the bar is answered
 * here, at any width, in any mode - which is also why the honesty rules below
 * are not decoration.
 */

import type { CommandContext } from '../commands/registry.js';
import { formatCost, formatTokens, promptTokensOf } from '../agent/usage.js';
import type { ContextUsageSnapshot } from './types.js';

/**
 * `/context` - occupancy, denominator, freshness, compaction, session spend.
 *
 * THE OCCUPANCY COMES FROM `controller.getContextUsage()` AND NOWHERE ELSE
 * (RV-8). The obvious alternative, `getCompactionSnapshot().pressure`, returns
 * `offCompactionSnapshot()`'s HARDCODED ZERO pressure whenever compaction was
 * never registered - so a report built on it would read `0%` for exactly the
 * sessions this whole feature exists to fix. `/compact status` gets away with
 * reading it only because it returns early on that branch and never prints an
 * occupancy line at all.
 */
export function formatContextReport(ctx: CommandContext): string {
  const controller = ctx.controller;
  const usage = controller.getContextUsage();
  const lines: string[] = ['Context'];

  lines.push(`  Occupancy      ${occupancyLine(usage)}`);
  lines.push(`  Window         ${windowLine(usage)}`);
  lines.push(`  Since measured ${freshnessLine(usage)}`);
  lines.push(`  Compaction     ${compactionLine(ctx)}`);
  lines.push(`  Session spend  ${spendLine(ctx)}`);
  // THE SENTENCE THAT MAKES THE LINE ABOVE HONEST (D-7 / N-3). The session
  // total folds in subagents, the fast tier and compaction's own summarization
  // calls - three other models' tokens in a figure sitting next to the lead's
  // occupancy. Splitting it into four counters would need four units of
  // provenance argument for one line of output; SAYING what it contains costs
  // one line and answers the same question.
  lines.push('                 includes subagent, fast-tier and compaction spend,');
  lines.push('                 not just this conversation');

  return lines.join('\n');
}

/**
 * `43%   86.2k of 200k   [measured 85.1k + 1.1k estimated]`
 *
 * THE BREAKDOWN IS THE POINT. "43%" alone cannot be checked by a user who thinks
 * it is wrong; naming how much of it is a provider measurement and how much is
 * our own guess about messages appended since tells them whether to distrust the
 * number or the model.
 */
function occupancyLine(usage: ContextUsageSnapshot): string {
  const approximate = usage.source === 'estimate' || usage.deltaTokens > 0;
  const pct = `${approximate || !usage.windowKnown ? '~' : ''}${usage.pct}%`;
  const measured = Math.max(0, usage.occupied - usage.deltaTokens);
  const breakdown =
    usage.source === 'estimate'
      ? `[estimated ${formatTokens(usage.occupied)}]`
      : usage.deltaTokens > 0
      ? `[measured ${formatTokens(measured)} + ${formatTokens(usage.deltaTokens)} estimated]`
      : `[measured ${formatTokens(measured)}]`;
  return `${pct}   ${formatTokens(usage.occupied)} of ${formatTokens(usage.window)}   ${breakdown}`;
}

/**
 * Where the denominator came from. THREE SOURCES, ALL NAMED.
 *
 * THE PLACEHOLDER BRANCH IS THE ONE THAT MATTERS. `buildRuntimeModel` returns a
 * flat 128000 for any model the static table has never seen - a custom
 * `baseUrl`, a self-hosted id, a model released last week - and before this
 * command there was nothing that would admit the number was invented. A user
 * reading `128000` next to their 1M-token model concludes the gauge is broken;
 * they are right, and this line tells them which key fixes it.
 */
function windowLine(usage: ContextUsageSnapshot): string {
  if (usage.windowOverridden) {
    return `${usage.window}   from contextWindow in config.json (overrides the model table)`;
  }
  if (!usage.windowKnown) {
    return (
      `${usage.window}   PLACEHOLDER - this model is not in the table; ` +
      'set contextWindow to correct it'
    );
  }
  return `${usage.window}   from the model table`;
}

/**
 * How stale the measured half is.
 *
 * `deltaTokens` IS A TOKEN COUNT, NOT A MESSAGE COUNT, and this line says so in
 * tokens for that reason: the meter estimates the appended SLICE, and turning
 * that back into "4 messages" would be a second derivation of something nobody
 * recorded.
 */
function freshnessLine(usage: ContextUsageSnapshot): string {
  if (usage.source === 'estimate') {
    return 'no provider-reported usage yet - the whole figure is an estimate';
  }
  if (usage.deltaTokens <= 0) {
    return 'nothing appended since the last provider-reported usage';
  }
  return `${formatTokens(usage.deltaTokens)} estimated tokens appended since the last provider-reported usage`;
}

/**
 * The compaction state, IN FIVE FORMS (RV-8).
 *
 * A SINGLE FORM WOULD BE A LIE FOUR TIMES OUT OF FIVE. The obvious version of
 * this line - "on - triggers at 90% (amber at 75%)" - is printed unconditionally
 * only if you forget that compaction has four other observable states, and the
 * first of them is `aragon --no-compaction`, where that sentence promises a
 * rescue that cannot come. A report that exists to be trusted does not get to
 * have one branch.
 *
 * THE PREDICATES ARE THE ONES `formatCompactionStatus` ALREADY USES
 * (`compaction/command.ts`), not a second set: two ladders over the same three
 * booleans will eventually disagree, and the disagreement would be between two
 * commands the user runs precisely because they already distrust something.
 */
function compactionLine(ctx: CommandContext): string {
  const controller = ctx.controller;
  if (!controller.isCompactionRegistered()) {
    return 'off - not registered for this session (started with --no-compaction)';
  }

  const snapshot = controller.getCompactionSnapshot();
  if (snapshot.selfDisabled) {
    const reason = snapshot.selfDisabledReason ?? 'no progress';
    return `self-disabled (${reason}) - no compaction will run until /compact on`;
  }
  if (!controller.isCompactionEnabled()) {
    return 'off for this session - /compact on re-enables it';
  }

  const config = controller.getCompactionConfig();
  const thresholds =
    `triggers at ${Math.round(config.threshold * 100)}% ` +
    `(amber at ${Math.round(config.warnThreshold * 100)}%)`;
  if (!snapshot.live) {
    return `on, but no summarizer model resolves - ${thresholds}`;
  }
  const count = snapshot.compactions;
  return (
    `on - ${thresholds}, ${count} this session, ` +
    `${formatTokens(snapshot.tokensReclaimed)} reclaimed`
  );
}

/**
 * `1.24M in (incl. 940k cache read, 12k cache write) / 48.2k out, $3.21`
 *
 * THE CACHE PARENTHETICAL IS OMITTED WHEN BOTH TERMS ARE ZERO, which is every
 * direct connection - this CLI never sends `cache_control`, so the terms are
 * non-zero only behind a gateway that caches on the user's behalf. Those are
 * exactly the users for whom the pre-feature `^` under-reported (P1-3), and the
 * clause is how they can see that it no longer does.
 */
function spendLine(ctx: CommandContext): string {
  const total = ctx.state.usageTotal;
  const cached = total.cacheReadTokens + total.cacheWriteTokens;
  const parenthetical =
    cached > 0
      ? ` (incl. ${formatTokens(total.cacheReadTokens)} cache read, ` +
        `${formatTokens(total.cacheWriteTokens)} cache write)`
      : '';
  return (
    `${formatTokens(promptTokensOf(total))} in${parenthetical} / ` +
    `${formatTokens(total.outputTokens)} out, ${formatCost(total.costUsd)}`
  );
}

/** `/context` takes no arguments; anything after it is ignored. */
export function runContextCommand(ctx: CommandContext): void {
  ctx.notify('info', formatContextReport(ctx));
}
