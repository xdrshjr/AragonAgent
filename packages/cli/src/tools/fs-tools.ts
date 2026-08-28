/**
 * Filesystem tools: read_file / write_file / edit_file / list_dir (spec §3.6).
 *
 * All relative paths resolve against the session cwd (via the injected
 * `getCwd`). Every tool returns `errorResult` on bad input — it never throws.
 * Timeout + 100 KB truncation are owned by the core ToolExecutor (R4); these
 * tools do not re-implement them.
 */

import { promises as fs } from 'node:fs';
import { isAbsolute, join, resolve, dirname } from 'node:path';
import {
  defineTool,
  errorResult,
  textResult,
  type AgentTool,
} from '@aragon-agent/core';
import { renderUnifiedDiff } from './diff.js';
import { PATCH_LIMITS, buildPatch, type FilePatch } from './patch.js';
// TYPE-ONLY, so this module keeps no runtime edge into `proc/`: the field below
// is a PORT, and which implementation fills it is the controller's business.
import type { ProcSupervisorPort } from '../proc/types.js';

export interface ToolDeps {
  getCwd: () => string;
  /**
   * Hand a structured patch to the UI on the CLI-local side channel
   * (agent-activity-presentation §3.3.5).
   *
   * PRE-BOUND TO ITS OWNER by whoever supplies it, so this module never learns
   * what an owner is. OPTIONAL, and omitting it leaves both tools byte-identical
   * to the pre-feature build — including the extra `write_file` stat/read, which
   * is skipped entirely when there is nobody to record for.
   */
  recordChange?: (toolCallId: string, patch: FilePatch) => void;
  /**
   * Hand a raw output chunk to the UI on the CLI-local side channel
   * (agent-activity-presentation-live §3.1).
   *
   * PRE-BOUND TO ITS OWNER, exactly like `recordChange` above, so this module
   * never learns what an owner is. OPTIONAL: omitting it leaves `bash`
   * byte-identical to the pre-feature build -- not one extra allocation, not one
   * extra call (AC-31).
   *
   * ONLY `bash` CALLS IT (D-32). Every other builtin is bounded local I/O that
   * settles in milliseconds, so a progress channel for them would be machinery
   * with no observer. The channel is keyed by tool-call id rather than by tool
   * name, so a future long-running tool costs one call site.
   */
  recordOutput?: (toolCallId: string, chunk: string) => void;
  /**
   * The process supervisor, when background launches are on for this session
   * (background-service-supervision §3.5).
   *
   * THE TWO-INTERFACE RULE ABOVE APPLIES VERBATIM, and this package has already
   * made that mistake twice (`recordChange` in round 1, `recordOutput` in round
   * 2): adding the field HERE alone type-checks and forwards nothing, so `bash`
   * never sees a supervisor, every long-running command runs in the foreground
   * exactly as it does today, and NOTHING ANYWHERE ERRORS. It must be added here
   * AND forwarded in `tools/index.ts`.
   *
   * OPTIONAL: omitting it leaves `bash` byte-identical to the pre-feature build —
   * no `background` property in its schema, no supervisor call, and the
   * pre-feature description string (I-2).
   */
  procs?: ProcSupervisorPort;
}

function resolvePath(cwd: string, p: string): string {
  return isAbsolute(p) ? p : resolve(cwd, p);
}

/** Heuristic binary detection: a NUL byte in the first chunk. */
function looksBinary(buf: Buffer): boolean {
  const scan = buf.subarray(0, Math.min(buf.length, 8000));
  return scan.includes(0);
}

// ---------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------

