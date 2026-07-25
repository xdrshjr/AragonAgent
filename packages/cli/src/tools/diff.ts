/**
 * Minimal unified-diff renderer for `edit_file` previews (spec §4).
 *
 * Not a full Myers diff: it trims the common leading/trailing lines and renders
 * the differing middle as removed (`-`) / added (`+`) blocks with a small
 * amount of surrounding context. That is enough for a legible edit preview
 * without pulling in a diff dependency.
 */

const CONTEXT_LINES = 2;

export interface DiffOptions {
  /** File path shown in the `---`/`+++` header. */
  path?: string;
  /** Context lines around the change (default 2). */
  context?: number;
}

export function renderUnifiedDiff(
  oldStr: string,
  newStr: string,
  options: DiffOptions = {},
): string {
  const context = options.context ?? CONTEXT_LINES;
  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');

  // Common leading lines.
  let start = 0;
  const maxStart = Math.min(oldLines.length, newLines.length);
  while (start < maxStart && oldLines[start] === newLines[start]) start += 1;

  // Common trailing lines (not overlapping the common prefix).
  let endOld = oldLines.length - 1;
  let endNew = newLines.length - 1;
  while (
    endOld >= start &&
    endNew >= start &&
    oldLines[endOld] === newLines[endNew]
  ) {
    endOld -= 1;
    endNew -= 1;
  }

  const header = options.path
    ? [`--- ${options.path}`, `+++ ${options.path}`]
    : [];

  const lines: string[] = [];

  const ctxStart = Math.max(0, start - context);
  for (let i = ctxStart; i < start; i += 1) {
    lines.push(`  ${oldLines[i]}`);
  }
  for (let i = start; i <= endOld; i += 1) {
    lines.push(`- ${oldLines[i]}`);
  }
  for (let i = start; i <= endNew; i += 1) {
    lines.push(`+ ${newLines[i]}`);
  }
  const ctxEnd = Math.min(oldLines.length - 1, endOld + context);
  for (let i = endOld + 1; i <= ctxEnd; i += 1) {
    lines.push(`  ${oldLines[i]}`);
  }

  if (lines.length === 0) {
    return `${header.join('\n')}${header.length ? '\n' : ''}(no textual change)`;
  }

  return [...header, ...lines].join('\n');
}
