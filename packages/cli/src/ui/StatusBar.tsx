/**
 * Status bar (spec §4.8). Width-aware, borderless, EXACTLY one row: a left
 * cluster (run status, model, thinking level) and a right cluster (context
 * gauge, tokens, cost, tokens/sec + elapsed while running, off-bottom `↑N`).
 * Clusters drop out gracefully on narrow terminals.
 *
 * Dropping the round border here buys back 3 rows of a 24-row terminal — an
 * eighth of the screen was being spent framing a single line of text.
 */

import React from 'react';
import { Box, Text, useStdout } from 'ink';
import type { Theme } from './theme.js';
import type { TermCapabilities } from './capabilities.js';
import { pickGlyphs } from './glyphs.js';
import type { UsageTotal } from '../agent/reducer.js';
import { formatCost, formatTokens, formatDuration } from '../agent/usage.js';
import { buildGauge } from './gauge.js';
import { MODE_LABEL, type AgentMode } from '../agent/agent-mode.js';
import { formatRetryChip } from '../agent/retry-view.js';
import { FAST_LIMITS } from '../fast/limits.js';
import { COMPACTION_LIMITS } from '../compaction/limits.js';
import { TEAM_LIMITS } from '../team/limits.js';
import { TODO_LIMITS } from '../todo/limits.js';
import { PROC_LIMITS } from '../proc/limits.js';

