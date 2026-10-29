import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';
import type { UsageTotal } from '../../model/agent/reducer.js';
import type { ContextUsageSnapshot } from '../../model/compaction/types.js';
import { formatDuration } from '../../model/agent/usage.js';
import { isGovernedModeValue, modeWord } from '../governance-status.js';
import { interactionCopy as copy } from '../interaction-copy.js';
import type { EscapeAction, StatusFeedback } from '../status-feedback.js';
import { toolGerund, type VoiceMode } from '../tool-voice.js';

export type RunPhase = 'idle' | 'starting' | 'waiting' | 'thinking' | 'generating' | 'preparing-tool' | 'tool';
export interface StatusLayoutInput {
  columns: number; phase: RunPhase; pendingCount: number;
  context: ContextUsageSnapshot; usageTotal: UsageTotal;
  thinkingLevel: string; elapsedMs: number; tokPerSec: number;
  activeTool?: { name: string; toolCallId: string } | null;
  /**
   * How tool names are worded. ABSENT = developer wording, the identifier as-is
   * (the byte-identical baseline every pre-existing caller and test relies on).
   */
  voiceMode?: VoiceMode;
  /**
   * A bounded wait in flight (long-task-jobs §4.9).
   *
   * PRESENT ONLY WHILE `job_wait` IS THE ACTIVE TOOL, and it REPLACES the
   * `Running job_wait` label rather than joining it: "Waiting on t3 (up to 30s)"
   * is the state the user asked about (what, and how long at most), while the
   * tool name is an implementation detail of how the runtime is waiting.
   */
  wait?: { jobId: string; upToSeconds: number; elapsedSeconds?: number };
  runOutcome?: 'none' | 'ended' | 'interrupted' | 'failed';
  spinner?: string; waitingForConfirmation?: boolean; stopping?: boolean;
  /**
   * Auto-compaction paused itself after repeated no-progress attempts
   * (context-compaction-never-fires C).
   *
   * A SEPARATE FIELD FROM `compacting`, and it renders as a SUFFIX on the context
   * gauge rather than as a phase word: the fact belongs next to the percentage it
   * explains ("Context 95% auto-paused"), and the phase slot must keep answering
   * "is the agent running".
   */
  compactionPaused?: boolean;
  compacting?: boolean; retryActive?: { attempt: number; max: number; secondsLeft: number };
  /** Named on the primary row in EVERY mode - the §6.4 guarantee, restored. */
  mode?: string; pendingMode?: string | null; servicesActive?: { live: number };
  /**
   * Forced team mode is ARMED, with the fan-out count it was armed with
   * (team-command-forced-dispatch §3.8 / D-9).
   *
   * THE ONLY PERSISTENTLY VISIBLE SIGNAL that `/team` happened. The directive is
   * one turn, the prompt block is invisible, and the panel only appears while a
   * dispatch runs - so without this chip the answer to "why is my agent
   * dispatching?" is "remember what you typed". It is read at RENDER time from
   * `controller.getForcedTeam()`, never mirrored into `ViewState`: a mirror is a
   * second copy that can disagree, the exact defect §2.4 is about.
   *
   * ABSENT means "not armed" and keeps every existing caller's plan BYTE-
   * IDENTICAL (the same discipline `reserveRight` records below).
   */
  forcedTeam?: { count: number };
  teamActive?: { running: number; total: number }; todoActive?: { done: number; total: number };
  /**
   * The acceptance counter (todo-acceptance-criteria §6.11).
   *
   * A FALLBACK, exactly like `todoActive`: present only when the rail is NOT already
   * reporting the number, because printing `2/5` twice in one row is the defect
   * RV-P2-4 records. Whether it is present is decided by `acceptanceChip()` in
   * `ui/layout/todo-layout.ts`, which owns "what did the rail actually draw".
   */
  acceptanceActive?: { checked: number; total: number; failed: number };
  ecoRung?: number; fastActive?: { inFlight: boolean }; scrolledLines?: number;
  /**
   * Cells already spent at the RIGHT end of this same row
   * (tui-session-id-resume 3.10 / I-6).
   *
   * The session-id chip is not a layer above this row: it takes its cells out of
   * the SAME budget, because the row is measured rather than laid out and
   * anything overlapping it eats `phase` first. ABSENT MEANS 0, which is what
   * keeps every existing caller's plan byte-identical (I-6).
   */
  reserveRight?: number;
}
export interface StatusPrimaryInput extends StatusLayoutInput {
  feedback?: StatusFeedback; escapeAction?: EscapeAction; speedKnown: boolean;
  interruptPhase?: 'ready' | 'armed' | 'stopping';
}
export interface StatusField {
  id: string; text: string; cells: number;
  /**
   * 'accent' carries the mode word - the row's one always-on emphasis. 'govern' is the
   * same slot while the posture is GOVERN / PLAN+GOVERN (`governAccent`, its own hue).
   */
  tone: 'normal' | 'muted' | 'warning' | 'error' | 'accent' | 'govern';
}
export interface StatusLinePlan {
  fields: readonly StatusField[]; separator: string; separatorCells: number; cells: number;
}
export function cleanStatusText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return stripAnsi(text).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ' ').trim();
}
export function statusField(id: string, text: string, tone: StatusField['tone'] = 'muted'): StatusField {
  const clean = cleanStatusText(text);
  return { id, text: clean, cells: stringWidth(clean), tone };
}
export function statusLinePlan(fields: readonly StatusField[], separator = ' | '): StatusLinePlan {
  const separatorCells = stringWidth(separator);
  return { fields, separator, separatorCells,
    cells: fields.reduce((sum, item) => sum + item.cells, 0) + Math.max(0, fields.length - 1) * separatorCells };
}
export function phaseLabels(input: Pick<StatusLayoutInput, 'phase' | 'activeTool' | 'runOutcome' | 'voiceMode' |
  'waitingForConfirmation' | 'stopping' | 'compacting' | 'retryActive' | 'wait'>): readonly [string, string] {
  if (input.waitingForConfirmation) return copy.confirming;
  if (input.stopping) return copy.stopping;
  if (input.compacting) return copy.compacting;
  if (input.retryActive) return copy.retrying;
  // A WAIT OUTRANKS THE TOOL NAME (long-task-jobs AC-28): `Running job_wait`
  // answers "which tool", `Waiting on t3 (up to 30s)` answers "what am I waiting
  // for and how long may it take", which is the question a user staring at a
  // quiet terminal actually has. Both forms carry it - the short rung is
  // truncated by width, not reworded.
  if (input.wait) {
    const id = cleanStatusText(input.wait.jobId);
    // WITH A CLOCK (extended-job-wait): `Waiting on t3 4m12s/10m00s`, and a shorter
    // rung that keeps the id and the elapsed time. Without one the original
    // sentence is byte-identical, which the older assertions rely on.
    if (input.wait.elapsedSeconds !== undefined) {
      const elapsed = shortDuration(Math.max(0, input.wait.elapsedSeconds) * 1000);
      const upTo = shortDuration(Math.max(0, input.wait.upToSeconds) * 1000);
      return [`Wait ${id} ${elapsed}`, `Waiting on ${id} ${elapsed}/${upTo}`];
    }
    const label = `Waiting on ${id} ` +
      `(up to ${Math.max(0, Math.round(input.wait.upToSeconds))}s)`;
    return [label, label];
  }
  if (input.activeTool) {
    // FRIENDLY: `Reading file`, not `Running read_file`. Developer keeps the
    // original sentence byte for byte.
    if (input.voiceMode === 'friendly') {
      return [copy.tool[0], cleanStatusText(toolGerund(input.activeTool.name, 'friendly'))];
    }
    return [copy.tool[0], copy.tool[1] + ' ' + cleanStatusText(input.activeTool.name)];
  }
  if (input.phase === 'idle' && input.runOutcome && input.runOutcome !== 'none') return copy[input.runOutcome];
  if (input.phase === 'preparing-tool') return copy.preparingTool;
  return copy[input.phase];
}
export function validContext(context: ContextUsageSnapshot): boolean {
  return context.windowKnown && context.window > 0 &&
    [context.occupied, context.window, context.pct, context.deltaTokens].every(n => Number.isFinite(n) && n >= 0);
}
function contextPercent(context: ContextUsageSnapshot): string {
  if (!validContext(context)) return '?';
  const mark = context.source === 'estimate' || context.deltaTokens > 0 ? '~' : '';
  return mark + (context.pct > 999 ? '>999' : Math.round(context.pct)) + '%';
}

