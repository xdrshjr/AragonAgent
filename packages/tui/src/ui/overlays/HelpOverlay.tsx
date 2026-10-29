/**
 * Help overlay — keybindings and slash-command reference (spec §5.2 / §5.3).
 *
 * Emits a flat array of ONE-ROW elements for `OverlayFrame`'s controlled mode
 * rather than a nested tree. This content is 29 rows tall against a 15-row
 * viewport on a 30-row terminal; before v0.4.0 everything past `/clear` was
 * clipped by `overflow: hidden` with no scrollbar, no indicator, and no way to
 * reach it. Slicing is done by element, so every row must be exactly one row —
 * hence the unconditional `wrap="truncate"`: the first keybinding description
 * alone is 100 characters with its padding and would wrap on any normal
 * terminal, silently desynchronising the position indicator (R-8).
 */

import React from 'react';
import { Text } from 'ink';
import type { Theme } from '../theme.js';
import type { TermCapabilities } from '../capabilities.js';
import { pickGlyphs } from '../glyphs.js';

const KEY_PAD = 24;

/**
 * Rows that only make sense when the APPLICATION scrolls and selects. In native
 * scroll mode (tui-native-terminal-scroll §4.7) the terminal does both, so they are
 * dropped and one honest row replaces them.
 */
const APP_SCROLL_ROWS: ReadonlySet<string> = new Set([
  'Shift+Up / Shift+Down', 'Wheel', 'Shift+Wheel', 'Drag right edge', '^N',
  'Drag text (left button)', 'Ctrl+C (with a selection)',
]);

function keyRows(times: string, native = false): [string, string][] {
  const all = allKeyRows(times);
  if (!native) return all;
  return all
    .filter(([key]) => !APP_SCROLL_ROWS.has(key))
    .map(([key, description]): [string, string] =>
      key === 'PgUp / PgDn' ? [key, 'Page through an open overlay'] : [key, description])
    .concat([['Scroll', 'Use your terminal (wheel, Shift+PgUp, scrollbar, search)']]);
}

/**
 * The key column of every binding row, EXPORTED so the drawer's drift guard can read
 * the real table instead of scraping this file with a regex
 * (tui-shortcut-drawer-and-task-summary D-8 / AC-5).
 *
 * A SOURCE SCRAPE WOULD PASS ON A COMMENT: the regex has no way to tell a key row
 * from a legend row from a line inside a block comment, and the guard's whole job is
 * to notice a row someone forgot.
 */
