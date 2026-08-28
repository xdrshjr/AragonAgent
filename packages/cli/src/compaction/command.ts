/**
 * The `/compact` slash command and its status report
 * (context-auto-compaction §4.4).
 *
 * ASCII ONLY: `src/compaction/**` is inside the glyph scanner's scope, and this
 * text lands in a transcript `notice` — produced outside `src/ui/**`, where no
 * terminal capabilities are available, so it must be safe on a legacy `cmd.exe`.
 *
 * IT LIVES HERE RATHER THAN IN `builtins.ts`, AND THAT IS A BUDGET DECISION
 * RATHER THAN TASTE (C-16 / P1-12). `CLAUDE.md` caps a source file at 1000 lines,
 * `builtins.ts` is already past it, and `/compact` has eight forms plus the
 * longest status report in the package. `builtins.ts` gets the registration and nothing
 * else — the same split `controller.ts` argues for `FastWiring`, one layer out.
 */

import type { CommandContext } from '../commands/registry.js';
import type { PersistedConfig } from '../config/schema.js';
import { parseThresholdInput } from '../config/schema.js';
import { formatCost, formatTokens } from '../agent/usage.js';
import { computeCost } from '../agent/usage.js';
import { COMPACTION_LIMITS } from './limits.js';
import { findArchive, listArchives, type ArchiveEntry } from './archive.js';

/**
 * `/compact status` — THE GUARANTEED REPORTING SURFACE (§6.5 / AC-17).
 *
 * The chip drops on a narrow terminal, the activity row is suppressed under an
 * overlay, and the card scrolls away. This command answers every question about
 * the feature's state at any width, in any mode, including after the fact.
 *
 * IT READS THE SAME NUMBERS THE STATUS BAR DOES, through one `occupiedTokens`
 * (§3.4.1 / R-11): a user watching 78 % on the bar who is told 91 % here would
 * conclude one of the two is lying, and they would be right.
 *
 * `unknown (no price table for <model>)` RATHER THAN A CURRENCY AMOUNT when the
 * static table has never seen the summarizer (the C-11 / RV-4 lesson from the
 * fast tier). `$0.00` on a feature that is spending money is the same class of
 * lie as pricing a Haiku child at Sonnet rates — and it matters MORE here,
 * because the DEFAULT summarizer is the session's own frontier model.
 */