export function makeReadFile(deps: ToolDeps): AgentTool {
  return defineTool({
    name: 'read_file',
    label: 'Read File',
    description:
      'Read a UTF-8 text file and return its contents as numbered lines. ' +
      'Optionally read a window with `offset` (1-based start line) and `limit` (line count).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path (relative to the working directory or absolute).' },
        offset: { type: 'number', description: '1-based line to start from.' },
        limit: { type: 'number', description: 'Maximum number of lines to return.' },
      },
      required: ['path'],
    },
    async execute(_id, rawParams) {
      const params = rawParams as { path: string; offset?: number; limit?: number };
      const target = resolvePath(deps.getCwd(), params.path);
      try {
        const buf = await fs.readFile(target);
        if (looksBinary(buf)) {
          return errorResult(`File appears to be binary: ${params.path}`);
        }
        const content = buf.toString('utf-8');
        const allLines = content.split('\n');
        const offset = params.offset && params.offset > 0 ? params.offset : 1;
        const start = offset - 1;
        const end =
          params.limit && params.limit > 0 ? start + params.limit : allLines.length;
        const slice = allLines.slice(start, end);
        const numbered = slice
          .map((line, i) => `${String(start + i + 1).padStart(5)}  ${line}`)
          .join('\n');
        return textResult(numbered.length > 0 ? numbered : '(empty file)');
      } catch (err) {
        return errorResult(readError(err, params.path));
      }
    },
  });
}

// ---------------------------------------------------------------------------
// write_file
// ---------------------------------------------------------------------------

export function makeWriteFile(deps: ToolDeps): AgentTool {
  return defineTool({
    name: 'write_file',
    label: 'Write File',
    description:
      'Create or overwrite a file with the given content, creating parent ' +
      'directories as needed. Returns the number of bytes written.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path (relative or absolute).' },
        content: { type: 'string', description: 'Full file content to write.' },
      },
      required: ['path', 'content'],
    },
    async execute(id, rawParams) {
      const params = rawParams as { path: string; content: string };
      const target = resolvePath(deps.getCwd(), params.path);
      try {
        // BEFORE the write, and only when somebody is listening. `readOldSide`
        // swallows every failure itself, so a presentation feature can never
        // prevent or delay the operation it presents (D-14 / R-6).
        const oldSide = deps.recordChange ? await readOldSide(target) : null;
        await fs.mkdir(dirname(target), { recursive: true });
        await fs.writeFile(target, params.content, 'utf-8');
        if (oldSide) recordFileChange(deps, id, oldSide, params.content, params.path);
        const bytes = Buffer.byteLength(params.content, 'utf-8');
        // BYTE-IDENTICAL model-facing text: the diff costs zero extra tokens.
        return textResult(`Wrote ${bytes} bytes to ${params.path}`);
      } catch (err) {
        return errorResult(readError(err, params.path));
      }
    },
  });
}

// ---------------------------------------------------------------------------
// edit_file
// ---------------------------------------------------------------------------

export function makeEditFile(deps: ToolDeps): AgentTool {
  return defineTool({
    name: 'edit_file',
    label: 'Edit File',
    description:
      'Replace an exact string in a file with a new string. Unless ' +
      '`replace_all` is true, `old_string` must occur exactly once. Returns a ' +
      'unified-diff preview of the change.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path (relative or absolute).' },
        old_string: { type: 'string', description: 'Exact text to replace.' },
        new_string: { type: 'string', description: 'Replacement text.' },
        replace_all: {
          type: 'boolean',
          description: 'Replace every occurrence instead of requiring uniqueness.',
        },
      },
      required: ['path', 'old_string', 'new_string'],
    },
    async execute(id, rawParams) {
      const params = rawParams as {
        path: string;
        old_string: string;
        new_string: string;
        replace_all?: boolean;
      };
      const target = resolvePath(deps.getCwd(), params.path);
      try {
        const original = await fs.readFile(target, 'utf-8');
        if (params.old_string === params.new_string) {
          return errorResult('old_string and new_string are identical - nothing to change.');
        }
        const occurrences = countOccurrences(original, params.old_string);
        if (occurrences === 0) {
          return errorResult(`old_string not found in ${params.path}.`);
        }
        if (occurrences > 1 && !params.replace_all) {
          return errorResult(
            `old_string occurs ${occurrences} times in ${params.path}; pass replace_all:true or make it unique.`,
          );
        }
        // Use a function replacer so `$`-patterns (`$&`, `$'`, `` $` ``, `$$`,
        // `$n`) in new_string are inserted literally rather than interpreted by
        // String.prototype.replace. The replace_all branch is already literal.
        const updated = params.replace_all
          ? original.split(params.old_string).join(params.new_string)
          : original.replace(params.old_string, () => params.new_string);
        await fs.writeFile(target, updated, 'utf-8');
        // The same sentence, from the same data: the card's structured patch and
        // the model's text are built from `original` / `updated` by one algorithm
        // at two context widths (D-10 / D-20).
        recordFileChange(deps, id, { text: original }, updated, params.path);
        const diff = renderUnifiedDiff(original, updated, { path: params.path });
        return textResult(`Applied edit to ${params.path}:\n${diff}`);
      } catch (err) {
        return errorResult(readError(err, params.path));
      }
    },
  });
}