export function allKeyRows(times: string): [string, string][] {
  return [
    ['Enter', 'Submit (idle) / queue steering (running); re-pins to the newest output'],
    ['Alt+Enter / Shift+Enter', 'Newline when supported; the host may intercept either binding'],
    ['Ctrl+J', 'Newline fallback; /terminal-setup explains Shift+Enter binding'],
    ['Esc', 'Close menu / overlay'],
    ['Esc twice', 'Interrupt run (within 1.5s)'],
    ['Esc again', 'Force-stop after requesting interruption'],
    // BOTH KEYS ARE LISTED HERE, and this row is why (shift-tab-mode-toggle-
    // still-dead-on-windows, review R-7). The hint row above the composer is the
    // other place the fallback is named, and it has two off-switches - a short
    // terminal (`showHint`) and `hints: false`. A key that only exists behind
    // either of them is a key the affected user never learns about, which is the
    // one-shot notice's failure repeated with a different switch.
    // BOTH KEYS ARE SPELLED OUT, and `Ctrl+N` is written in FULL: `^N` is this
    // product's word for transcript line offset (the header chip and the row below),
    // so abbreviating the mode fallback would put two meanings of `^` on one screen
    // (quick-prompt-library D-1 / P1-7).
    ['Shift+Tab / Ctrl+N', 'Cycle BUILD / PLAN / GOVERN / PLAN+GOVERN (/plan and /gov pick one)'],
    ['Ctrl+P', 'Quick prompt library: manage, create, reorder, pick'],
    // The ladder clears a draft first (ctrl-c-clear-draft-exit):
    // with a draft x2 clears the input and x3 exits; an empty input
    // keeps the previous x2 exit.
    ['Ctrl+C', `Draft: ${times}2 clear input, ${times}3 exit. Empty: ${times}2 exit`],
    // Ctrl+L IS THE BRANCH KEY NOW (tui-branch-terminal-shortcut D-1) and the
    // redraw moved to Ctrl+R. Both rows are listed, because the migration is the
    // one thing an existing user will press by muscle memory and be surprised by.
    ['Ctrl+L', 'Open a new terminal on this session (the branch gets its own id)'],
    ['Ctrl+R', 'Redraw the frame'],
    ['Ctrl+T', 'Show/hide thinking (off by default)'],
    ['Ctrl+I', 'Build the project index (bundled skill; asks first; needs keyboard enhancement)'],
    // THE KIT KEYS (agent-model-kits D-11 / D-15): `Ctrl+K` moved to the picker
    // and `killToEnd` moved to `Alt+K`. BOTH rows are listed, because an existing
    // user will press the old key by muscle memory and needs to find out where it
    // went - and because `^K` is only advertised in the expanded header row.
    ['Ctrl+K', 'Agent kits: pick a preset for this session (see /kit)'],
    ['Alt+K', 'Delete from the cursor to the end of the line (was Ctrl+K)'],
    // Ctrl+G OPENED THE STATUS DETAIL ROW UNTIL THE DRAWER TOOK THE KEY
    // (tui-shortcut-drawer-and-task-summary D-6). The detail row did not disappear,
    // it moved to `d` inside this panel, and saying so here is the only place a
    // user's muscle memory can find out.
    ['Ctrl+G', 'Keyboard drawer: every shortcut, with keywords (d = status details)'],
    // Ctrl+O WAS MISSING FROM THIS TABLE ENTIRELY while it worked in the app, which
    // is exactly the gap the drawer's reverse drift guard exists to force closed: a
    // key that only exists in the code is a key only its author knows.
    ['Ctrl+O', 'Expand the newest tool output (native mode reprints it as a block)'],
    // The board's key is listed HERE and in the team table below: the roster shows
    // `ctrl+b` only on a terminal wide enough for the hint cell, and a key a user can
    // only learn from a wide terminal is a key the rest never discover (AC-18).
    ['Ctrl+B', 'Agents board: every subagent, its facts and its timeline (read-only)'],
    ['PgUp / PgDn', 'Scroll a page (transcript, or this overlay)'],
    ['Shift+Up / Shift+Down', 'Scroll the transcript a line (full-screen mode)'],
    ['Wheel', 'Scroll the transcript (or the open overlay)'],
    ['Shift+Wheel', 'Scroll the transcript a page'],
    // Drag-select is the one affordance here a user cannot discover by pressing
    // a key, so it has to be named somewhere they can look it up. The one-shot
    // startup notice is the other place, and it scrolls away.
    ['Drag right edge', 'Scroll messages; input stays fixed; type to return to newest output'],
    ['Bottom rows', 'Fixed input, one status row; Ctrl+G adds one detail row'],
    ['C / Th / t/s', 'Context percent / thinking level / run-average output tokens per second'],
    ['B / P / P>B', 'Status-row mode word: BUILD / PLAN; CUR>PENDING = switch deferred to run end'],
    ['O/N/L/M/H/X', 'Thinking: off/minimal/low/medium/high/xhigh'],
    ['~ / ? / --', 'Estimated context / unknown context / unavailable output speed'],
    ['Output speed', 'Main Agent reported output tokens / total run time, including tools and waits'],
    ['Copy / Sent / E / F', 'Copying / unconfirmed copy sent / copy error / Esc force-stop'],
    ['^N', 'Transcript line offset from the bottom, not a new-message count'],
    ['Drag text (left button)', 'Select text on screen; the highlight waits'],
    ['Ctrl+C (with a selection)', 'Copy the pending selection - does not arm exit'],
    ['Native terminal selection', 'Copy-on-select is controlled by your terminal settings'],
    ['Queue / /queue', 'Pending receipt; /queue opens full text, PgUp/PgDn pages, Esc closes'],
    ['/bg / /todo status', 'Show full service and TODO counts when status fields are hidden'],
    ['Queue paused', 'Unreceived messages persist after interruption until accepted or cancelled'],
    ['Up / Down', 'Prompt history (empty input)'],
    // Pasting is the one affordance here with no key of its own, so the only
    // place a user can learn what happened to their 218 lines is this row.
    ['Paste', 'Inserted as-is up to 6 lines; larger becomes [Pasted text #N] (--no-paste)'],
  ];
}

