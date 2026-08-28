/**
 * The MODEL-FACING unified diff for `edit_file` (spec §4), re-expressed on top
 * of `buildPatch` (agent-activity-presentation §3.3.4).
 *
 * The signature, the call site (`fs-tools.ts`), the `---` / `+++` headers and the
 * `  ` / `- ` / `+ ` row prefixes are all unchanged; what changed is that the
 * differing middle is now a real hunk list instead of one removed block followed
 * by one added block. For a `replace_all` touching line 40 and line 900 that used
 * to be 860 removed rows and 860 near-identical added rows.
 *
 * TWO WIDTHS, ONE ALGORITHM (D-20). This renderer keeps `CONTEXT_LINES = 2`; the
 * UI passes `PATCH_LIMITS.context` (3). Collapsing them to one constant is the
 * tempting simplification and it is wrong: `fs-tools.ts` passes no override, so a
 * shared 3 would add two context rows to EVERY model-facing diff — the direction
 * AC-17 forbids, in the most common case, with nothing watching.
 *
 * The shape of the change to the model's input is therefore exact: a
 * single-region edit is today's rows plus ONE `@@` header, a multi-region edit is
 * strictly smaller, and a trailing `\r` no longer reaches the prompt.
 */

import { PATCH_LIMITS, buildPatch, type FilePatch, type PatchLine } from './patch.js';

const CONTEXT_LINES = 2;

/** Appended when the rendered text hits `PATCH_LIMITS.modelDiffMaxChars`. */
const DIFF_TRUNCATED_NOTE = '... (diff truncated)';

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
  const patch = buildPatch(oldStr, newStr, {
    path: options.path ?? '',
    context: options.context ?? CONTEXT_LINES,
  });
  return renderPatchText(patch, options.path);
}

/**
 * A `FilePatch` as unified-diff text.
 *
 * Exported so the patch the user reads and the diff the model reads are provably
 * the same change (D-10), and so `patch.test.ts` can assert the round trip.
 */
export function renderPatchText(patch: FilePatch, path?: string): string {
  const header = path ? [`--- ${path}`, `+++ ${path}`] : [];
  if (patch.hunks.length === 0) {
    return `${header.join('\n')}${header.length ? '\n' : ''}(no textual change)`;
  }

  const lines: string[] = [...header];
  for (const hunk of patch.hunks) {
    lines.push(
      `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`,
    );
    for (const line of hunk.lines) lines.push(`${signOf(line)}${line.text}`);
  }
  if (patch.truncated) lines.push(DIFF_TRUNCATED_NOTE);

  return clampToBudget(lines);
}

function signOf(line: PatchLine): string {
  if (line.kind === 'add') return '+ ';
  if (line.kind === 'del') return '- ';
  return '  ';
}

/**
 * Cap the rendered text at `modelDiffMaxChars`.
 *
 * Whole rows, not a mid-row slice: half a diff line reaching the model reads as
 * a real line that happens to be wrong, which is worse than an honestly short
 * diff. `edit_file`'s result had no bound at all before this round beyond the
 * executor's 100 KB backstop.
 */
function clampToBudget(lines: string[]): string {
  const kept: string[] = [];
  let size = 0;
  for (const line of lines) {
    const next = size + line.length + 1;
    if (kept.length > 0 && next > PATCH_LIMITS.modelDiffMaxChars) {
      kept.push(DIFF_TRUNCATED_NOTE);
      break;
    }
    kept.push(line);
    size = next;
  }
  return kept.join('\n');
}