export function formatCompactionStatus(ctx: CommandContext): string {
  const controller = ctx.controller;
  const snapshot = controller.getCompactionSnapshot();
  const config = controller.getCompactionConfig();
  const lines: string[] = [];

  if (!controller.isCompactionRegistered()) {
    lines.push('Auto-compaction: not registered for this session (started with --no-compaction).');
    lines.push(`  Saved setting: compaction.enabled = ${config.enabled}`);
    lines.push('  A full context window will end the run, as it did before this feature existed.');
    return lines.join('\n');
  }

  const state = snapshot.selfDisabled
    ? `self-disabled (${snapshot.selfDisabledReason ?? 'no progress'})`
    : controller.isCompactionEnabled()
    ? snapshot.live
      ? 'on'
      : 'on, but no summarizer model resolves'
    : 'off for this session';
  lines.push(`Auto-compaction: ${state}`);

  const p = snapshot.pressure;
  const pct = Math.round(p.ratio * 100);
  const approx = p.source === 'estimate' || !p.windowKnown ? '~' : '';
  lines.push(
    `  Occupancy: ${approx}${pct}% (${formatTokens(p.occupied)} of ` +
      `${formatTokens(p.contextWindow)}${p.windowKnown ? '' : ', window unknown'}) ` +
      `[${p.source === 'usage' ? 'measured' : 'estimated'}]`,
  );
  lines.push(
    `  Triggers at: ${Math.round(config.threshold * 100)}% ` +
      `(amber at ${Math.round(config.warnThreshold * 100)}%), ` +
      `or when headroom drops below one full response`,
  );
  lines.push(`  Keeps: the original task + ${config.keepRecentTurns} recent turns, verbatim`);
  lines.push(
    `  Summarizer: ${snapshot.model || '(none)'}` +
      (config.useFastTier ? ' (fast tier preferred)' : ' (fast tier not used)'),
  );
  lines.push(`  On summarize failure: ${config.onFailure}`);

  // THE PARENTHETICAL IS BUILT FROM WHATEVER APPLIES, AND OMITTED WHEN NOTHING
  // DOES (quiet-noop D-9). `declined` counts checkpoints that fired and chose to
  // do nothing - the only human-readable trace of a decline once the transcript
  // stopped carrying a card for one. It renders ONLY when non-zero: a counter
  // that says `(0 checkpoints declined)` in every healthy session would have
  // replaced one piece of noise with another.
  const sessionNotes: string[] = [];
  if (snapshot.generation > 0) sessionNotes.push(`generation ${snapshot.generation}`);
  const declined = snapshot.declined ?? 0;
  if (declined > 0) {
    sessionNotes.push(`${declined} ${declined === 1 ? 'checkpoint' : 'checkpoints'} declined`);
  }
  lines.push(
    `  This session: ${snapshot.compactions} ` +
      `${snapshot.compactions === 1 ? 'compaction' : 'compactions'}` +
      (sessionNotes.length > 0 ? ` (${sessionNotes.join(', ')})` : '') +
      `, ${formatTokens(snapshot.tokensReclaimed)} tokens reclaimed`,
  );

  const cost = snapshot.pricingUnknown
    ? `unknown (no price table for ${snapshot.model || 'the summarizer'})`
    : formatCost(compactionCost(ctx));
  lines.push(
    `  Compaction spend: ${formatTokens(snapshot.usage.inputTokens)} in / ` +
      `${formatTokens(snapshot.usage.outputTokens)} out, ${cost}`,
  );

  // TWO MORE LINES, AND ONLY WHEN THEY APPLY (hardening §4.4). A clip inside the
  // retained turns is a real data loss and `/compact status` is the GUARANTEED
  // reporting surface, so it has to be sayable here as well as on a card that
  // may have scrolled away.
  const relief = totalTailRelief(ctx);
  if (relief) {
    lines.push(
      `  Tail relief    ${relief.messages} tool ` +
        `${relief.messages === 1 ? 'result' : 'results'} clipped ` +
        `(${formatTokens(relief.charsRemoved)} chars) in ` +
        `${relief.compactions} ${relief.compactions === 1 ? 'compaction' : 'compactions'}`,
    );
  }
  const archives = archiveSummary(ctx);
  if (archives) lines.push(`  Archive        ${archives}`);

  if (snapshot.inFlight) lines.push('  A compaction is running right now.');
  if (controller.isCompactionRegistered() && !controller.isCompactionEnabled()) {
    lines.push('  Turn it back on with /compact on.');
  }
  return lines.join('\n');
}

/**
 * The summarizer's own price, never the lead's.
 *
 * THE REF IS ASKED FOR, NOT RECONSTRUCTED. Deriving the provider from config
 * (`fast.enabled ? fast.provider : provider`) is wrong exactly when
 * `fast.enabled` is true and `compaction.useFastTier` is false: the summarizer is
 * then the MAIN model looked up under the FAST provider, which the static table
 * has never seen, so `getModelInfoFor` returns a runtime model costed at zero and
 * this line reports `$0.00` for a priced model. `pricingUnknown` cannot catch it
 * either — the compactor sets that flag from the ref it actually used, which IS
 * priced. `getCompactionSummarizerRef()` carries the answer instead.
 */
function compactionCost(ctx: CommandContext): number {
  const snapshot = ctx.controller.getCompactionSnapshot();
  const ref = ctx.controller.getCompactionSummarizerRef();
  if (!ref) return 0;
  return computeCost(snapshot.usage, ctx.controller.getModelInfoFor(ref).cost);
}

/**
 * The session's clipped-tool-result total, or `null` when relief never fired.
 *
 * READ FROM THE TRANSCRIPT ENTRIES rather than from a counter on the snapshot,
 * because relief is rare enough that a session-total field would be a number
 * carried on every snapshot for a line almost nobody sees. The entries are
 * already in view state and already carry it.
 */
function totalTailRelief(
  ctx: CommandContext,
): { messages: number; charsRemoved: number; compactions: number } | null {
  let messages = 0;
  let charsRemoved = 0;
  let compactions = 0;
  for (const entry of ctx.state.entries) {
    if (entry.kind !== 'compaction' || !entry.tailRelief) continue;
    messages += entry.tailRelief.messages;
    charsRemoved += entry.tailRelief.charsRemoved;
    compactions += 1;
  }
  return compactions === 0 ? null : { messages, charsRemoved, compactions };
}

/** `N files in <dir>` for this run, or `null` when there are none. */
function archiveSummary(ctx: CommandContext): string | null {
  const runId = ctx.controller.getCompactionRunId();
  if (!runId) return null;
  if (!ctx.controller.getCompactionConfig().archive) return null;
  const listing = listArchives(runId);
  if (listing.entries.length === 0) return null;
  return `${listing.entries.length} ${listing.entries.length === 1 ? 'file' : 'files'} in ${listing.dir}`;
}