const COMMANDS: [string, string][] = [
  ['/help', 'Show this help'],
  // THE DRAWER'S COMMAND-SIDE ENTRY (tui-shortcut-drawer-and-task-summary §4.7).
  // Listed here as well as behind Ctrl+G, because a key is unreachable in a script
  // and `/keys` is how a paste or a screen reader gets to the same list.
  ['/keys [query]', 'List every shortcut in the drawer; a query pre-filters it'],
  ['/task', 'Show the header task summary: what it says, where it came from'],
  ['/task refresh', 'Regenerate the header task summary from the last prompt'],
  ['/model', 'Open the model picker'],
  ['/settings', 'Open the settings screen'],
  ['/plan [on|off|status]', 'Toggle plan mode (leaves GOVERN)'],
  ['/gov [on|plan|off|board|status]', 'Governed team: enter, leave, the board, the run status'],
  ['/theme <name>', 'auto | warm | cool | light'],
  ['/thinking <level>', 'Set thinking level'],
  ['/max-tokens [n|auto]', 'Output token cap; no argument reports the effective one'],
  ['/team [on|off|<brief>]', 'Force team mode and start now: /team <brief> fans out'],
  ['/fast [on|off|model|review]', 'Fast model tier: status, switch, model, review cadence'],
  ['/kit [list|use <name>]', 'Agent kits: what is in effect, list them, use one for this session'],
  [
    '/todo [on|off|panel|follow|clear|continue]',
    'Todo planning: status, switches, the rail, follow-through',
  ],
  ['/tools', 'List active tools'],
  // `/clear` IS NOT "CLEAR THE SCREEN" ANY MORE (clear-command-context-reset D-1).
  // Two rows, not one, because the intentions differ: `/clear` starts a NEW
  // CONVERSATION (interrupt the run, archive the old one, drop the history), while
  // `/clear screen` only wipes what is on screen. A user who wants the second has
  // to be able to see that it exists before reaching for the first.
  ['/clear', 'Start a new conversation: archive, then clear context and transcript'],
  ['/clear screen', 'Clear the visible transcript only; keeps the conversation'],
  ['/reset', 'Alias of /clear'],
  ['/cwd [dir]', 'Show or change the tool working directory'],
  ['/save [file]', 'Export the session to JSON (a file you keep)'],
  ['/resume [file]', 'Load a saved session; this session moves to a new id'],
  ['/session [copy|pin]', 'Show this session id and file; copy the resume command; pin it'],
  ['/branch', 'Same as Ctrl+L: branch into a new terminal'],
  ['/copy', 'Copy last answer; native completion confirmed, OSC 52 request unconfirmed'],
  ['/queue', 'Read every pending message in full; no replay or queue mutation'],
  ['/prompts', 'Quick prompt library: pick one and fill the draft (Enter fills)'],
  ['/agents', 'Open the subagent board: every child, its facts and its timeline'],
  ['/prompts list | add | edit | rm', 'Manage the library; `add` opens the editor'],
  ['/prompts move <n> <to> | sort',
    'Reorder by hand, or rewrite the order by name/recent/favorite'],
  ['/mouse [on|off]', 'Release the mouse to your terminal, or take it back'],
  ['/terminal-setup', 'Show newline key bindings without changing terminal settings'],
  ['/exit', 'Exit'],
];

const SKILL_ROWS: [string, string][] = [
  ['/skills', 'List installed skills'],
  ['/skills info <name>', 'Show a skill\'s source, files and status'],
  ['/skills install <src>', 'Install from a dir, git repo, or https URL'],
  ['/skills enable|disable', 'Turn a skill on or off'],
  ['/skills policy [mode]', 'Tool ceiling from allowed-tools: off | warn | enforce'],
  ['/skills unload', 'Drop the tool ceiling (does not reclaim context)'],
  ['/skills usage [--reset]', 'Show or delete the local skill use counters'],
  ['/<skill-name> [args]', 'Run a skill directly ($ARGUMENTS / $1..$9)'],
  ['skill / skill_install', 'Tools the model uses to load and install skills'],
];