interface StatusBarProps {
  model: string;
  provider: string;
  usageTotal: UsageTotal;
  contextTokens: number;
  contextWindow: number;
  contextWindowKnown: boolean;
  status: 'idle' | 'running';
  elapsedMs: number;
  thinkingLevel: string;
  tokPerSec: number;
  theme: Theme;
  caps: TermCapabilities;
  /**
   * Lines scrolled off the bottom; > 0 renders `↑N`. Inline mode has no
   * self-drawn viewport, so it simply never sends anything but 0 — the bar
   * needs no render-mode branch of its own.
   */
  scrolledLines?: number;
  /**
   * Ctrl+L redraw carrier — invariant I-5 (spec §4.13). See `redrawChar`.
   */
  redrawNonce?: number;
  /**
   * The session mode. THIS IS THE GUARANTEED MODE INDICATOR (plan-mode §6.4 /
   * P1-6): the composer chip disappears on a short terminal, under
   * `hints: false`, and in inline render mode, but `StatusBar` renders in both
   * `AppShell` branches and its left cluster has no opt-out and no width gate.
   *
   * Design intent, stated here so it survives a later refactor: the status bar
   * must ALWAYS name a non-default mode; the chip may. Do not give this a
   * `cols >= N` breakpoint, and do not move it into the right cluster — those
   * children are flexible and drop characters under pressure.
   */
  agentMode?: AgentMode;
  /** Non-null while a deferred `plan -> build` waits for `agent_end`. */
  pendingAgentMode?: AgentMode | null;
  /**
   * Live subagent counts (team-subagents §6.2), or absent when no dispatch is
   * running — an ordinary session's bar is then unchanged.
   *
   * LEFT CLUSTER, and it degrades (D-20 / P2-1). The left cluster is
   * `flexShrink={0}`, so every column it takes comes out of the context gauge
   * and the cost readout opposite it; on an 80-column terminal the full
   * `agents 3/5` visibly squeezes them, and the gauge is how a user notices they
   * are about to run out of context. Below `TEAM_LIMITS.statusCompactCols` this
   * therefore renders as `[3]` — the running count alone.
   *
   * This does NOT contradict the "no `cols >= N` breakpoint" rule above: that
   * rule is written about `agentMode`, whose reason is that the mode must never
   * be unreportable. The team counter has a second, fuller home in `TeamPanel`
   * and a third in `TeamCard`; it is the one readout on this bar that can afford
   * to degrade.
   */
  teamActive?: { running: number; total: number };
  /**
   * Live todo counts (todo-plan-execution §6.3), or absent.
   *
   * `App` sends this ONLY when a list exists AND the rail does not: with the
   * rail on screen the numbers are already there in a larger typeface, and
   * duplicating them costs the context gauge columns it cannot spare. This is
   * therefore the INLINE-MODE and NARROW-TERMINAL fallback for R-d, which is
   * exactly why it is here rather than being folded into the rail's own gate.
   *
   * Degrades below `TODO_LIMITS.statusCompactCols` from `todo 2/7` to `[2/7]`,
   * the same treatment and the same justification as the team counter's
   * `agents 3/5` -> `[3]`. See the note on `agentMode` for why that rule does
   * NOT apply to the mode word.
   */
  todoActive?: { done: number; total: number };
  /**
   * Live background services (background-service-supervision §3.8), or absent
   * when none are running — an ordinary session's bar is then unchanged.
   *
   * LEFT CLUSTER, after the todo chip, and it DEGRADES rather than hiding below
   * `PROC_LIMITS.statusCompactCols`. That is the `todoActive` / `teamActive`
   * ladder rather than `compactionActive`'s hide-below-threshold one, and the
   * choice is deliberate: `compact` and `fast` describe something the CLI is
   * doing to itself, whereas this is a PROCESS ON THE USER'S MACHINE HOLDING A
   * PORT. A narrow terminal is a reason to shorten it, never a reason to stop
   * saying it.
   *
   * `live` counts `starting | ready | running`. The transcript records events
   * about a service (D-11); this is where "what is running right now" lives,
   * alongside `/bg` and `bash_output`.
   */
  servicesActive?: { live: number };
  /**
   * Live retry state (llm-api-retry-backoff §6.6), or absent when nothing is
   * retrying — an ordinary session's bar is then unchanged.
   *
   * LEFT CLUSTER, after `teamActive`, and it DEGRADES. It is a run-state fact like
   * `agents 3/5`, and the left cluster is `flexShrink={0}` so every column it takes
   * comes out of the context gauge; below `RETRY_UI.statusCompactCols` it renders
   * as `[r3]`.
   *
   * This does NOT contradict the "no `cols >= N` breakpoint" rule on `agentMode`
   * above: that rule exists because the MODE must never be unreportable. The retry
   * has a second, fuller home in the transcript card, which is exactly why it is
   * the kind of readout that can afford to shrink.
   */
  retryActive?: { attempt: number; max: number; secondsLeft: number };
  /**
   * Render-governor rung (tui-render-performance L4). `> 0` renders a muted
   * `eco` chip.
   *
   * I-L4-2 — THE GOVERNOR IS USER-VISIBLE, and this is where. A user who cannot
   * see why the stream got chunkier will conclude the model got slower, and
   * degrading silently is the one thing a claim of robustness cannot afford.
   * It sits in the RIGHT cluster next to the other derived numbers and is
   * suppressed on a narrow terminal, which is the `teamActive` treatment rather
   * than the `agentMode` one: the mode must never be unreportable, whereas an
   * eco chip on a 50-column terminal costs the context gauge more than it says.
   */
  ecoRung?: number;
  /**
   * The live fast tier (fast-model-tier §6), or absent when it is off for this
   * session — in which case an ordinary session's bar is byte-identical.
   *
   * RIGHT CLUSTER, next to `eco`, and it DEGRADES below
   * `FAST_LIMITS.statusCompactCols`. This is the `teamActive` / `ecoRung`
   * treatment rather than the `agentMode` one, and the distinction is the note
   * on `agentMode` above: the mode must never be unreportable, whereas the fast
   * tier has a fuller home in `/fast status` — which is the GUARANTEED reporting
   * surface — and a chip on a 60-column terminal costs the context gauge more
   * than it says.
   *
   * `inFlight` renders `fast*`, so a review that is taking a while is visible
   * without a spinner competing with the run's own.
   */
  fastActive?: { inFlight: boolean };
  /**
   * Live context compaction (context-auto-compaction §6.2), or absent when it is
   * off for this session — in which case an ordinary session's bar is unchanged.
   *
   * RIGHT CLUSTER, next to `fast` and `eco`, and it DEGRADES below
   * `COMPACTION_LIMITS.statusCompactCols`. The `teamActive` / `ecoRung` /
   * `fastActive` treatment rather than the `agentMode` one, for the reason the
   * note on `agentMode` gives: the mode must never be unreportable, whereas
   * compaction has a fuller home in `/compact status` — the GUARANTEED reporting
   * surface (§6.5) — and a chip on a 60-column terminal costs the context gauge
   * more than it says.
   *
   * `inFlight` renders `compacting`, so a summarization that is taking a while is
   * visible on this row without a spinner competing with the activity line's.
   */
  compactionActive?: { inFlight: boolean };
  /**
   * Where the gauge turns amber and red (§6.2).
   *
   * ABSENT means today's hardcoded `{ warn: 60, high: 85 }`, so a session with
   * compaction off renders a byte-identical bar. When present these are
   * `warnThreshold * 100` and `threshold * 100`, which is what makes the colour
   * the user sees agree with the number the trigger fires on.
   */
  gaugeMarks?: { warn: number; high: number };
  /**
   * Whether `contextTokens` is a DERIVED figure rather than a measured one.
   *
   * It WIDENS THE EXISTING `~`, it does not add a second marker. Today that
   * prefix means "the window is a guess" (`contextWindowKnown`); with compaction
   * it also has to mean "the occupancy is a guess", because the bar is written
   * from an estimate for one turn after every compaction so it can fall
   * immediately (§6.2 / AC-5).
   */
  contextEstimated?: boolean;
}

