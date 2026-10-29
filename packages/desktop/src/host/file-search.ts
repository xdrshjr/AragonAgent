/**
 * `@` mentions: a bounded fuzzy file search rooted at the session's working directory.
 *
 * Bounded three ways because it runs against whatever directory the user opened: at most
 * 50 results, a 2 s deadline (whatever was found by then is returned, flagged `truncated`),
 * and the repository's root `.gitignore`. Matching is a subsequence match
 * ranked by how tight and how close to the file name it is - the same feel as an editor's
 * "go to file" - not a regex, so a query is never interpreted as one.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { glob } from 'tinyglobby';

export const SEARCH_LIMITS = { results: 50, deadlineMs: 2000, scanned: 20_000 } as const;

export interface FileSearchResult {
  paths: string[];
  truncated: boolean;
}

/** Score a path against a query; higher is better, `null` means no match. */
export function scorePath(path: string, query: string): number | null {
  const haystack = path.toLowerCase();
  const needle = query.toLowerCase();
  if (needle.length === 0) return 0;
  const nameStart = haystack.lastIndexOf('/') + 1;
  let from = 0;
  let score = 0;
  let previous = -2;
  for (const char of needle) {
    const at = haystack.indexOf(char, from);
    if (at < 0) return null;
    score += at === previous + 1 ? 6 : 1; // consecutive characters beat scattered ones
    if (at >= nameStart) score += 3; // matches inside the file name beat matches in the directory
    if (at === 0 || haystack[at - 1] === '/' || haystack[at - 1] === '_' || haystack[at - 1] === '-') score += 4;
    previous = at;
    from = at + 1;
  }
  return score - Math.floor(haystack.length / 20);
}

/**
 * Turn the ROOT `.gitignore` into glob ignores. Deliberately modest: plain names, directory
 * names and rooted paths cover what actually fills a result list (`node_modules`, `dist`,
 * `.next`); negations and nested ignore files are not interpreted, so a file they would
 * re-include can be missing here - a trade for not shipping a second ignore engine.
 */
export function ignoreGlobsFrom(gitignore: string): string[] {
  const out: string[] = [];
  for (const raw of gitignore.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith('!')) continue;
    const rooted = line.startsWith('/');
    const body = line.replace(/^\//, '').replace(/\/+$/, '');
    if (body === '') continue;
    const base = rooted || body.includes('/') ? body : `**/${body}`;
    out.push(base, `${base}/**`);
  }
  return out;
}

function readIgnoreGlobs(cwd: string): string[] {
  try {
    return ignoreGlobsFrom(readFileSync(join(cwd, '.gitignore'), 'utf8'));
  } catch {
    return [];
  }
}

export async function searchFiles(cwd: string, query: string): Promise<FileSearchResult> {
  const deadline = Date.now() + SEARCH_LIMITS.deadlineMs;
  let truncated = false;
  const files = await Promise.race([
    glob(['**/*'], {
      cwd, dot: false, onlyFiles: true, followSymbolicLinks: false,
      ignore: ['**/node_modules/**', '**/.git/**', ...readIgnoreGlobs(cwd)],
    }),
    new Promise<string[]>((resolve) => setTimeout(() => { truncated = true; resolve([]); }, SEARCH_LIMITS.deadlineMs)),
  ]).catch(() => [] as string[]);
  if (files.length > SEARCH_LIMITS.scanned) truncated = true;
  const scored: { path: string; score: number }[] = [];
  for (const path of files.slice(0, SEARCH_LIMITS.scanned)) {
    if (Date.now() > deadline) { truncated = true; break; }
    const score = scorePath(path, query);
    if (score !== null) scored.push({ path, score });
  }
  scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
  return { paths: scored.slice(0, SEARCH_LIMITS.results).map((entry) => entry.path), truncated };
}
