/**
 * Per-tool rich preview (spec §3.5). Selects a renderer by tool name: colored
 * unified diffs (`edit_file`), a byte/path summary (`write_file`), a dimmed
 * line-number gutter (`read_file`), a status-authoritative exit badge with a
 * best-effort footer parse (`bash`), a dir/file/size listing (`list_dir`), a
 * flat path list (`glob`), and a plain fallback (`grep` / default).
 *
 * The classification helpers are pure and exported so they are unit-testable
 * without Ink.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { Theme } from '../theme.js';
import type { ToolStatus } from '../../agent/reducer.js';

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in tool-preview.test.ts)
// ---------------------------------------------------------------------------

export type DiffClass = 'add' | 'remove' | 'meta' | 'context';

/**
 * Classify a unified-diff line. Meta prefixes (`@@`, `---`, `+++`) are tested
 * FIRST so a `--- path` header is not mis-read as a single-char removal (P2-8);
 * the `Applied edit to <path>:` lead-in falls through to `context`.
 */
export function classifyDiffLine(line: string): DiffClass {
  if (line.startsWith('@@') || line.startsWith('---') || line.startsWith('+++')) return 'meta';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'remove';
  return 'context';
}

const BASH_FOOTER_RE = /^\[(?:exit code (\d+)|signal (\w+))\]$/;

/**
 * Derive the bash badge. The exit status is authoritative (the tool returns an
 * error result iff the exit code is non-zero), so the label is `exit 0` /
 * `failed` from `status`; a real `[exit code N]` / `[signal X]` last line is
 * parsed best-effort for the exact number, falling back to the status label
 * when the footer was truncated out of the stored preview (P1-2).
 */
export function bashBadge(status: ToolStatus, preview: string): { text: string; ok: boolean } {
  const ok = status === 'done';
  const lines = preview.split('\n').map((l) => l.trimEnd()).filter((l) => l.length > 0);
  const last = lines[lines.length - 1] ?? '';
  const m = BASH_FOOTER_RE.exec(last);
  if (m) {
    if (m[1] !== undefined) return { text: `exit ${m[1]}`, ok };
    return { text: `signal ${m[2]}`, ok };
  }
  return { text: ok ? 'exit 0' : status === 'error' ? 'failed' : 'pending', ok };
}

const WRITE_RE = /^Wrote (\d+) bytes to (.+)$/;

/** Parse the real `Wrote <n> bytes to <path>` result — bytes+path only (P2-7). */
export function parseWriteFile(text: string): { bytes: number; path: string } | null {
  const line = text.split('\n').find((l) => l.trim().length > 0) ?? '';
  const m = WRITE_RE.exec(line.trim());
  if (!m) return null;
  return { bytes: Number.parseInt(m[1]!, 10), path: m[2]! };
}

export interface ListRow {
  kind: 'dir' | 'file';
  name: string;
  size?: string;
}

/** Parse a real `list_dir` row (`dir <name>/` / `file <name> (<n>b)`) (P2-9). */
export function parseListRow(line: string): ListRow | null {
  const dir = /^dir\s+(.*?)\/?\s*$/.exec(line);
  if (dir) return { kind: 'dir', name: dir[1]!.trimEnd() };
  const file = /^file\s+(.*?)(?:\s+\((\d+b)\))?\s*$/.exec(line);
  if (file) return { kind: 'file', name: file[1]!.trimEnd(), size: file[2] };
  return null;
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

interface ToolPreviewProps {
  name: string;
  lines: string[];
  theme: Theme;
  isError?: boolean;
}

function diffColor(cls: DiffClass, theme: Theme): string | undefined {
  switch (cls) {
    case 'add':
      return theme.diff.add;
    case 'remove':
      return theme.diff.remove;
    case 'meta':
      return theme.diff.meta;
    case 'context':
      return theme.diff.context;
  }
}

function renderDiff(lines: string[], theme: Theme): React.ReactElement[] {
  return lines.map((line, i) => (
    <Text key={i} color={diffColor(classifyDiffLine(line), theme)}>
      {line.length > 0 ? line : ' '}
    </Text>
  ));
}

function renderWrite(lines: string[], theme: Theme): React.ReactElement[] {
  const parsed = parseWriteFile(lines.join('\n'));
  if (!parsed) return renderPlain(lines, theme, false);
  return [
    <Text key="w" color={theme.diff.add}>
      + wrote {parsed.path} ({parsed.bytes} B)
    </Text>,
  ];
}

function renderRead(lines: string[], theme: Theme): React.ReactElement[] {
  // Numbered lines are `%5d  content`; dim the 7-char gutter, keep content plain.
  return lines.map((line, i) => (
    <Text key={i}>
      <Text color={theme.muted}>{line.slice(0, 7)}</Text>
      {line.slice(7)}
    </Text>
  ));
}

function renderBash(lines: string[], theme: Theme): React.ReactElement[] {
  return lines.map((line, i) => {
    const dim = line.startsWith('$ ') || BASH_FOOTER_RE.test(line.trimEnd()) || line === '…';
    return (
      <Text key={i} color={dim ? theme.muted : undefined}>
        {line.length > 0 ? line : ' '}
      </Text>
    );
  });
}

function renderList(lines: string[], theme: Theme): React.ReactElement[] {
  return lines.map((line, i) => {
    const row = parseListRow(line);
    if (!row) return <Text key={i}>{line}</Text>;
    if (row.kind === 'dir') {
      return (
        <Text key={i}>
          <Text color={theme.accent}>{row.name}/</Text>
        </Text>
      );
    }
    return (
      <Text key={i}>
        {row.name}
        {row.size ? <Text color={theme.muted}> ({row.size})</Text> : null}
      </Text>
    );
  });
}

function renderGlob(lines: string[], theme: Theme): React.ReactElement[] {
  // Flat relative paths — dim the directory portion of each path.
  return lines.map((line, i) => {
    const slash = line.lastIndexOf('/');
    if (slash < 0) return <Text key={i}>{line}</Text>;
    return (
      <Text key={i}>
        <Text color={theme.muted}>{line.slice(0, slash + 1)}</Text>
        {line.slice(slash + 1)}
      </Text>
    );
  });
}

function renderPlain(lines: string[], theme: Theme, error?: boolean): React.ReactElement[] {
  return lines.map((line, i) => (
    <Text key={i} color={error ? theme.toolError : theme.muted}>
      {line.length > 0 ? line : ' '}
    </Text>
  ));
}

export function ToolPreview({ name, lines, theme, isError }: ToolPreviewProps): React.ReactElement {
  let body: React.ReactElement[];
  switch (name) {
    case 'edit_file':
      body = renderDiff(lines, theme);
      break;
    case 'write_file':
      body = renderWrite(lines, theme);
      break;
    case 'read_file':
      body = renderRead(lines, theme);
      break;
    case 'bash':
      body = renderBash(lines, theme);
      break;
    case 'list_dir':
      body = renderList(lines, theme);
      break;
    case 'glob':
      body = renderGlob(lines, theme);
      break;
    default:
      body = renderPlain(lines, theme, isError);
  }
  return <Box flexDirection="column">{body}</Box>;
}