/**
 * The words that ride on the gauge when auto-compaction has given up (C).
 *
 * IT RIDES ON THE GAUGE RATHER THAN OCCUPYING ITS OWN FIELD. "Auto-paused" is the
 * only fact that explains a stuck percentage, so the two belong in one field for
 * the same reason `/context` prints them on adjacent lines. A second field would
 * also be the first thing the width ladder drops, and this is precisely the state
 * that must survive a narrow terminal.
 *
 * `paused` at the tight rungs: the full phrase costs twelve cells the row does
 * not have at rung 3 and beyond, and dropping the fact entirely would be worse
 * than abbreviating it.
 */
function pausedSuffix(full: boolean): string {
  return full ? ' auto-paused' : ' paused';
}
export function shortDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return seconds + 's';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm' + String(seconds % 60).padStart(2, '0') + 's';
  if (seconds < 86400) return Math.floor(seconds / 3600) + 'h' + String(Math.floor(seconds / 60) % 60).padStart(2, '0') + 'm';
  const days = Math.floor(seconds / 86400);
  return days > 999 ? '>999d' : days + 'd';
}
function speedNumber(input: StatusPrimaryInput): string {
  if (!input.speedKnown || input.phase === 'idle' || input.elapsedMs <= 500
    || !Number.isFinite(input.tokPerSec) || input.tokPerSec < 0) return '--';
  const value = input.tokPerSec;
  if (value > 99e6) return '>99M';
  if (value >= 999950) return (value / 1e6).toFixed(1) + 'M';
  if (value > 999) return (value / 1000).toFixed(1) + 'k';
  return String(Math.round(value));
}
function feedbackLabel(input: StatusPrimaryInput, form: 'full' | 'short' | 'tiny'): string | undefined {
  const feedback = input.feedback;
  if (!feedback) return undefined;
  const error = feedback.kind === 'copy-error' || feedback.kind === 'copy-cleanup';
  if (error && input.escapeAction === 'force-stop') {
    return form === 'full' ? 'Copy err / Esc force' : form === 'tiny' ? 'E/F' : 'Err/EscF';
  }
  if (error && input.escapeAction === 'confirm-stop' && input.interruptPhase === 'armed') {
    return form === 'full' ? 'Copy err / Esc stop' : form === 'tiny' ? 'E/S' : 'Err/EscS';
  }
  const labels: Record<StatusFeedback['kind'], readonly [string, string, string]> = {
    confirm: ['Awaiting confirmation', 'Ask', 'Ask'], stopping: ['Esc stop', 'EscS', 'EscS'],
    'force-stop': ['Esc force', 'EscF', 'EscF'], exit: ['^C exit', '^Cexit', '^C'],
    'clear-input': ['^C clear', '^Cclear', '^C'],
    copying: ['Copying', 'Copy', 'Copy'], copied: ['Copied', 'Copied', 'Copy'],
    'copy-sent': ['Copy sent', 'Sent', 'Sent'], 'copy-cleanup': ['Copy cleanup', 'Err', 'Err'],
    'copy-error': ['Copy err', 'Err', 'Err'], notice: ['Notice', 'Notice', 'Note'],
  };
  return labels[feedback.kind][form === 'full' ? 0 : form === 'short' ? 1 : 2];
}

