/**
 * Visual-warning detection for approval summaries (spec 3.7 rule 3).
 *
 * THIS NEVER DENIES ANYTHING. The only consumer highlights the matched text and shows a
 * one-line warning; the decision stays with the user. A missed pattern therefore costs a
 * missing highlight, not a wrong outcome - which is also why the list can stay short and
 * readable rather than trying to be a shell parser.
 */

export type DangerKind =
  | 'recursive-delete'
  | 'privilege'
  | 'pipe-to-shell'
  | 'disk-write'
  | 'force-vcs'
  | 'outside-workspace';

export interface DangerMatch {
  kind: DangerKind;
  start: number;
  end: number;
}

const PATTERNS: ReadonlyArray<{ kind: DangerKind; re: RegExp }> = [
  { kind: 'recursive-delete', re: /\brm\s+(?:-\S+\s+)*?-(?:[a-zA-Z]*[rR][a-zA-Z]*|-recursive)(?=\s|$)/g },
  { kind: 'recursive-delete', re: /\bRemove-Item\b[^\n|;]*-Recurse\b|\b(?:rd|rmdir)\s+\/s\b|\bdel\s+\/[sq]\b/gi },
  { kind: 'privilege', re: /\bsudo\b|\bdoas\b|\brunas\b/g },
  { kind: 'pipe-to-shell', re: /\b(?:curl|wget|iwr|Invoke-WebRequest)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b|\biex\b/gi },
  { kind: 'disk-write', re: /\bmkfs(?:\.\w+)?\b|\bdd\s+if=|\bformat\s+[a-z]:|>\s*\/dev\/(?:sd|nvme|disk)\w*/gi },
  { kind: 'force-vcs', re: /\bgit\s+(?:push\s+[^\n]*--force\b|push\s+[^\n]*\s-f\b|reset\s+--hard\b|clean\s+-[a-z]*f)/g },
];

const ABSOLUTE_PATH = /(?:^|[\s"'=(:])((?:[A-Za-z]:[\\/]|\/(?!\/)|~[\\/])[^\s"'`|;&<>)]*)/g;

function normalise(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function isOutside(path: string, cwd: string | null): boolean {
  const target = normalise(path);
  if (/(?:^|\/)\.\.(?:\/|$)/.test(target)) return true;
  if (target.startsWith('~')) return true;
  if (cwd === null) return false;
  const root = normalise(cwd);
  return !(target === root || target.startsWith(`${root}/`));
}

function overlaps(a: DangerMatch, b: DangerMatch): boolean {
  return a.start < b.end && b.start < a.end;
}

/** Matches in order of position, never overlapping (earlier/longer wins). */
export function detectDanger(summary: string, cwd: string | null): DangerMatch[] {
  const found: DangerMatch[] = [];
  for (const { kind, re } of PATTERNS) {
    for (const match of summary.matchAll(re)) {
      found.push({ kind, start: match.index ?? 0, end: (match.index ?? 0) + match[0].length });
    }
  }
  for (const match of summary.matchAll(ABSOLUTE_PATH)) {
    const path = match[1] ?? '';
    if (path.length < 2 || !isOutside(path, cwd)) continue;
    const end = (match.index ?? 0) + match[0].length;
    found.push({ kind: 'outside-workspace', start: end - path.length, end });
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: DangerMatch[] = [];
  for (const candidate of found) {
    if (!kept.some((existing) => overlaps(existing, candidate))) kept.push(candidate);
  }
  return kept;
}

export interface SummarySegment {
  text: string;
  danger: DangerKind | null;
}

/** Split a summary into plain and highlighted runs; concatenating the texts gives it back. */
export function segmentSummary(summary: string, matches: readonly DangerMatch[]): SummarySegment[] {
  const segments: SummarySegment[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.start > cursor) segments.push({ text: summary.slice(cursor, match.start), danger: null });
    segments.push({ text: summary.slice(match.start, match.end), danger: match.kind });
    cursor = match.end;
  }
  if (cursor < summary.length) segments.push({ text: summary.slice(cursor), danger: null });
  return segments;
}

/** The distinct kinds present, in first-seen order (for the warning line). */
export function dangerKinds(matches: readonly DangerMatch[]): DangerKind[] {
  return [...new Set(matches.map((match) => match.kind))];
}
