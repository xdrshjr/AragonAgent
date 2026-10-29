/**
 * AC-8: the parity matrix is the REAL command registry and config schema, compared mechanically.
 * Any registered slash command or persisted config key that is neither mapped nor explicitly
 * marked "not applicable, because ..." fails here - the hand-written appendix of the design
 * missed `/perf` once, which is why this runs against the live lists instead of a copy.
 */
import { describe, expect, it } from 'vitest';
import { createCommandRegistry } from '@aragon-agent/cli/dist/commands/create-registry.js';
import { listSlashCommands } from '@aragon-agent/cli/dist/host/commands.js';
import { DEFAULT_CONFIG } from '@aragon-agent/tui/model/config/schema';
import {
  ALL_PARITY_ENTRIES,
  COMMAND_MATRIX,
  CONFIG_KEY_MATRIX,
  KEY_MATRIX,
  OVERLAY_MATRIX,
} from '../../src/shared/parity-matrix.js';

// The SAME assembly function the terminal App dispatches through (not a hand-picked subset of
// the `register*` calls), so this comparison cannot pass over half the commands.
const registry = createCommandRegistry({ version: '0.0.0' });
const registered = registry.all().map((command) => command.name);
/** A floor, so an emptied registry and an emptied menu cannot "agree" with each other. */
const MIN_COMMANDS = 35;

describe('slash commands', () => {
  it('every registered command has an entry', () => {
    const covered = new Set(COMMAND_MATRIX.map((entry) => entry.id));
    expect(registered.filter((name) => !covered.has(name))).toEqual([]);
  });

  it('every entry names a command that exists (no stale rows); `skills` is the one conditional registration', () => {
    const live = new Set([...registered, 'skills']);
    expect(COMMAND_MATRIX.map((entry) => entry.id).filter((id) => !live.has(id))).toEqual([]);
  });
});

describe('the menu metadata the host serves', () => {
  it('names exactly the commands the terminal registers (AC-57)', () => {
    const served = listSlashCommands().map((command) => command.name).sort();
    expect(served).toEqual([...registered].sort());
    expect(served.length).toBeGreaterThanOrEqual(MIN_COMMANDS);
  });

  it('every served command is covered by the matrix, so the menu can place it', () => {
    const covered = new Set(COMMAND_MATRIX.map((entry) => entry.id));
    expect(listSlashCommands().map((command) => command.name).filter((name) => !covered.has(name))).toEqual([]);
  });
});

describe('configuration keys', () => {
  const schemaKeys = [...Object.keys(DEFAULT_CONFIG), 'modelProfiles'];

  it('every persisted key has an entry', () => {
    const covered = new Set(CONFIG_KEY_MATRIX.map((entry) => entry.id));
    expect(schemaKeys.filter((key) => !covered.has(key))).toEqual([]);
  });

  it('every entry names a key that exists', () => {
    const known = new Set(schemaKeys);
    expect(CONFIG_KEY_MATRIX.map((entry) => entry.id).filter((id) => !known.has(id))).toEqual([]);
  });
});

describe('the matrix itself', () => {
  it('has no duplicate ids within a category', () => {
    for (const matrix of [COMMAND_MATRIX, CONFIG_KEY_MATRIX, OVERLAY_MATRIX, KEY_MATRIX]) {
      const ids = matrix.map((entry) => entry.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('every "not applicable" entry says why, and every entry says where it went', () => {
    for (const entry of ALL_PARITY_ENTRIES) {
      expect(entry.target.trim().length, `${entry.id} has no target`).toBeGreaterThan(0);
      if (entry.status === 'na') expect(entry.reason?.trim().length ?? 0, `${entry.id} has no reason`).toBeGreaterThan(0);
    }
  });
});

// ---- v1.2: a "mapped" row must be FULFILLED, not merely present (AC-77) --------------------------
// Coverage was already checked above; what was missing is that the row points at something that
// exists. `/reset` and `/save` used to be "mapped" to a Session menu that had no such items while the
// slash menu answered them by opening the sidebar - nothing failed because nothing compared the two.
import { SIDEBAR_COMMANDS, SLASH_ACTIONS } from '../../src/renderer/lib/chat-slash.js';
import { SESSION_MENU, menuMatrixIds } from '../../src/renderer/chat/session-menu.js';

/** Mapped commands that deliberately have no slash action, each with the reason. */
const NO_SLASH_ACTION: Readonly<Record<string, string>> = {};

describe('mapped commands are fulfilled (AC-77)', () => {
  const mapped = COMMAND_MATRIX.filter((entry) => entry.status === 'mapped');

  it('every mapped command has a slash action, or is in the explained whitelist', () => {
    const missing = mapped.map((entry) => entry.id).filter((id) => !(id in SLASH_ACTIONS) && !(id in NO_SLASH_ACTION));
    expect(missing).toEqual([]);
  });

  it('the whitelist holds no stale entries and every entry has a reason', () => {
    for (const [id, reason] of Object.entries(NO_SLASH_ACTION)) {
      expect(mapped.some((entry) => entry.id === id), `${id} is not a mapped command`).toBe(true);
      expect(reason.trim().length).toBeGreaterThan(0);
    }
  });

  it('"open the sidebar" is an allowed answer only where the matrix itself says the session list', () => {
    const sidebar = Object.entries(SLASH_ACTIONS).filter(([, action]) => action.do === 'sidebar').map(([id]) => id).sort();
    expect(sidebar).toEqual([...SIDEBAR_COMMANDS].sort());
    for (const id of SIDEBAR_COMMANDS) {
      expect(COMMAND_MATRIX.find((entry) => entry.id === id)?.target ?? '', id).toMatch(/sidebar|title|session list/i);
    }
  });

  it('a target that names the session ⋯ menu has a menu item that claims the command', () => {
    const claimed = menuMatrixIds();
    const unmet = mapped.filter((entry) => entry.target.includes('⋯ menu') && !claimed.has(entry.id)).map((entry) => entry.id);
    expect(unmet).toEqual([]);
  });

  it('and every menu item claim points at a real mapped command', () => {
    const ids = new Set(mapped.map((entry) => entry.id));
    for (const item of SESSION_MENU) for (const claimed of item.matrixIds) expect(ids.has(claimed), `${item.id} claims ${claimed}`).toBe(true);
  });

  it('no mapped target still refers to the retired "Session menu"', () => {
    expect(mapped.filter((entry) => /Session menu/.test(entry.target)).map((entry) => entry.id)).toEqual([]);
  });
});