// ---------------------------------------------------------------------------
// list_dir
// ---------------------------------------------------------------------------

export function makeListDir(deps: ToolDeps): AgentTool {
  return defineTool({
    name: 'list_dir',
    label: 'List Directory',
    description: 'List entries in a directory with type (dir/file) and size in bytes.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path (default: working directory).' },
      },
    },
    async execute(_id, rawParams) {
      const params = rawParams as { path?: string };
      const dir = resolvePath(deps.getCwd(), params.path ?? '.');
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        if (entries.length === 0) return textResult('(empty directory)');
        const rows = await Promise.all(
          entries
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(async (e) => {
              if (e.isDirectory()) return `dir   ${e.name}/`;
              try {
                const st = await fs.stat(join(dir, e.name));
                return `file  ${e.name}  (${st.size}b)`;
              } catch {
                return `file  ${e.name}`;
              }
            }),
        );
        return textResult(rows.join('\n'));
      } catch (err) {
        return errorResult(readError(err, params.path ?? '.'));
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The old half of a diff, and why it is missing when it is. */
interface OldSide {
  text: string | null;
  degraded?: FilePatch['degraded'];
}

/**
 * Best-effort read of the file `write_file` is about to overwrite.
 *
 * NEVER THROWS AND NEVER REPORTS AN ERROR TO THE MODEL. Every outcome is a
 * `FilePatch` the card can render honestly:
 *
 *   ENOENT              -> null, no reason      -> a `create` diff
 *   size > readMaxBytes -> null, `too-large`    -> an `update` we declined to read
 *   binary sniff fails  -> null, `binary`       -> ditto
 *   any other throw     -> null, `unreadable`   -> ditto
 */
async function readOldSide(target: string): Promise<OldSide> {
  try {
    const stat = await fs.stat(target);
    if (stat.size > PATCH_LIMITS.readMaxBytes) return { text: null, degraded: 'too-large' };
    const buf = await fs.readFile(target);
    if (looksBinary(buf)) return { text: null, degraded: 'binary' };
    return { text: buf.toString('utf-8') };
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return { text: null };
    return { text: null, degraded: 'unreadable' };
  }
}

/**
 * Build and hand over the patch, if anyone asked for one.
 *
 * WRAPPED, because `recordChange` is a caller-supplied closure and a display
 * callback must not be able to fail a write that has already happened.
 * `buildPatch` itself is total.
 */
function recordFileChange(
  deps: ToolDeps,
  toolCallId: string,
  oldSide: OldSide,
  newText: string,
  path: string,
): void {
  if (!deps.recordChange) return;
  try {
    deps.recordChange(
      toolCallId,
      buildPatch(oldSide.text, newText, {
        path,
        context: PATCH_LIMITS.context,
        ...(oldSide.degraded ? { degraded: oldSide.degraded } : {}),
      }),
    );
  } catch {
    // Presentation only. The file is already on disk.
  }
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

function readError(err: unknown, path: string): string {
  const code = (err as { code?: string }).code;
  if (code === 'ENOENT') return `No such file or directory: ${path}`;
  if (code === 'EISDIR') return `Path is a directory: ${path}`;
  if (code === 'EACCES') return `Permission denied: ${path}`;
  return err instanceof Error ? err.message : String(err);
}