/** One `/compact history` row. */
function archiveRow(entry: ArchiveEntry): string {
  const at = new Date(entry.createdAt);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const clock = `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
  return (
    `  #${entry.index}  ${clock}   ${entry.trigger.padEnd(8)}  ` +
    `${formatTokens(entry.tokensBefore)} -> ${formatTokens(entry.tokensAfter)}   ` +
    `${entry.droppedCount} messages   ${entry.fileName}`
  );
}

/**
 * `/compact history` - THIS RUN's archives, newest first.
 *
 * THE LISTING IS `runId`-SCOPED (RV-6). `<home>/compaction` is shared by every
 * `aragon` on the machine, so an unscoped listing would present a neighbouring
 * session's compactions as this one's and `#2` would be ambiguous the moment two
 * runs both reached their second compaction. Other runs' files are COUNTED in one
 * trailing line rather than listed, because the alternative is a user concluding
 * their own compactions went missing.
 */
function formatCompactionHistory(ctx: CommandContext): string {
  const runId = ctx.controller.getCompactionRunId();
  if (!runId) {
    return 'Compaction is not registered for this session (started with --no-compaction).';
  }
  const listing = listArchives(runId);
  if (listing.entries.length === 0) {
    return ctx.controller.getCompactionConfig().archive
      ? 'No compactions have been archived yet.'
      : 'No compaction archives for this session. (compaction.archive is off)';
  }
  const lines = [
    `compaction history (${listing.entries.length} ` +
      `${listing.entries.length === 1 ? 'archive' : 'archives'}, ${listing.dir})`,
    '',
    ...listing.entries.map(archiveRow),
  ];
  if (listing.otherRuns > 0) {
    lines.push('');
    lines.push(
      `  (${listing.otherRuns} more ${listing.otherRuns === 1 ? 'archive' : 'archives'} ` +
        'from earlier runs in this directory)',
    );
  }
  return lines.join('\n');
}

/**
 * `/compact show <n>` - metadata, the stored summary, and the path.
 *
 * `<n>` IS THE COMPACTION INDEX WITHIN THIS RUN - the `#n` `/compact history`
 * printed, which is also the `index` field in the document. Those are the same
 * number by construction: the listing is `runId`-scoped and `index` is unique
 * within a run, so there is no second numbering to confuse it with.
 *
 * IT NEVER PRINTS MESSAGE BODIES (DH-9). A single archive can be megabytes and
 * the transcript is not a pager; the path is the useful output.
 */
function formatCompactionShow(ctx: CommandContext, raw: string): string {
  const runId = ctx.controller.getCompactionRunId();
  if (!runId) {
    return 'Compaction is not registered for this session (started with --no-compaction).';
  }
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n) || n <= 0) return 'Usage: /compact show <n>  (see /compact history)';
  const entry = findArchive(runId, n);
  if (!entry) return `No archive #${n}. Try /compact history.`;

  const lines = [
    `compaction #${entry.index} (${entry.trigger}, ${entry.mode})`,
    `  When:     ${new Date(entry.createdAt).toISOString()}`,
    `  Tokens:   ${formatTokens(entry.tokensBefore)} -> ${formatTokens(entry.tokensAfter)}`,
    `  Dropped:  ${entry.droppedCount} messages${entry.clipped ? ' (archive body clipped to fit)' : ''}`,
    `  Model:    ${entry.model || '(none)'}`,
  ];
  if (entry.tailRelief) {
    lines.push(
      `  Clipped:  ${entry.tailRelief.messages} tool results in the retained turns ` +
        `(${formatTokens(entry.tailRelief.charsRemoved)} chars)`,
    );
  }
  lines.push(`  File:     ${entry.path}`);
  if (entry.summary) {
    lines.push('');
    lines.push(entry.summary);
  }
  return lines.join('\n');
}

const USAGE =
  'Usage: /compact [status | on | off | threshold <n> | keep <n> | history | show <n> | <instructions>]';

/**
 * The `/compact` handler.
 *
 * `/compact <free text>` is the Claude Code affordance and is therefore the
 * FALL-THROUGH rather than a subcommand: anything that is not one of the seven
 * verbs is instructions for the summarizer.
 */
