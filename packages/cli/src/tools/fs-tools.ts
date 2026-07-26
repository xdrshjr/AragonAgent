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
} from '@argon-agent/core';
import { renderUnifiedDiff } from './diff.js';

export interface ToolDeps {
  getCwd: () => string;
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
    async execute(_id, rawParams) {
      const params = rawParams as { path: string; content: string };
      const target = resolvePath(deps.getCwd(), params.path);
      try {
        await fs.mkdir(dirname(target), { recursive: true });
        await fs.writeFile(target, params.content, 'utf-8');
        const bytes = Buffer.byteLength(params.content, 'utf-8');
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
    async execute(_id, rawParams) {
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
