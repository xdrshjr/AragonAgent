/**
 * Activity strings for the live roster (team-live-activity F-1).
 *
 * ASCII ONLY: `src/team/**` is inside the glyph scanner's scope. That rule binds
 * the LITERALS IN THIS FILE, not the runtime data flowing through it - a child
 * may well be reading a CJK path, and `run.description` already carries model
 * text into the same row.
 */

import { TEAM_LIMITS } from './limits.js';

/**
 * The only part of a tool call this module will ever render (P1-4).
 *
 * A PICKED SUBSET, NOT THE ARGS OBJECT. Storing `event.args` whole would put
 * `write_file`'s `content` - a whole file - on the run, and `TeamRuntime.publish`
 * shallow-copies the run into the live snapshot AND into every `agent_update`
 * event, and `dispatch()` copies it again into `DispatchOutcome.runs`, which
 * `TeamCard` holds in the transcript for the rest of the session. Two facts make
 * that unacceptable rather than merely wasteful: the retention is unbounded in
 * the file's size, and one `JSON.stringify` anywhere downstream would put a file
 * body into a log - the exact liability the logging section spends a paragraph
 * avoiding.
 *
 * This costs nothing in maintenance: the switch below is ALREADY a per-tool
 * table, so a new tool is one entry either way.
 */
export interface ActivityArgs {
  path?: string;
  pattern?: string;
  command?: string;
  to?: string;
  from?: string;
}

/** Pick at capture time. Called once per `tool_execution_start`. */
export function pickActivityArgs(args: unknown): ActivityArgs {
  const a = (args ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.length > 0 ? v.slice(0, TEAM_LIMITS.activityArgChars) : undefined;
  const picked: ActivityArgs = {};
  const path = str(a.path);
  const pattern = str(a.pattern);
  const command = str(a.command);
  const to = str(a.to);
  const from = str(a.from);
  if (path !== undefined) picked.path = path;
  if (pattern !== undefined) picked.pattern = pattern;
  if (command !== undefined) picked.command = command;
  if (to !== undefined) picked.to = to;
  if (from !== undefined) picked.from = from;
  return picked;
}

/**
 * Strip anything that could corrupt the frame, collapse whitespace, and clamp.
 *
 * THE CONTROL-CHARACTER STRIP IS A CORRECTNESS BOUNDARY, NOT TIDINESS. This
 * string is model-chosen and reaches an Ink <Text> unescaped. A child running
 * `bash` with an ANSI escape in the command line would otherwise write that
 * escape into the roster: at best a mangled row, at worst a cleared screen or a
 * moved cursor in the middle of someone's transcript. `bash`'s own output never
 * reaches the panel; its ARGUMENTS now do.
 *
 * SURROGATES ARE GUARDED AT BOTH ENDS (P2-3). The trailing guard is the obvious
 * one. The LEADING one is needed because the caller feeds this a rolling tail
 * built with `String.slice(-n)`, which cuts on a UTF-16 code-unit boundary and
 * can therefore hand us a lone LOW surrogate at index 0. Either half of a split
 * pair renders as a replacement character - the same failure `truncateBytes`
 * guards one layer down (report.ts).
 */
export function sanitizeActivity(raw: string, maxChars: number): string {
  let src = raw;
  const head = src.charCodeAt(0);
  if (head >= 0xdc00 && head <= 0xdfff) src = src.slice(1);
  const flat = src
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (maxChars <= 0) return '';
  if (flat.length <= maxChars) return flat;
  if (maxChars <= 3) return flat.slice(0, maxChars);
  let cut = maxChars - 3;
  const code = flat.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return `${flat.slice(0, cut)}...`;
}

/** The basename of a path, for the narrow form. Pure string work: no `path`. */
function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/** The program name of a command line, for the narrow form. */
function program(commandLine: string): string {
  const first = commandLine.trim().split(/\s+/)[0] ?? '';
  return basename(first) || commandLine;
}

/**
 * One short phrase describing a tool call.
 *
 * `wide` false is the narrow-terminal form (D-4). For a path-valued argument
 * that is the basename; for `bash` it is the PROGRAM NAME (P1-6). Running the
 * command line through `basename` is wrong twice over: `basename` splits on `/`,
 * so `npm test -w cli` comes back whole and `./scripts/build.sh --prod` comes
 * back as `build.sh --prod`. Neither is shorter and the second is a lie about
 * what ran.
 *
 * Anything not in the table renders as its own name. That is the correct
 * degradation for `skill_find` and for any tool a later round registers on a
 * child: a name is always true, and inventing an argument mapping for a tool
 * this module has not been taught is how a formatter starts lying.
 */
export function describeToolActivity(
  toolName: string,
  args: ActivityArgs | undefined,
  wide: boolean,
): string {
  const a = args ?? {};
  switch (toolName) {
    case 'read_file':
      return detail('read', a.path, wide, basename);
    case 'write_file':
      return detail('write', a.path, wide, basename);
    case 'edit_file':
      return detail('edit', a.path, wide, basename);
    case 'list_dir':
      return detail('list', a.path ?? '.', wide, basename);
    case 'glob':
      return detail('glob', a.pattern, wide, basename);
    case 'grep':
      return detail('grep', a.pattern, wide, basename);
    case 'bash':
      return detail('bash', a.command, wide, program);
    case 'team_send': {
      const to = (a.to ?? '').trim();
      return to ? `messaging ${to}` : 'messaging';
    }
    case 'team_wait': {
      const from = (a.from ?? '').trim();
      return from ? `waiting for ${from}` : 'waiting for mail';
    }
    default:
      return toolName;
  }
}

function detail(
  verb: string,
  value: string | undefined,
  wide: boolean,
  narrow: (v: string) => string,
): string {
  const v = (value ?? '').trim();
  if (v.length === 0) return verb;
  return `${verb}: ${wide ? v : narrow(v)}`;
}