/**
 * Kinds that are NOTIFICATIONS, not a phase word (defect 8 / 9).
 *
 * A notification says "something happened". An ACTION kind (`confirm`,
 * `stopping`, `force-stop`, `exit`, `clear-input`, `copy-error`,
 * `copy-cleanup`) says what the NEXT key does - that IS the phase slot's job, so
 * those keep replacing it. Everything in this set gets its own field instead and
 * `phase` is never displaced: `Idle` / `Running` is the one thing this row must
 * always answer, and a notice that lands as a turn ends is exactly when a wrong
 * answer misleads the user about whether the agent is still working.
 */
const NOTIFICATION_KINDS: ReadonlySet<StatusFeedback['kind']> = new Set([
  'notice', 'copied', 'copy-sent', 'copying',
]);

/**
 * The most cells a notification body may take on the primary row.
 *
 * The row is exactly one row high and measured, so the body is CLIPPED rather
 * than wrapped. 32 cells carries `Theme set to light.` or `Todo panel off.`
 * whole while leaving the phase word, the mode and the context gauge intact; a
 * longer message still has the details row, where it is rendered in full.
 */
const FEEDBACK_TEXT_CELLS = 32;

/**
 * Clip `text` to at most `cells` display columns, never splitting a wide glyph.
 *
 * Local rather than `interaction-hints.clipStatusText`: that module already
 * imports THIS one, and a cycle for a five-line guard is not worth it.
 */
