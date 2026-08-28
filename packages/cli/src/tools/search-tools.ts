/**
 * Search tools: glob / grep (spec §3.6).
 *
 * `glob` uses tinyglobby and sorts matches by mtime (newest first). `grep`
 * prefers ripgrep when it is on PATH and falls back to a pure-JS scan otherwise;
 * both produce `path:line:text` output.
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { glob as tinyGlob } from 'tinyglobby';
import {
  defineTool,
  errorResult,
  textResult,
  type AgentTool,
} from '@aragon-agent/core';
import type { ToolDeps } from './fs-tools.js';

const MAX_GREP_MATCHES = 500;
const MAX_FILE_BYTES = 5_000_000;

// ---------------------------------------------------------------------------
// glob
// ---------------------------------------------------------------------------

export function makeGlob(deps: ToolDeps): AgentTool {
  return defineTool({
    name: 'glob',
    label: 'Glob',
    description:
      'Find files matching a glob pattern (e.g. "src/**/*.ts"). Returns paths ' +
      'relative to the working directory, sorted by modification time (newest first).',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern.' },
        cwd: { type: 'string', description: 'Directory to search from (default: working directory).' },
      },
      required: ['pattern'],
    },
    async execute(_id, rawParams) {
      const params = rawParams as { pattern: string; cwd?: string };
      const base = params.cwd
        ? isAbsolute(params.cwd)
          ? params.cwd
          : resolve(deps.getCwd(), params.cwd)
        : deps.getCwd();
      try {
        const matches = await tinyGlob(params.pattern, {
          cwd: base,
          absolute: false,
          dot: false,
          onlyFiles: true,
        });
        if (matches.length === 0) return textResult('(no matches)');
        const withMtime = await Promise.all(
          matches.map(async (m) => {
            try {
              const st = await fs.stat(join(base, m));
              return { path: m, mtime: st.mtimeMs };
            } catch {
              return { path: m, mtime: 0 };
            }
          }),
        );
        withMtime.sort((a, b) => b.mtime - a.mtime);
        return textResult(withMtime.map((x) => x.path).join('\n'));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  });
}

// ---------------------------------------------------------------------------
// grep
// ---------------------------------------------------------------------------

export function makeGrep(deps: ToolDeps): AgentTool {
  return defineTool({
    name: 'grep',
    label: 'Grep',
    description:
      'Search file contents for a regular expression. Returns matching lines as ' +
      '`path:line:text`. Optionally restrict to a `path` subtree and/or a `glob`.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression to search for.' },
        path: { type: 'string', description: 'File or directory to search (default: working directory).' },
        glob: { type: 'string', description: 'Only search files matching this glob.' },
        ignoreCase: { type: 'boolean', description: 'Case-insensitive match.' },
      },
      required: ['pattern'],
    },
    async execute(_id, rawParams) {
      const params = rawParams as {
        pattern: string;
        path?: string;
        glob?: string;
        ignoreCase?: boolean;
      };
      const cwd = deps.getCwd();
      const searchRoot = params.path
        ? isAbsolute(params.path)
          ? params.path
          : resolve(cwd, params.path)
        : cwd;

      const rg = await tryRipgrep(params, searchRoot, cwd);
      if (rg !== null) {
        return rg.length > 0 ? textResult(rg.join('\n')) : textResult('(no matches)');
      }

      // Pure-JS fallback.
      try {
        const jsMatches = await jsGrep(params, searchRoot, cwd);
        return jsMatches.length > 0
          ? textResult(jsMatches.join('\n'))
          : textResult('(no matches)');
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  });
}

/**
 * Attempt ripgrep. Returns the matched lines, `[]` for a clean no-match, or
 * `null` when ripgrep is unavailable (so the caller falls back to JS).
 */
function tryRipgrep(
  params: { pattern: string; glob?: string; ignoreCase?: boolean },
  searchRoot: string,
  cwd: string,
): Promise<string[] | null> {
  return new Promise((resolvePromise) => {
    const args = ['--no-heading', '--line-number', '--color', 'never', '--max-count', String(MAX_GREP_MATCHES)];
    if (params.ignoreCase) args.push('--ignore-case');
    if (params.glob) args.push('--glob', params.glob);
    args.push('--regexp', params.pattern, searchRoot);

    let child;
    try {
      child = spawn('rg', args, { cwd });
    } catch {
      resolvePromise(null);
      return;
    }

    let stdout = '';
    let settled = false;
    const done = (value: string[] | null) => {
      if (!settled) {
        settled = true;
        resolvePromise(value);
      }
    };

    child.on('error', () => done(null)); // ENOENT — rg not installed.
    child.stdout?.on('data', (d) => {
      stdout += d.toString();
    });
    child.on('close', (code) => {
      // rg exits 0 with matches, 1 with no matches, 2 on error.
      if (code === 0 || code === 1) {
        const lines = stdout
          .split('\n')
          .filter((l) => l.trim().length > 0)
          .slice(0, MAX_GREP_MATCHES)
          .map((l) => normalizeRgLine(l, searchRoot, cwd));
        done(lines);
      } else {
        done(null);
      }
    });
  });
}

function normalizeRgLine(line: string, searchRoot: string, cwd: string): string {
  // ripgrep emits absolute or root-relative paths; normalize to cwd-relative.
  const match = /^(.*?):(\d+):(.*)$/.exec(line);
  if (!match) return line;
  const [, file, lineNo, text] = match;
  const abs = isAbsolute(file!) ? file! : resolve(searchRoot, file!);
  const rel = relative(cwd, abs) || file!;
  return `${rel.split('\\').join('/')}:${lineNo}:${text}`;
}

async function jsGrep(
  params: { pattern: string; glob?: string; ignoreCase?: boolean },
  searchRoot: string,
  cwd: string,
): Promise<string[]> {
  let regex: RegExp;
  try {
    regex = new RegExp(params.pattern, params.ignoreCase ? 'i' : undefined);
  } catch (err) {
    throw new Error(`Invalid regular expression: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Resolve the files to scan. When `path` names a single file, scan it
  // directly — globbing with a file as `cwd` would silently match nothing.
  let files: string[];
  let rootStat;
  try {
    rootStat = await fs.stat(searchRoot);
  } catch {
    rootStat = undefined;
  }
  if (rootStat?.isFile()) {
    files = [searchRoot];
  } else {
    const pattern = params.glob ?? '**/*';
    files = await tinyGlob(pattern, {
      cwd: searchRoot,
      absolute: true,
      dot: false,
      onlyFiles: true,
    });
  }

  const results: string[] = [];
  for (const file of files) {
    if (results.length >= MAX_GREP_MATCHES) break;
    let buf: Buffer;
    try {
      const st = await fs.stat(file);
      if (st.size > MAX_FILE_BYTES) continue;
      buf = await fs.readFile(file);
    } catch {
      continue;
    }
    if (buf.subarray(0, 8000).includes(0)) continue; // skip binary
    const rel = (relative(cwd, file) || file).split('\\').join('/');
    const lines = buf.toString('utf-8').split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (regex.test(lines[i]!)) {
        results.push(`${rel}:${i + 1}:${lines[i]}`);
        if (results.length >= MAX_GREP_MATCHES) break;
      }
    }
  }
  return results;
}