export async function runCompactCommand(ctx: CommandContext): Promise<void> {
  const arg = ctx.args.trim();
  const [rawVerb, value] = arg.split(/\s+/, 2);
  const verb = (rawVerb ?? '').toLowerCase();
  const controller = ctx.controller;

  if (verb === 'status') {
    ctx.notify('info', formatCompactionStatus(ctx));
    return;
  }

  if (verb === 'on' || verb === 'off') {
    const enabled = verb === 'on';
    const applied = controller.setCompactionConfig({ enabled });
    ctx.persistConfig({ compaction: { enabled } as PersistedConfig['compaction'] });
    if (!controller.isCompactionRegistered()) {
      // The honest branch, and the whole point of splitting by what was decided
      // at construction. `enabled` decides whether the wiring EXISTS, and a
      // session that started without one cannot be given one mid-flight: the
      // `Agent` takes the port in its constructor and has no setter for it
      // (§3.2). `/fast on` and `/team on` each record the same shape.
      ctx.notify(
        'info',
        enabled
          ? 'Compaction is off for this session (started with --no-compaction). Saved for next launch.'
          : 'Compaction is already off for this session. Saved for next launch.',
      );
      return;
    }
    controller.setCompactionEnabled(applied.enabled);
    ctx.toast('success', `Auto-compaction ${enabled ? 'on' : 'off'}.`);
    return;
  }

  if (verb === 'threshold') {
    const raw = (value ?? '').trim();
    const parsed = raw ? parseThresholdInput(raw) : null;
    if (parsed === null) {
      ctx.notify('warn', 'Usage: /compact threshold <0.5-0.95>  (also accepts 90%)');
      return;
    }
    const applied = controller.setCompactionConfig({ threshold: parsed });
    ctx.persistConfig({
      compaction: { threshold: applied.threshold } as PersistedConfig['compaction'],
    });
    // The APPLIED value, not the requested one: `clampCompactionConfig` may have
    // moved it, and reporting what was asked for would make the clamp invisible.
    ctx.toast('success', `Compaction threshold set to ${Math.round(applied.threshold * 100)}%.`);
    return;
  }

  if (verb === 'keep') {
    const n = Number.parseInt((value ?? '').trim(), 10);
    if (!Number.isFinite(n) || n <= 0) {
      ctx.notify('warn', 'Usage: /compact keep <1-20>');
      return;
    }
    const applied = controller.setCompactionConfig({ keepRecentTurns: n });
    ctx.persistConfig({
      compaction: { keepRecentTurns: applied.keepRecentTurns } as PersistedConfig['compaction'],
    });
    ctx.toast('success', `Keeping ${applied.keepRecentTurns} recent turns verbatim.`);
    return;
  }

  // BEFORE THE FREE-TEXT FALL-THROUGH, so a user cannot accidentally summarize
  // with the word "history".
  if (verb === 'history') {
    ctx.notify('info', formatCompactionHistory(ctx));
    return;
  }

  if (verb === 'show') {
    ctx.notify('info', formatCompactionShow(ctx, value ?? ''));
    return;
  }

  if (verb === 'help' || verb === '?') {
    ctx.notify('info', USAGE);
    return;
  }

  // --- Compact now, with `arg` (possibly empty) as instructions -------------

  if (!controller.isCompactionRegistered()) {
    ctx.notify(
      'info',
      'Compaction is not registered for this session (started with --no-compaction).',
    );
    return;
  }
  if (!controller.isCompactionEnabled()) {
    ctx.notify('warn', 'Auto-compaction is off. Turn it on with /compact on, then try again.');
    return;
  }

  const instructions = arg.length > 0 ? arg.slice(0, COMPACTION_LIMITS.summaryMaxChars) : undefined;

  if (ctx.state.status === 'running') {
    // QUEUED, NOT RACED (D-17). Replacing `messages` under a live loop is a race;
    // a flag `shouldCompact` honours at the next turn boundary is not, because
    // the boundary is the one moment the engine is single-threaded with respect
    // to the history, by construction.
    controller.queueCompaction(instructions);
    ctx.toast('info', 'Will compact before the next turn.');
    return;
  }

  ctx.toast('info', 'Compacting context...');
  const outcome = await controller.compactNow(instructions);
  if (outcome.ok) {
    ctx.toast('success', 'Context compacted.');
    return;
  }
  // THE SAME `invalid_history: <reason>` VOCABULARY THE ENGINE PRODUCES (D-25 /
  // P1-7), so the card, the log and `/compact status` cannot tell the idle path
  // apart from the in-loop one.
  ctx.notify('warn', `Compaction did not run: ${outcome.reason ?? 'unknown'}`);
}