function clipFeedbackText(text: string, cells: number): string {
  const clean = cleanStatusText(text);
  if (stringWidth(clean) <= cells) return clean;
  let clipped = '';
  for (const char of clean) {
    if (stringWidth(clipped + char) > cells) break;
    clipped += char;
  }
  return clipped;
}
const thinkingCodes: Record<string, string> = { off: 'O', minimal: 'N', low: 'L', medium: 'M', high: 'H', xhigh: 'X' };

/**
 * The mode word for the primary row: full rungs name the mode with
 * `MODE_LABEL`, tight rungs keep only its first letter, and a deferred switch
 * renders `CUR>PENDING` in both tiers. `null` when the caller names no mode at
 * all, so callers and tests that predate the field keep a byte-identical plan.
 * The word must survive every width rung: the border color cannot be the only
 * mode signal the default view carries (plan-mode P1-6).
 */
function modeFieldText(
  mode: string | undefined,
  pendingMode: string | null | undefined,
  full: boolean,
): string | null {
  if (!mode && !pendingMode) return null;
  const word = (value: string): string => {
    // `build` / `plan` answer exactly as before; the two governed postures are the only
    // other values `modeWord` knows (`PG` is the short form of PLAN+GOVERN, since `P` is PLAN).
    const known = modeWord(value, full);
    if (known !== undefined) return known;
    return full ? value.toUpperCase() : (value[0] ?? '?').toUpperCase();
  };
  const current = word(mode || 'build');
  return pendingMode ? `${current}>${word(pendingMode)}` : current;
}

