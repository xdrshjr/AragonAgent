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

function keyRows(times: string): [string, string][] {
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
    ['Shift+Tab / Ctrl+P', 'Cycle mode: BUILD -> PLAN -> UNRESTRICTED (same as /plan)'],
    [`Ctrl+C ${times}2`, 'Exit'],
    ['Ctrl+L', 'Redraw the frame'],
    ['Ctrl+T', 'Show/hide thinking (off by default)'],
    ['Ctrl+G', 'Expand/collapse status details; disabled while an overlay is open'],
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
    ['O/N/L/M/H/X', 'Thinking: off/minimal/low/medium/high/xhigh'],
    ['~ / ? / --', 'Estimated context / unknown context / unavailable output speed'],
    ['Output speed', 'Main Agent reported output tokens / total run time, including tools and waits'],
    ['Copy / Sent / E / F', 'Copying / unconfirmed copy sent / copy error / Esc force-stop'],
    ['^N', 'Transcript line offset from the bottom, not a new-message count'],
    ['Drag text (left button)', 'Select text on screen; the highlight waits'],
    ['Ctrl+C (with a selection)', 'Copy the pending selection - does not arm exit'],
    ['Native terminal selection', 'Copy-on-select is controlled by your terminal settings'],
    ['Queue / /queue', 'Pending receipt; /queue opens full text, PgUp/PgDn pages, Esc closes'],
    ['plan>build / build>plan', 'A mode switch pending until the current run ends'],
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
  ['/model', 'Open the model picker'],
  ['/settings', 'Open the settings screen'],
  ['/plan [on|off|unr|status]', 'Cycle or set mode (same as Shift+Tab)'],
  ['/theme <name>', 'auto | warm | cool | light'],
  ['/thinking <level>', 'Set thinking level'],
  ['/max-tokens [n|auto]', 'Output token cap; no argument reports the effective one'],
  ['/team [on|off|max n]', 'Team subagents: status, switch, fan-out width'],
  ['/fast [on|off|model|review]', 'Fast model tier: status, switch, model, review cadence'],
  [
    '/todo [on|off|panel|follow|clear|continue]',
    'Todo planning: status, switches, the rail, follow-through',
  ],
  ['/tools', 'List active tools'],
  ['/clear', 'Clear the visible transcript and the todo panel'],
  ['/reset', 'New conversation'],
  ['/cwd [dir]', 'Show or change the tool working directory'],
  ['/save [file]', 'Save the session to JSON'],
  ['/resume [file]', 'Load a saved session'],
  ['/copy', 'Copy last answer; native completion confirmed, OSC 52 request unconfirmed'],
  ['/queue', 'Read every pending message in full; no replay or queue mutation'],
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
  ['Shift+Tab / /plan', 'Cycle BUILD (do it now) -> PLAN (research first) -> UNRESTRICTED (operator package)'],
  // A ROW OF ITS OWN, not a third name on the line above: the reader who needs
  // this one is the reader whose `Shift+Tab` does nothing, and what they need is
  // the reason, not another synonym. Listing the key in both places instead just
  // says it twice and explains it nowhere.
  ['Ctrl+P', 'The same mode cycle, for Windows consoles that deliver Shift+Tab as a plain Tab'],
  ['In PLAN mode', 'write_file, edit_file, bash, skill_install and skill_create are refused'],
  ['bash', 'Refused in full, including git status - use read_file / glob / grep'],
  ['ask_user', 'The agent asks 1-5 multiple-choice questions; Enter takes the recommendation'],
  ['submit_plan', 'The agent submits a plan: a approve, r revise, Esc dismiss'],
  ['--plan / --no-plan', 'Start a session in a given mode (also ARAGON_PLAN=1)'],
];

const TEAM_ROWS: [string, string][] = [
  ['task', 'The tool the agent uses to run 2-5 subagents in parallel'],
  ['/team', 'Status: on/off, max subagents, and the live roster'],
  ['/team on | off', 'Switch team mode for this session (and save it)'],
  ['/team max <n>', 'Fan-out width, 1-10 (5 by default)'],
  ['--team / --no-team', 'Start a session with team mode on or off (also ARAGON_TEAM=0)'],
  ['team_send / team_wait', 'How subagents message each other; 6 each, one every 15s'],
];

const FAST_ROWS: [string, string][] = [
  ['/fast', 'Status: on/off, the model, the cadence, and this session\'s totals'],
  ['/fast on | off', 'Switch the tier for this session (and save it)'],
  ['/fast model <id>', 'Set the fast model; accepts provider:model'],
  ['/fast same', 'Run the fast tier on the main model'],
  ['/fast review <n> | off', 'Turns between automatic reviews, or turn them off'],
  ['/fast delegate on | off', 'Allow model:"fast" on task subagents'],
  ['--fast / --no-fast', 'Start a session with the tier on or off (also ARAGON_FAST=1)'],
  ['<fast_review>', 'An automated second opinion from the fast model - advice, not the user'],
];

/** Build the overlay's rows. Exported so `app.test.tsx` can count them. */
export function helpRows(theme: Theme, caps: TermCapabilities): React.ReactElement[] {
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
  for (const [k, d] of keyRows(glyphs.times)) rows.push(pair(k, d));
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
