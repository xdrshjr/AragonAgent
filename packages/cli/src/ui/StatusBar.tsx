/** A single row of complete, measured status fields. */
import React from 'react';
import { Box, Text } from 'ink';
import type { Theme } from './theme.js';
import type { TermCapabilities } from './capabilities.js';
import { pickGlyphs } from './glyphs.js';
import type { UsageTotal } from '../agent/reducer.js';
import type { ContextUsageSnapshot } from '../compaction/types.js';
import type { AgentMode } from '../agent/agent-mode.js';
import type { PendingSteering } from '../agent/queued-messages.js';
import { liveSpinner } from './ActivityLine.js';
import { planPrimaryStatusFields, type RunPhase } from './layout/status-layout.js';
import { planSessionChip } from './layout/session-chip.js';
import { planKitChip } from './layout/kit-chip.js';
import type { EscapeAction, StatusFeedback } from './status-feedback.js';

export interface StatusBarProps {
  columns: number;
  speedKnown: boolean;
  feedback?: StatusFeedback;
  escapeAction?: EscapeAction;
  interruptPhase?: 'ready' | 'armed' | 'stopping';
  runPhase?: RunPhase;
  activeTool?: { name: string; toolCallId: string } | null;
  /** A bounded wait in flight; replaces the `Running job_wait` label (§4.9). */
  wait?: { jobId: string; upToSeconds: number };
  runOutcome?: "none" | "ended" | "interrupted" | "failed";
  reducedMotion?: boolean;
  waitingForConfirmation?: boolean;
  stopping?: boolean;
  pendingSteering?: readonly PendingSteering[];
  interruptHint?: string;
  model: string;
  provider: string;
  usageTotal: UsageTotal;
  context: ContextUsageSnapshot;
  status: 'idle' | 'running';
  elapsedMs: number;
  thinkingLevel: string;
  tokPerSec: number;
  theme: Theme;
  caps: TermCapabilities;
  scrolledLines?: number;
  redrawNonce?: number;
  /**
   * This session's id, rendered at the right end of the primary row
   * (tui-session-id-resume D-11 / D-12).
   *
   * OPTIONAL AND ABSENT BY DEFAULT, so a build without the feature and every
   * existing test render exactly what they rendered before (I-6).
   */
  sessionId?: string;
  /**
   * The agent kit in effect, or absent when there is none (agent-model-kits
   * §4.8 / D-12).
   *
   * OPTIONAL AND ABSENT BY DEFAULT, for the same reason `sessionId` is: with no
   * kit the plan is hidden, `kitCells` is 0, and this row's output is
   * byte-identical to the pre-feature build (I-9).
   */
  kit?: { name: string; modified: boolean; otherNames: readonly string[] } | null;

  agentMode?: AgentMode;
  pendingAgentMode?: AgentMode | null;
  teamActive?: { running: number; total: number };
  todoActive?: { done: number; total: number };
  servicesActive?: { live: number };
  retryActive?: { attempt: number; max: number; secondsLeft: number };
  ecoRung?: number;
  fastActive?: { inFlight: boolean };
  compactionActive?: { inFlight: boolean };
  gaugeMarks?: { warn: number; high: number };
}


/** An invisible leading byte change forces Ink to repaint on Ctrl+L. */
const redrawChar = (nonce: number): string => nonce % 2 ? String.fromCharCode(0x00a0) : ' ';

export function StatusBar(props: StatusBarProps): React.ReactElement {
  const cols = props.columns;
  const phase = props.runPhase ?? (props.status === 'running' ? 'waiting' : 'idle');
  const active = phase !== 'idle' || !!props.compactionActive?.inFlight;
  const glyph = pickGlyphs(props.caps).spinnerStill;
  const spinner = active ? liveSpinner(props.reducedMotion ?? false, props.caps) : null;
  // THE CHIP IS PLANNED FIRST, and the plan then feeds the field budget: the two
  // cannot disagree about how wide the terminal is if only one of them is asked.
  const chip = planSessionChip({
    columns: cols,
    ...(props.sessionId ? { sessionId: props.sessionId } : {}),
  });
  const chipCells = chip.visible ? chip.cells + chip.gap : 0;
  // THE KIT CHIP IS PLANNED SECOND, OUT OF WHAT THE SESSION CHIP LEFT (D-12):
  // the session id is never truncated, so it is not the thing that gives way.
  // With no kit the plan is hidden and `kitCells` is 0, which keeps this row
  // byte-identical to the build before the feature (I-9).
  const kit = planKitChip({ columns: cols - chipCells, kit: props.kit });
  const kitCells = kit.visible ? kit.cells + kit.gap : 0;
  const plan = planPrimaryStatusFields({
    reserveRight: chipCells + kitCells,
    columns: cols, phase, pendingCount: props.pendingSteering?.length ?? 0,
    context: props.context, usageTotal: props.usageTotal,
    thinkingLevel: props.thinkingLevel, elapsedMs: props.elapsedMs, tokPerSec: props.tokPerSec,
    activeTool: props.activeTool, runOutcome: props.runOutcome, spinner: glyph,
    ...(props.wait ? { wait: props.wait } : {}),
    speedKnown: props.speedKnown, feedback: props.feedback, escapeAction: props.escapeAction,
    interruptPhase: props.interruptPhase,
    waitingForConfirmation: props.waitingForConfirmation, stopping: props.stopping,
    compacting: props.compactionActive?.inFlight, retryActive: props.retryActive,
    mode: props.agentMode, pendingMode: props.pendingAgentMode, servicesActive: props.servicesActive,
    teamActive: props.teamActive, todoActive: props.todoActive,
    ecoRung: props.ecoRung, fastActive: props.fastActive, scrolledLines: props.scrolledLines,
  });
  const tones = { normal: props.theme.primary, muted: props.theme.muted,
    warning: props.theme.noticeWarn, error: props.theme.noticeError,
    accent: props.theme.accent };
  return <Box width={cols} height={1} flexShrink={0} flexDirection="row" overflow="hidden">
    <Box width={1} flexShrink={0}><Text>{redrawChar(props.redrawNonce ?? 0)}</Text></Box>
    {/* THE FIELD RUN IS ONE FIXED-WIDTH BOX, so the chips beside it can be
        right-aligned without flexGrow and without re-measuring the row. */}
    <Box width={Math.max(0, cols - 1 - chipCells - kitCells)} flexShrink={0} flexDirection="row" overflow="hidden">
    {plan.fields.map((item, index) => <React.Fragment key={item.id}>
      {index > 0 && <Box width={plan.separatorCells} flexShrink={0}><Text color={props.theme.muted}>{plan.separator}</Text></Box>}
      <Box width={item.cells} flexShrink={0}>
        <Text color={tones[item.tone]} wrap="truncate">
          {item.id === 'phase' && active
            ? <>{spinner ?? glyph}{item.text.slice(glyph.length)}</>
            : item.text}
        </Text>
      </Box>
    </React.Fragment>)}
    </Box>
    {kit.visible && <Box width={kitCells} flexShrink={0} justifyContent="flex-end"
      overflow="hidden">
      <Text color={props.theme.muted} wrap="truncate">{kit.text}</Text>
    </Box>}
    {chip.visible && <Box width={chipCells} flexShrink={0} justifyContent="flex-end"
      overflow="hidden">
      <Text color={props.theme.muted} wrap="truncate">{chip.text}</Text>
    </Box>}
  </Box>;
}
