/**
 * The terminal -> desktop parity matrix (spec appendix A), as data.
 *
 * EVERY registered slash command and EVERY `PersistedConfig` key must have exactly one entry
 * here: either `mapped` to a desktop surface, or `na` with the reason. `test/parity` builds
 * the real lists from the cli's command registry and `DEFAULT_CONFIG` and fails on any
 * difference in either direction - that mechanical comparison is the only thing standing
 * between "we claim parity" and a command that silently does nothing in the desktop app.
 * (The hand-written appendix of the design already missed `/perf` once.)
 */

export type ParityStatus = 'mapped' | 'na';

export interface ParityEntry {
  id: string;
  status: ParityStatus;
  /** Where the capability lives in the desktop app (mapped) or the shown substitute (na). */
  target: string;
  /** Required for `na`: why the terminal behaviour has no meaning here. */
  reason?: string;
}

const mapped = (id: string, target: string): ParityEntry => ({ id, status: 'mapped', target });
const na = (id: string, target: string, reason: string): ParityEntry => ({ id, status: 'na', target, reason });

export const COMMAND_MATRIX: readonly ParityEntry[] = [
  mapped('help', 'Command palette (Ctrl/Cmd+K) and the shortcut sheet (?)'),
  mapped('model', 'Composer model chip; Settings > Models'),
  mapped('settings', 'Settings (Ctrl/Cmd+,)'),
  mapped('thinking', 'Composer model chip: thinking level'),
  mapped('max-tokens', 'Settings > Models'),
  mapped('theme', 'Settings > General'),
  mapped('plan', 'Composer mode chip (Shift+Tab)'),
  mapped('fast', 'Settings > Fast tier'),
  na('update', 'Settings > Updates', 'The desktop app ships its own engine and updates as one unit.'),
  mapped('todo', 'Inspector > Plan'),
  mapped('retry', 'Retry row "Retry now"; Settings > Retry'),
  mapped('compact', 'Inspector > Context: Compact now'),
  mapped('context', 'Context ring popover; Inspector > Context'),
  na('expand', 'Click a tool card to expand it', 'Cards expand natively; there is no keyboard-only expansion mode.'),
  mapped('tools', 'Composer [+] menu > Tools'),
  mapped('clear', 'Session bar ⋯ menu > New conversation'),
  mapped('reset', 'Session bar ⋯ menu > New conversation (/reset is an alias of /clear)'),
  mapped('cwd', 'Session bar working-directory chip'),
  mapped('save', 'Session bar ⋯ menu > Save checkpoint / Export as Markdown; automatic checkpoints'),
  mapped('resume', 'Session sidebar'),
  mapped('session', 'Session id chip (copy) and pin'),
  mapped('branch', 'Session bar ⋯ menu > Branch this session; session row'),
  na('copy', 'Message and code-block copy buttons', 'Native text selection and per-block copy replace it.'),
  na('mouse', 'Native selection', 'Terminal mouse-capture mode does not exist in a window.'),
  na('terminal-setup', 'None', 'Terminal-emulator keyboard setup does not apply to a window.'),
  mapped('logs', 'Settings > Logs & Diagnostics'),
  mapped('reload', 'Automatic (config watcher); Settings "Reload"'),
  na('perf', 'None', 'It reports the terminal render governor and frame writer; the desktop budget is covered by tests.'),
  mapped('bg', 'Inspector > Jobs'),
  mapped('exit', 'Close session (Ctrl/Cmd+W)'),
  mapped('queue', 'Composer queue list (focus the withdraw button)'),
  mapped('kit', 'Composer model chip > Kits; Settings > Models'),
  mapped('prompts', 'Prompt picker (Ctrl/Cmd+P); Settings > Prompts'),
  mapped('agents', 'Inspector > Agents'),
  mapped('subagent', 'Inspector > Agents'),
  mapped('team', 'Inspector > Agents; "/team" in the composer'),
  mapped('gov', 'Mode chip; Inspector > Governance'),
  mapped('keys', 'Shortcut sheet (?)'),
  mapped('task', 'Session title (task summary)'),
  mapped('skills', 'Settings > Skills'),
];

