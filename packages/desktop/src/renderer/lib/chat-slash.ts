/**
 * The composer's slash menu, built from the parity matrix (spec 3.9.3 / AC-8).
 *
 * Three groups: "runs now" (executed on the host), "opens a panel" (navigates to the desktop
 * surface that replaced the command) and "not applicable" (greyed, shows the substitute).
 * `SLASH_ACTIONS` must cover every `mapped` command in the matrix; `chat-slash.test.ts`
 * fails when a command is added to the matrix without a target here - a command that is
 * listed but does nothing would be the silent failure this menu exists to prevent.
 */

import { COMMAND_MATRIX, type ParityEntry } from '../../shared/parity-matrix.js';
import type { SettingsPage } from '../store/ui-store.js';
import type { InspectorTab } from '../../shared/desktop-state.js';

export type SlashGroup = 'run' | 'panel' | 'na';

export type SlashAction =
  | { do: 'run'; name: 'clear' | 'compact' }
  | { do: 'settings'; page: SettingsPage }
  | { do: 'inspector'; tab: InspectorTab }
  | { do: 'palette' }
  | { do: 'prompts' }
  | { do: 'shortcuts' }
  | { do: 'cwd' }
  | { do: 'model' }
  | { do: 'posture-plan' }
  | { do: 'plus-menu' }
  | { do: 'copy-id' }
  | { do: 'sidebar' }
  | { do: 'reset' }
  | { do: 'save' }
  | { do: 'branch' }
  | { do: 'focus-queue' }
  | { do: 'close-session' };

export const SLASH_ACTIONS: Readonly<Record<string, SlashAction>> = {
  clear: { do: 'run', name: 'clear' },
  compact: { do: 'run', name: 'compact' },
  help: { do: 'palette' },
  model: { do: 'model' },
  settings: { do: 'settings', page: 'general' },
  thinking: { do: 'model' },
  'max-tokens': { do: 'settings', page: 'models' },
  theme: { do: 'settings', page: 'general' },
  plan: { do: 'posture-plan' },
  fast: { do: 'settings', page: 'fast' },
  todo: { do: 'inspector', tab: 'plan' },
  retry: { do: 'settings', page: 'retry' },
  context: { do: 'inspector', tab: 'context' },
  tools: { do: 'plus-menu' },
  reset: { do: 'reset' },
  cwd: { do: 'cwd' },
  save: { do: 'save' },
  resume: { do: 'sidebar' },
  session: { do: 'copy-id' },
  branch: { do: 'branch' },
  logs: { do: 'settings', page: 'diagnostics' },
  reload: { do: 'settings', page: 'diagnostics' },
  bg: { do: 'inspector', tab: 'jobs' },
  exit: { do: 'close-session' },
  queue: { do: 'focus-queue' },
  kit: { do: 'model' },
  prompts: { do: 'prompts' },
  agents: { do: 'inspector', tab: 'agents' },
  subagent: { do: 'inspector', tab: 'agents' },
  team: { do: 'inspector', tab: 'agents' },
  gov: { do: 'inspector', tab: 'governance' },
  keys: { do: 'shortcuts' },
  task: { do: 'sidebar' },
  skills: { do: 'settings', page: 'skills' },
};

export interface SlashItem {
  id: string;
  group: SlashGroup;
  /** Where the capability lives now (shown as the secondary line). */
  target: string;
  action: SlashAction | null;
}

/** Actions that do their work immediately (as opposed to opening a surface). */
const RUNS_NOW: ReadonlySet<SlashAction['do']> = new Set(['run', 'reset', 'save', 'branch']);

/** `sidebar` is a legitimate target only where the parity matrix itself says "session list". */
export const SIDEBAR_COMMANDS: readonly string[] = ['resume', 'task'];

function toItem(entry: ParityEntry): SlashItem {
  if (entry.status === 'na') return { id: entry.id, group: 'na', target: entry.target, action: null };
  const action = SLASH_ACTIONS[entry.id] ?? null;
  return { id: entry.id, group: action && RUNS_NOW.has(action.do) ? 'run' : 'panel', target: entry.target, action };
}

const GROUP_ORDER: Record<SlashGroup, number> = { run: 0, panel: 1, na: 2 };

/** Menu rows for a typed query (prefix matches first, then substring), grouped in a stable order. */
export function buildSlashItems(query: string): SlashItem[] {
  const needle = query.toLowerCase();
  const items = COMMAND_MATRIX.map(toItem).filter((item) => item.id.includes(needle));
  const rank = (item: SlashItem): number => (item.id.startsWith(needle) ? 0 : 1);
  return items.sort((a, b) =>
    GROUP_ORDER[a.group] - GROUP_ORDER[b.group] || rank(a) - rank(b) || a.id.localeCompare(b.id));
}
