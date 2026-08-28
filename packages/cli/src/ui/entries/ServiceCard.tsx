/**
 * ServiceCard — one supervised background service in the transcript
 * (background-service-supervision §3.8).
 *
 * ASCII ONLY: every glyph comes from `pickGlyphs`. `ui/` is inside
 * `glyphs.test.ts::inScope`, so a literal here fails the scan.
 *
 * NO ANIMATED SPINNER, IN ANY STATE (D-14 / P2-7). That is STRICTER than
 * `single-spinner-while-running` D-1, which suppresses animation only while the
 * activity line is mounted — and a service can sit at `starting` while the agent
 * is IDLE, where D-1's "one owner on screen" argument does not reach because
 * there is no owner on screen. A card that animated only when the agent happened
 * to be idle would be the worst of both. It uses `glyphs.spinnerStill`
 * throughout and still accepts `reducedMotion` for consistency with
 * `EntryView`'s comparator.
 *
 * TWO SHAPES, ONE COMPONENT. `terminal: true` is the one-row record a service's
 * exit appends (D-11); everything else is the live card. They share a component
 * because they share a colour ladder and a status vocabulary, and splitting them
 * would be two places to keep those in step.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { Theme } from '../theme.js';
import type { TermCapabilities } from '../capabilities.js';
import { pickGlyphs } from '../glyphs.js';
import { railBorderProps } from '../layout/Gutter.js';
import { formatDuration } from '../../agent/usage.js';
import type { ServiceStatus } from '../../proc/types.js';

/** Tail rows the collapsed card draws. Mirrored as a NUMBER in `virtual-window.ts`. */
const COLLAPSED_TAIL_ROWS = 2;
/** Tail rows the expanded card draws — the snapshot's own cap. */
const EXPANDED_TAIL_ROWS = 8;

export interface ServiceCardProps {
  serviceId: string;
  command: string;
  status: ServiceStatus;
  url?: string;
  port?: number;
  exitCode: number | null;
  startedAt: number;
  readyAt?: number;
  endedAt?: number;
  rows: readonly string[];
  /** The one-row record a terminal transition appends. */
  terminal?: boolean;
  killIncomplete?: boolean;
  expanded?: boolean;
  /** Accepted for comparator consistency; this card never animates (D-14). */
  reducedMotion?: boolean;
  theme: Theme;
  caps: TermCapabilities;
}

/**
 * The card's colour.
 *
 * `running` is `toolRunning` rather than the accent: it is alive and listening
 * on nothing, which is a real third state and not a lesser `ready`. A clean
 * `exited(0)` is muted, because a command that finished on purpose is not a
 * failure.
 */
export function serviceCardColor(
  props: Pick<ServiceCardProps, 'status' | 'exitCode'>,
  theme: Theme,
): string | undefined {
  switch (props.status) {
    case 'starting':
      return theme.muted;
    case 'ready':
      return theme.accent;
    case 'running':
      return theme.toolRunning;
    case 'failed':
      return theme.toolError;
    case 'exited':
      return props.exitCode === 0 ? theme.muted : theme.toolError;
    case 'stopped':
      return theme.muted;
    default:
      return theme.muted;
  }
}

/** The status glyph, by the same ladder as the colour. */
export function serviceGlyph(
  props: Pick<ServiceCardProps, 'status' | 'exitCode'>,
  glyphs: ReturnType<typeof pickGlyphs>,
): string {
  switch (props.status) {
    case 'starting':
      return glyphs.toolPending;
    case 'ready':
      return glyphs.toolDone;
    case 'running':
      return glyphs.toolRunning;
    case 'failed':
      return glyphs.toolError;
    case 'exited':
      return props.exitCode === 0 ? glyphs.toolDone : glyphs.toolError;
    case 'stopped':
      return glyphs.toolPending;
    default:
      return glyphs.toolPending;
  }
}

/** The right-hand status clause: what happened, and how long it took. */
function statusClause(props: ServiceCardProps, dot: string): string {
  const { status, exitCode, startedAt, readyAt, endedAt } = props;
  if (status === 'ready') {
    const took = readyAt === undefined ? '' : `${dot}${formatDuration(readyAt - startedAt)}`;
    return `ready${took}`;
  }
  if (status === 'running') return 'running';
  if (status === 'starting') return 'starting';
  const lived = endedAt === undefined ? '' : `${dot}${formatDuration(endedAt - startedAt)}`;
  if (status === 'stopped') return `stopped${lived}`;
  if (status === 'failed') return `failed${lived}`;
  return `exited${exitCode === null ? '' : ` code ${exitCode}`}${lived}`;
}

function ServiceCardImpl(props: ServiceCardProps): React.ReactElement {
  const { serviceId, command, url, rows, expanded, terminal, theme, caps } = props;
  const glyphs = pickGlyphs(caps);
  const color = serviceCardColor(props, theme);
  const dot = `  ${glyphs.midDot}  `;
  const clause = statusClause(props, dot);

  // THE TERMINAL RECORD IS ONE ROW, ALWAYS. It is a SECOND event at a SECOND
  // time — the only thing `<Static>` permits once the live card is printed — so
  // it names what happened and nothing else (D-11).
  if (terminal) {
    return (
      <Box flexDirection="row">
        <Text color={color} wrap="truncate">
          service {serviceId} {clause}
          {props.killIncomplete ? ' (may have left a detached child)' : ''}
        </Text>
      </Box>
    );
  }

  const shown = rows.slice(-(expanded ? EXPANDED_TAIL_ROWS : COLLAPSED_TAIL_ROWS));

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color={theme.accent} bold>
          service {serviceId}
        </Text>
        <Text color={theme.muted} wrap="truncate">
          {'  '}
          {command}
        </Text>
        <Text color={color} wrap="truncate">
          {dot}
          {clause}
        </Text>
      </Box>

      {url !== undefined && (
        <Box flexDirection="row" flexShrink={0} paddingLeft={1}>
          <Text color={theme.primary}>{url}</Text>
          <Text color={theme.muted}>
            {dot}ctrl+c stop{dot}ctrl+o log
          </Text>
        </Box>
      )}

      {shown.length > 0 && (
        <Box
          flexDirection="column"
          flexShrink={0}
          paddingLeft={1}
          {...railBorderProps(glyphs.railVertical, theme.border)}
        >
          {shown.map((line, index) => (
            <Text key={index} color={theme.muted} wrap="truncate">
              {line}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}

/**
 * `React.memo` with the DEFAULT comparator (tui-render-performance L2 / R3).
 * `mapEntry` already preserves object identity for untouched entries, so the
 * props below are stable references on a settled card, and `theme` / `caps` are
 * `useMemo`d in `App.tsx` (I-L2-1).
 */
export const ServiceCard = React.memo(ServiceCardImpl);