export const CONFIG_KEY_MATRIX: readonly ParityEntry[] = [
  // Shared and live: read and written by the settings pages, changes picked up both ways.
  ...[
    ['provider', 'Settings > Models'], ['model', 'Settings > Models'], ['baseUrl', 'Settings > Models'],
    ['thinkingLevel', 'Composer model chip'], ['showThinking', 'Settings > Agent'],
    ['liveToolOutput', 'Settings > Agent'], ['maxTokens', 'Settings > Models'],
    ['contextWindow', 'Settings > Models'], ['theme', 'Settings > General'],
    ['reducedMotion', 'Settings > General'], ['confirmTools', 'Settings > Agent'],
    ['toolTimeoutMs', 'Settings > Agent'], ['idleTimeoutMs', 'Settings > Agent'],
    ['apiKeys', 'Settings > Models'], ['historyEnabled', 'Settings > Agent'],
    ['density', 'Settings > General'], ['hints', 'Settings > General'],
    ['planModeDefault', 'Settings > Agent'], ['planModeHumanTimeoutMs', 'Settings > Agent'],
    ['skills', 'Settings > Skills'], ['log', 'Settings > Logs & Diagnostics'],
    ['team', 'Settings > Team'], ['todo', 'Settings > Plan & Todo'], ['retry', 'Settings > Retry'],
    ['fast', 'Settings > Fast tier'], ['compaction', 'Settings > Context'],
    ['bash', 'Settings > Agent'], ['jobs', 'Settings > Agent'], ['prompts', 'Settings > Prompts'],
    ['taskSummary', 'Settings > Fast tier'], ['governance', 'Settings > Governance'],
    ['modelProfiles', 'Settings > Models'],
  ].map(([id, target]) => mapped(id!, target!)),
  // Terminal-only: preserved byte for byte on every write, never shown.
  ...[
    'exitTranscript', 'renderGovernor', 'maxRenderIntervalMs', 'diffRender', 'scrollMode',
    'syncOutput', 'mouse', 'mouseSelect', 'paste', 'keyboardEnhancement', 'scrollResumeMs',
    'transcriptWindow',
  ].map((id) => na(id, 'Preserved, not shown', 'A terminal renderer setting with no meaning in a window.')),
  mapped('developerMode', 'Settings > General: Developer mode (raw tool names and arguments)'),
  mapped('transcriptRetain', 'Session host view-state retention window'),
  mapped('update', 'Settings > Updates (the terminal updater is not used by the desktop app)'),
  mapped('version', 'Config file schema version (managed, never edited)'),
];

export const OVERLAY_MATRIX: readonly ParityEntry[] = [
  mapped('settings', 'Settings page'), mapped('model', 'Model chip popover'),
  mapped('help', 'Command palette'), mapped('shortcuts', 'Shortcut sheet'),
  mapped('queue', 'Composer queue list'), mapped('confirm', 'Approval card'),
  mapped('question', 'Ask-user wizard'), mapped('plan', 'Plan review card'),
  mapped('kit', 'Kit popover'), mapped('prompts', 'Prompt library page'),
  mapped('prompt-pick', 'Prompt picker'), mapped('agents', 'Inspector > Agents'),
];

export const KEY_MATRIX: readonly ParityEntry[] = [
  mapped('Shift+Tab', 'Mode chip cycle (same key)'),
  mapped('Ctrl+B', 'Agents board is Ctrl/Cmd+Shift+B: Ctrl/Cmd+B toggles the sidebar here'),
  mapped('Ctrl+K', 'Kits are Ctrl/Cmd+Shift+K: Ctrl/Cmd+K is the command palette here'),
  mapped('Ctrl+P', 'Prompt picker (same key)'),
  mapped('Ctrl+I', 'Composer [+] menu > Build project index (Tab/Ctrl+I carry focus meaning in a GUI)'),
  mapped('Ctrl+L', 'Session row > Branch; Ctrl/Cmd+Shift+L'),
  mapped('Esc', 'Interrupt; twice to force-stop (same gesture)'),
  mapped('?', 'Shortcut sheet (outside text fields)'),
  na('scroll/selection/mouse', 'Native', 'Scrolling, selection and mouse handling belong to the window.'),
];

/** Every entry whose status is `na` must say why; the test enforces it on the whole matrix. */
export const ALL_PARITY_ENTRIES: readonly ParityEntry[] = [
  ...COMMAND_MATRIX, ...CONFIG_KEY_MATRIX, ...OVERLAY_MATRIX, ...KEY_MATRIX,
];

export function findCommandEntry(name: string): ParityEntry | undefined {
  return COMMAND_MATRIX.find((entry) => entry.id === name);
}
