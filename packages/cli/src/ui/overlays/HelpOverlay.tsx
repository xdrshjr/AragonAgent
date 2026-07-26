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
    ['Alt+Enter / Shift+Enter', 'Insert newline'],
    ['Esc', 'Abort run / close overlay'],
    [`Ctrl+C ${times}2`, 'Exit'],
    ['Ctrl+L', 'Redraw the frame'],
    ['Ctrl+T', 'Toggle thinking blocks'],
    ['PgUp / PgDn', 'Scroll a page (transcript, or this overlay)'],
    ['Shift+Up / Shift+Down', 'Scroll the transcript a line (full-screen mode)'],
    ['Up / Down', 'Prompt history (empty input)'],
  ];
}

const COMMANDS: [string, string][] = [
  ['/help', 'Show this help'],
  ['/model', 'Open the model picker'],
  ['/settings', 'Open the settings screen'],
  ['/theme <name>', 'auto | warm | cool | light'],
  ['/thinking <level>', 'Set thinking level'],
  ['/tools', 'List active tools'],
  ['/clear', 'Clear the visible transcript'],
  ['/reset', 'New conversation'],
  ['/cwd [dir]', 'Show or change the tool working directory'],
  ['/save [file]', 'Save the session to JSON'],
  ['/resume [file]', 'Load a saved session'],
  ['/copy', 'Copy the last answer to the clipboard'],
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
  rows.push(section('Skills'));
  for (const [c, d] of SKILL_ROWS) rows.push(pair(c, d));
  return rows;
}