const PLAN_ROWS: [string, string][] = [
  ['Shift+Tab / /plan', 'Switch BUILD (do it now) and PLAN (research first); Shift+Tab also cycles GOVERN'],
  // A ROW OF ITS OWN, not a third name on the line above: the reader who needs
  // this one is the reader whose `Shift+Tab` does nothing, and what they need is
  // the reason, not another synonym. Listing the key in both places instead just
  // says it twice and explains it nowhere.
  ['Ctrl+N', 'The same toggle, for Windows consoles that deliver Shift+Tab as a plain Tab'],
  ['In PLAN mode', 'write_file, edit_file, bash, skill_install and skill_create are refused'],
  ['bash', 'Refused in full, including git status - use read_file / glob / grep'],
  ['ask_user', 'The agent asks 1-5 multiple-choice questions; Enter takes the recommendation'],
  ['submit_plan', 'The agent submits a plan: a approve, r revise, Esc dismiss'],
  ['--plan / --no-plan', 'Start a session in a given mode (also ARAGON_PLAN=1)'],
];

const TEAM_ROWS: [string, string][] = [
  ['task', 'The tool the agent uses to run 2-5 subagents in parallel'],
  ['/team <brief>', 'Force it: arms forced mode and starts that work as a turn'],
  ['/team on | off', 'Arm it without starting, or leave it; the capability is untouched'],
  ['/team', 'Report the forced state, capacity, the model, and where to change it'],
  ['-n <n> / --parts a,b', 'Fix the fan-out, or name the split (narrowing is disclosed)'],
  ['--read-only', 'Every child refuses writes and shell, for research-only fan-outs'],
  ['Team 4  (T4)', 'The status-bar chip - only while the session is armed'],
  ['--team / --no-team', 'Start a session with team mode on or off (also ARAGON_TEAM=0)'],
  ['team_send / team_wait', 'How subagents message each other; 6 each, one every 15s'],
  ['Ctrl+B / /agents', 'The board: every child, its full facts, its 24-event timeline'],
  ['Settings > Team', 'Team mode, width (1-10, 8 by default), concurrency, supervisor'],
];

const FAST_ROWS: [string, string][] = [
  ['/fast', 'Status: on/off, the model, the cadence, and this session\'s totals'],
  ['/fast on | off', 'Switch the tier for this session (and save it)'],
  ['/fast model <id>', 'Set the fast model; accepts provider:model'],
  ['/fast same', 'Run the fast tier on the main model'],
  ['/fast review <n> | off', 'Turns between automatic reviews, or turn them off'],
  ['--fast / --no-fast', 'Start a session with the tier on or off (also ARAGON_FAST=1)'],
  ['<fast_review>', 'An automated second opinion from the fast model - advice, not the user'],
];

/** The slash-command table's key column, for the same guard (commands are not keys). */
export function allCommandRows(): [string, string][] {
  return COMMANDS;
}

/** Build the overlay's rows. Exported so `app.test.tsx` can count them. */
export function helpRows(
  theme: Theme,
  caps: TermCapabilities,
  native = false,
): React.ReactElement[] {
  const glyphs = pickGlyphs(caps);
  const rows: React.ReactElement[] = [];

  const section = (title: string): React.ReactElement => (
    <Text key={`s-${title}`} wrap="truncate" color={theme.accent} bold>
      {title}
    </Text>
  );
  const pair = (k: string, d: string): React.ReactElement => (
    <Text key={`r-${k}`} wrap="truncate">
      <Text color={theme.primary}>{k.padEnd(KEY_PAD)}</Text>
      <Text color={theme.muted}>{d}</Text>
    </Text>
  );

  rows.push(section('Keybindings'));
  for (const [k, d] of keyRows(glyphs.times, native)) rows.push(pair(k, d));
  rows.push(section('Slash commands'));
  for (const [c, d] of COMMANDS) rows.push(pair(c, d));
  rows.push(section('Plan mode'));
  for (const [c, d] of PLAN_ROWS) rows.push(pair(c, d));
  rows.push(section('Team subagents'));
  for (const [c, d] of TEAM_ROWS) rows.push(pair(c, d));
  rows.push(section('Fast model tier'));
  for (const [c, d] of FAST_ROWS) rows.push(pair(c, d));
  rows.push(section('Skills'));
  for (const [c, d] of SKILL_ROWS) rows.push(pair(c, d));
  return rows;
}
