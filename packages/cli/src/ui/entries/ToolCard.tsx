/**
 * Tool-call card (spec §3.5): a per-tool glyph, the tool name, a compact args
 * summary, a colored status badge, and a duration, over a collapsible rich
 * preview delegated to `<ToolPreview>`. Collapsed to the first 8 lines with a
 * `+M lines (Ctrl+O)` footer; `Ctrl+O` / `/expand` toggle the full preview.
 *
 * Two v0.4.0 changes (§4.1 / §4.3):
 *  - capabilities arrive as a prop. This used to infer Unicode support by
 *    comparing `theme.symbols.gaugeFull` against a literal block character, so
 *    editing an unrelated gauge glyph would have silently sent every tool icon
 *    back to ASCII;
 *  - the preview's round border is gone. It cost 2 rows and 4 columns per card,
 *    and nested visibly inside markdown code blocks. A left rail carries the
 *    same grouping in 1 column and 0 rows.
 */

import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type { Theme } from '../theme.js';
import type { TermCapabilities } from '../capabilities.js';
import { pickGlyphs, toolGlyph } from '../glyphs.js';
import { railBorderProps } from '../layout/Gutter.js';
import { formatDuration } from '../../agent/usage.js';
import type { ToolStatus } from '../../agent/reducer.js';
import { ToolPreview, bashBadge } from './ToolPreview.js';

/** Number of preview lines shown before collapse. */
const COLLAPSED_LINES = 8;

interface ToolCardProps {
  name: string;
  label: string;
  argsRaw: string;
  args?: Record<string, unknown>;
  status: ToolStatus;
  preview?: string;
  durationMs?: number;
  isError?: boolean;
  expanded?: boolean;
  reducedMotion?: boolean;
  theme: Theme;
  caps: TermCapabilities;
}

export function statusColor(status: ToolStatus, theme: Theme): string | undefined {
  switch (status) {
    case 'pending':
      return theme.toolPending;
    case 'running':
      return theme.toolRunning;
    case 'done':
      return theme.toolDone;
    case 'error':
      return theme.toolError;
  }
}

/** One-line summary of the tool arguments for the card header. */
function summarizeArgs(
  name: string,
  ellipsis: string,
  args?: Record<string, unknown>,
  argsRaw?: string,
): string {
  if (args) {
    if (name === 'bash' && typeof args.command === 'string') return args.command;
    if (typeof args.path === 'string') return args.path;
    if (typeof args.pattern === 'string') return args.pattern;
    const keys = Object.keys(args);
    if (keys.length > 0) return keys.map((k) => `${k}=${short(args[k], ellipsis)}`).join(' ');
  }
  return (argsRaw ?? '').slice(0, 60);
}

function short(v: unknown, ellipsis: string): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 40 ? `${s.slice(0, 40)}${ellipsis}` : s;
}

/** The badge label shown to the right of the tool name. */
function badgeLabel(name: string, status: ToolStatus, preview: string): string {
  if (name === 'bash' && (status === 'done' || status === 'error')) {
    return bashBadge(status, preview).text;
  }
  switch (status) {
    case 'pending':
      return 'queued';
    case 'running':
      return 'running';
    case 'done':
      return 'done';
    case 'error':
      return 'failed';
  }
}

/** The tool's own glyph, used by `EntryView` as the entry's rail marker. */
export function toolEntryGlyph(name: string, caps: TermCapabilities): string {
  return toolGlyph(pickGlyphs(caps), name);
}

export function ToolCard(props: ToolCardProps): React.ReactElement {
  const {
    name,
    argsRaw,
    args,
    status,
    preview,
    durationMs,
    isError,
    expanded,
    reducedMotion,
    theme,
    caps,
  } = props;
  const glyphs = pickGlyphs(caps);
  const color = statusColor(status, theme);
  const previewText = preview ?? '';
  const previewLines = previewText.length > 0 ? previewText.split('\n') : [];
  const visibleLines = expanded ? previewLines : previewLines.slice(0, COLLAPSED_LINES);
  const hidden = previewLines.length - visibleLines.length;
  const showBody = previewLines.length > 0 && (status === 'done' || status === 'error');

  const badge =
    status === 'running' && !reducedMotion && caps.unicode ? (
      <Text color={color}>
        <Spinner type="dots" /> running
      </Text>
    ) : (
      <Text color={color}>
        {status === 'running' ? `${glyphs.spinnerStill} ` : ''}
        {badgeLabel(name, status, previewText)}
      </Text>
    );

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color={theme.accent} bold>
          {name}
        </Text>
        <Text color={theme.muted}> {summarizeArgs(name, glyphs.ellipsis, args, argsRaw)}  </Text>
        {badge}
        {durationMs !== undefined && (
          <Text color={theme.muted}> ({formatDuration(durationMs)})</Text>
        )}
      </Box>
      {showBody && (
        <Box
          flexDirection="column"
          flexShrink={0}
          paddingLeft={1}
          {...railBorderProps(glyphs.railVertical, isError ? theme.toolError : theme.border)}
        >
          <ToolPreview name={name} lines={visibleLines} theme={theme} isError={isError} />
          {!expanded && hidden > 0 && (
            <Text color={theme.muted}>
              +{hidden} {hidden === 1 ? 'line' : 'lines'} (Ctrl+O)
            </Text>
          )}
          {expanded && previewLines.length > COLLAPSED_LINES && (
            <Text color={theme.muted}>(Ctrl+O to collapse)</Text>
          )}
        </Box>
      )}
    </Box>
  );
}