/** Every field survives each width rung; only the redraw carrier is outside this plan. */
export function planPrimaryStatusFields(input: StatusPrimaryInput): StatusLinePlan {
  const columns = Number.isFinite(input.columns) ? Math.floor(input.columns) : 80;
  // GUARDED LIKE `columns` ABOVE, and for the same reason: `Math.max(0, NaN)`
  // is `NaN`, which would make every `cells > budget` comparison false and
  // silently pin this row at its widest rung - the opposite of reserving space.
  const reserved =
    typeof input.reserveRight === 'number' && Number.isFinite(input.reserveRight)
      ? Math.max(0, Math.floor(input.reserveRight))
      : 0;
  const budget = Math.max(0, columns - 1 - reserved);
  const labels = phaseLabels(input);
  const glyphText = cleanStatusText(input.spinner ?? '-');
  const glyph = stringWidth(glyphText) === 1 ? glyphText : '-';
  const code = thinkingCodes[input.thinkingLevel] ?? '?';
  const pct = contextPercent(input.context);
  const speed = speedNumber(input);
  // THE RUN'S OWN URGENCY, and the notification's, are two different things
  // (defect 9). `tone` keeps today's meaning for an ACTION kind (it colours the
  // phase word); a notification is painted with its own level and leaves the
  // phase word to describe the run - a copy error must not make `Idle` red.
  const tone: StatusField['tone'] = input.feedback?.level === 'error' || input.runOutcome === 'failed'
    ? 'error' : input.feedback?.level === 'warn' || input.waitingForConfirmation || input.stopping ? 'warning' : 'normal';
  const notification = !!input.feedback && NOTIFICATION_KINDS.has(input.feedback.kind);
  const phaseTone: StatusField['tone'] = notification
    ? input.runOutcome === 'failed' ? 'error'
      : input.waitingForConfirmation || input.stopping ? 'warning' : 'normal'
    : tone;
  const feedbackTone: StatusField['tone'] = input.feedback?.level === 'error' ? 'error'
    : input.feedback?.level === 'warn' ? 'warning' : 'normal';
  const build = (rung: number): StatusLinePlan => {
    const full = rung === 0;
    const form = full ? 'full' : rung >= 4 ? 'tiny' : 'short';
    // THE BODY IS A FIELD OF ITS OWN (defect 8). The text has been in
    // `feedback.text` all along; it only ever reached the screen on the SECOND
    // status row, which is behind Ctrl+G and off by default. Rung 3 and tighter
    // drop it: the ladder exists to keep the phase word, and a body that only fits
    // by hiding `Running` would be the original defect back with extra steps.
    const notice = notification && rung <= 2 && input.feedback
      ? clipFeedbackText(input.feedback.text, FEEDBACK_TEXT_CELLS) : '';
    const label = (notification ? undefined : feedbackLabel(input, form))
      ?? (full ? labels[1] : rung >= 4 ? labels[0].slice(0, 4) : labels[0]);
    const modeText = modeFieldText(input.mode, input.pendingMode, full);
    // IMMEDIATELY AFTER `mode`, and kept at EVERY rung: both describe a state
    // the USER armed, so the row's emphasis budget goes on them and nothing
    // else (`accent`). It shortens to `T4` instead of disappearing because a
    // chip that vanishes on a narrow terminal is indistinguishable from a
    // disarmed session - the one question it exists to answer.
    const forcedText = input.forcedTeam
      ? (rung >= 3 ? `T${input.forcedTeam.count}` : `Team ${input.forcedTeam.count}`)
      : null;
    return statusLinePlan([
      statusField('phase', glyph + (rung >= 5 ? '' : ' ') + label, phaseTone),
      ...(notice ? [statusField('feedback', notice, feedbackTone)] : []),
      ...(modeText
        ? [statusField('mode', modeText,
          isGovernedModeValue(input.mode) || isGovernedModeValue(input.pendingMode) ? 'govern' : 'accent')]
        : []),
      ...(forcedText ? [statusField('forcedTeam', forcedText, 'accent')] : []),
      statusField('context', (full ? 'Context ' : 'C') + pct
        + (input.compactionPaused === true ? pausedSuffix(full) : '')),
      statusField('thinking', full ? 'Think ' + (thinkingCodes[input.thinkingLevel] ? input.thinkingLevel : '?')
        : (rung >= 2 ? '' : 'Th:') + code),
      statusField('speed', speed + (full ? ' tok/s' : rung >= 3 ? '/s' : 't/s')),
      statusField('elapsed', full && Number.isFinite(input.elapsedMs) && input.elapsedMs > 0
        ? formatDuration(input.elapsedMs) : shortDuration(input.elapsedMs)),
    ], full ? ' | ' : ' ');
  };
  let plan = build(0);
  for (let rung = 1; plan.cells > budget && rung <= 5; rung++) plan = build(rung);
  return plan;
}