/** Below this the `eco` chip costs the context gauge more than it is worth. */
const ECO_MIN_COLS = 72;

/**
 * I-5 — DO NOT "CLEAN THIS UP". Ink short-circuits identical output at TWO
 * gates (`ink.js:132` and `log-update.js:13`), so a fixed frame whose React
 * output has not changed is never repainted. `Ctrl+L` therefore cannot work by
 * writing an escape sequence; it works by making the rendered STRING differ.
 * This alternates the status bar's left gutter between U+0020 and U+00A0: both
 * render one invisible column, so there is zero visual or layout difference,
 * but the bytes differ and both gates open.
 *
 * It must sit at the START of the line: Ink `trimEnd()`s every row (output.js),
 * and JS `trimEnd` strips U+00A0 too — a trailing carrier would be deleted and
 * Ctrl+L would degrade to a silent no-op.
 */
/** Built by code point so no formatter can normalize it back to a plain space. */
const NBSP = String.fromCharCode(0x00a0);

function redrawChar(nonce: number): string {
  return nonce % 2 === 0 ? ' ' : NBSP;
}

export function StatusBar(props: StatusBarProps): React.ReactElement {
  const {
    model,
    provider,
    usageTotal,
    contextTokens,
    contextWindow,
    contextWindowKnown,
    status,
    elapsedMs,
    thinkingLevel,
    tokPerSec,
    theme,
    caps,
    scrolledLines = 0,
    redrawNonce = 0,
    agentMode = 'build',
    pendingAgentMode = null,
    teamActive,
    todoActive,
    servicesActive,
    retryActive,
    ecoRung = 0,
    fastActive,
    compactionActive,
    gaugeMarks,
    contextEstimated = false,
  } = props;

  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const running = status === 'running';

  const glyphs = pickGlyphs(caps);
  const pct =
    contextWindow > 0 ? Math.min(100, Math.round((contextTokens / contextWindow) * 100)) : 0;
  // `gaugeMarks` is spread rather than passed as `undefined`, so a session with
  // compaction off takes `buildGauge`'s own default and the bar is byte-identical
  // to the pre-feature build.
  const gauge = gaugeMarks
    ? buildGauge(pct, cols < 72 ? 8 : 12, theme, caps, gaugeMarks)
    : buildGauge(pct, cols < 72 ? 8 : 12, theme, caps);
  // ONE `~` FOR TWO KINDS OF APPROXIMATION (§6.2). A second marker would be a
  // second thing to explain for a distinction the user does not act on
  // differently: either way the number is a guess.
  const pctLabel = `${contextWindowKnown && !contextEstimated ? '' : '~'}${gauge.pct}%`;
  const tokens = `${formatTokens(usageTotal.inputTokens)}${glyphs.arrowUp} ${formatTokens(
    usageTotal.outputTokens,
  )}${glyphs.arrowDown}`;

  const statusGlyph = running ? theme.symbols.toolRunning : theme.symbols.toolPending;

  // Nothing at all in build mode with nothing pending: the default posture is
  // not news, and a permanent word here would be furniture.
  const modeWord =
    agentMode === 'build' && !pendingAgentMode
      ? ''
      : pendingAgentMode
      ? `${MODE_LABEL[agentMode]} ${glyphs.arrowRight} ${MODE_LABEL[pendingAgentMode]}`
      : MODE_LABEL[agentMode];

  return (
    // `flexShrink={0}` on the left cluster is not cosmetic. When the two clusters
    // over-subscribe the row, yoga shrinks the flexible children and Ink's text
    // measurement drops a character from EACH of them — the bar renders "idl"
    // and "? hel" rather than truncating cleanly at one end. Pinning the left
    // cluster keeps the run status and model intact and makes the degradation
    // land in one predictable place.
    <Box flexDirection="row" justifyContent="space-between" flexShrink={0}>
      <Box flexDirection="row" flexShrink={0}>
        <Text color={running ? theme.toolRunning : theme.toolDone}>
          {redrawChar(redrawNonce)}
          {statusGlyph} {running ? 'running' : 'idle'}
        </Text>
        {modeWord && (
          <Text color={theme.accent} bold>
            {'  '}
            {modeWord}
          </Text>
        )}
        {teamActive && (
          <Text color={theme.toolRunning} bold>
            {'  '}
            {cols >= TEAM_LIMITS.statusCompactCols
              ? `agents ${teamActive.running}/${teamActive.total}`
              : `[${teamActive.running}]`}
          </Text>
        )}
        {retryActive && (
          <Text color={theme.noticeWarn} bold>
            {'  '}
            {formatRetryChip(retryActive, cols)}
          </Text>
        )}
        {todoActive && (
          <Text color={theme.accent}>
            {'  '}
            {cols >= TODO_LIMITS.statusCompactCols
              ? `todo ${todoActive.done}/${todoActive.total}`
              : `[${todoActive.done}/${todoActive.total}]`}
          </Text>
        )}
        {servicesActive && (
          <Text color={theme.accent}>
            {'  '}
            {cols >= PROC_LIMITS.statusCompactCols
              ? `svc ${servicesActive.live}`
              : `[${servicesActive.live}]`}
          </Text>
        )}
        {cols >= 60 && (
          <Text color={theme.muted}>
            {'  '}
            {provider}:{model}
          </Text>
        )}
        {thinkingLevel !== 'off' && cols >= 72 && (
          <Text color={theme.accent}>  think:{thinkingLevel}</Text>
        )}
      </Box>

      <Box flexDirection="row">
        {compactionActive && cols >= COMPACTION_LIMITS.statusCompactCols && (
          <Text color={compactionActive.inFlight ? theme.accent : theme.muted}>
            {compactionActive.inFlight ? 'compacting' : 'compact'}
            {'  '}
          </Text>
        )}
        {fastActive && cols >= FAST_LIMITS.statusCompactCols && (
          <Text color={theme.muted}>
            fast
            {fastActive.inFlight ? '*' : ''}
            {'  '}
          </Text>
        )}
        {ecoRung > 0 && cols >= ECO_MIN_COLS && (
          <Text color={theme.muted}>eco{'  '}</Text>
        )}
        {scrolledLines > 0 && (
          <Text color={theme.noticeWarn}>
            {glyphs.arrowUp}
            {scrolledLines}
            {'  '}
          </Text>
        )}
        {cols >= 60 && (
          <Text>
            <Text color={theme.muted}>[</Text>
            <Text color={gauge.fillColor}>{gauge.filled}</Text>
            <Text color={gauge.trackColor}>{gauge.empty}</Text>
            <Text color={theme.muted}>] </Text>
          </Text>
        )}
        <Text color={theme.muted}>{pctLabel}</Text>
        {cols >= 72 && <Text color={theme.muted}>  {tokens}</Text>}
        <Text color={theme.muted}>  {formatCost(usageTotal.costUsd)}</Text>
        {running && (
          <Text color={theme.muted}>
            {tokPerSec > 0 && cols >= 72 ? `  ${tokPerSec} tok/s` : ''}  {formatDuration(elapsedMs)}
          </Text>
        )}
        {/*
          The keybinding hint cluster that used to live here is GONE (§4.6). It
          duplicated the composer's hint row — on a 110x24 terminal both were on
          screen at once — and its 31 columns are what forced the odd `cols >=
          110` breakpoint and pushed the bar into the character-dropping regime
          described above. The status bar now shows state; the composer shows
          keys. `redrawChar` above is unrelated to the hint and must stay (I-5).
        */}
      </Box>
    </Box>
  );
}
