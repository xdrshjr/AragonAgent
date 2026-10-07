/** A single row of complete, measured status fields. */
import React from 'react';
import { Box, Text, useStdout } from 'ink';
import type { Theme } from './theme.js';
import type { TermCapabilities } from './capabilities.js';
import { pickGlyphs } from './glyphs.js';
import type { UsageTotal } from '../agent/reducer.js';
import type { ContextUsageSnapshot } from '../compaction/types.js';
import type { AgentMode } from '../agent/agent-mode.js';
import type { PendingSteering } from '../agent/queued-messages.js';
import { liveSpinner } from './ActivityLine.js';
import { planStatusFields, type RunPhase } from './layout/status-layout.js';

export interface StatusBarProps {
  runPhase?: RunPhase;
  activeTool?: { name: string; toolCallId: string } | null;
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
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const phase = props.runPhase ?? (props.status === 'running' ? 'waiting' : 'idle');
  const active = phase !== 'idle' || !!props.compactionActive?.inFlight;
  const glyph = pickGlyphs(props.caps).spinnerStill;
  const spinner = active ? liveSpinner(props.reducedMotion ?? false, props.caps) : null;
  const fields = planStatusFields({
    columns: cols, phase, pendingCount: props.pendingSteering?.length ?? 0,
    context: props.context, usageTotal: props.usageTotal,
    thinkingLevel: props.thinkingLevel, elapsedMs: props.elapsedMs, tokPerSec: props.tokPerSec,
    activeTool: props.activeTool, runOutcome: props.runOutcome, spinner: active ? glyph : '',
    waitingForConfirmation: props.waitingForConfirmation, stopping: props.stopping,
    compacting: props.compactionActive?.inFlight, retryActive: props.retryActive,
    mode: props.agentMode, pendingMode: props.pendingAgentMode, servicesActive: props.servicesActive,
    teamActive: props.teamActive, todoActive: props.todoActive,
    ecoRung: props.ecoRung, fastActive: props.fastActive, scrolledLines: props.scrolledLines,
  });
  const tones = { normal: props.theme.primary, muted: props.theme.muted,
    warning: props.theme.noticeWarn, error: props.theme.noticeError };
  return <Box width={cols} height={1} flexShrink={0} flexDirection="row">
    <Box width={1} flexShrink={0}><Text>{redrawChar(props.redrawNonce ?? 0)}</Text></Box>
    {fields.map((item, index) => <React.Fragment key={item.id}>
      {index > 0 && <Box width={3} flexShrink={0}><Text color={props.theme.muted}> | </Text></Box>}
      <Box width={item.cells} flexShrink={0}>
        <Text color={tones[item.tone]}>
          {item.id === 'phase' && active
            ? <>{spinner ?? glyph}{item.text.slice(glyph.length)}</>
            : item.text}
        </Text>
      </Box>
    </React.Fragment>)}
  </Box>;
}
