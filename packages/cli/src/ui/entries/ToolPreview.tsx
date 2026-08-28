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
import { PREVIEW_TRUNCATION_MARK, type ToolStatus } from '../../agent/reducer.js';

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

/**
 * The JSON body an `ask_user` result carries after its one human-readable line.
 * Only the fields this preview reads are declared.
 */
interface AskUserPayload {
  answers?: { selected?: unknown; custom?: unknown }[];
  cancelled?: boolean;
}

/**
 * Parse the JSON tail of a tool result whose first line is prose.
 *
 * FAILS SOFT, ALWAYS. This runs inside a render pass, and the stored preview may
 * have been truncated at `STORED_PREVIEW_CHARS` or restored from a session file
 * written by another build. `null` means "fall through to the generic
 * renderer", never "throw while drawing the transcript".
 */
function parseJsonTail(lines: readonly string[]): unknown {
  const start = lines.findIndex((l) => l.trimStart().startsWith('{'));
  if (start < 0) return null;
  try {
    return JSON.parse(lines.slice(start).join('\n'));
  } catch {
    return null;
  }
}

/** `3 questions · Postgres · REST` — or `dismissed`. */
export function summarizeAskUser(lines: readonly string[]): string | null {
  const parsed = parseJsonTail(lines) as AskUserPayload | null;
  if (!parsed || !Array.isArray(parsed.answers)) return null;
  if (parsed.cancelled) return 'dismissed';
  const count = parsed.answers.length;
  const picks = parsed.answers
    .map((a) => (typeof a.custom === 'string' && a.custom.length > 0
      ? a.custom
      : Array.isArray(a.selected) ? a.selected.join('/') : ''))
    .filter((s) => s.length > 0);
  return [`${count} question${count === 1 ? '' : 's'}`, ...picks].join(' - ');
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

/**
 * No `caps` here on purpose. The only glyph this component ever spelled was the
 * preview truncation marker, and that now comes from the constant its producer
 * writes (`PREVIEW_TRUNCATION_MARK`), so there is nothing left to degrade — and
 * a prop no body reads is exactly the kind of dead weight the last round removed.
 */
interface ToolPreviewProps {
  name: string;
  lines: readonly string[];
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

function renderDiff(lines: readonly string[], theme: Theme): React.ReactElement[] {
  return lines.map((line, i) => (
    <Text key={i} color={diffColor(classifyDiffLine(line), theme)}>
      {line.length > 0 ? line : ' '}
    </Text>
  ));
}

function renderWrite(lines: readonly string[], theme: Theme): React.ReactElement[] {
  const parsed = parseWriteFile(lines.join('\n'));
  if (!parsed) return renderPlain(lines, theme, false);
  return [
    <Text key="w" color={theme.diff.add}>
      + wrote {parsed.path} ({parsed.bytes} B)
    </Text>,
  ];
}

function renderRead(lines: readonly string[], theme: Theme): React.ReactElement[] {
  // Numbered lines are `%5d  content`; dim the 7-char gutter, keep content plain.
  return lines.map((line, i) => (
    <Text key={i}>
      <Text color={theme.muted}>{line.slice(0, 7)}</Text>
      {line.slice(7)}
    </Text>
  ));
}

function renderBash(lines: readonly string[], theme: Theme): React.ReactElement[] {
  return lines.map((line, i) => {
    // The truncation marker is compared against the constant the reducer
    // actually writes. These used to be two independently spelled `…` literals;
    // once the producer moved to ASCII, a re-spelled copy here would have
    // stopped matching and quietly lost the dimming.
    const dim =
      line.startsWith('$ ') ||
      BASH_FOOTER_RE.test(line.trimEnd()) ||
      line === PREVIEW_TRUNCATION_MARK;
    return (
      <Text key={i} color={dim ? theme.muted : undefined}>
        {line.length > 0 ? line : ' '}
      </Text>
    );
  });
}

function renderList(lines: readonly string[], theme: Theme): React.ReactElement[] {
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

function renderGlob(lines: readonly string[], theme: Theme): React.ReactElement[] {
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

function renderAskUser(lines: readonly string[], theme: Theme): React.ReactElement[] {
  const summary = summarizeAskUser(lines);
  // An unparseable preview falls through to the generic renderer rather than
  // rendering nothing: a truncated result is still information.
  if (!summary) return renderPlain(lines, theme, false);
  return [
    <Text key="q" color={theme.muted}>
      {summary}
    </Text>,
  ];
}

/**
 * `Plan approved.` / `Plan rejected. ...` — the verdict is the whole content of
 * a `submit_plan` result, and it is the first line, so this needs no parsing.
 */
function renderSubmitPlan(lines: readonly string[], theme: Theme): React.ReactElement[] {
  const first = lines.find((l) => l.trim().length > 0) ?? '';
  const approved = /^Plan approved/.test(first);
  const rejected = /^Plan rejected/.test(first);
  if (!approved && !rejected) return renderPlain(lines, theme, false);
  return [
    <Text key="v" color={approved ? theme.toolDone : theme.noticeWarn}>
      {first}
    </Text>,
  ];
}

function renderPlain(lines: readonly string[], theme: Theme, error?: boolean): React.ReactElement[] {
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
    case 'ask_user':
      body = renderAskUser(lines, theme);
      break;
    case 'submit_plan':
      body = renderSubmitPlan(lines, theme);
      break;
    default:
      body = renderPlain(lines, theme, isError);
  }
  return <Box flexDirection="column">{body}</Box>;
}
