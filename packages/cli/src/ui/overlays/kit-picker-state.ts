/**
 * The `ctrl+K` list, as a pure view model (agent-model-kits §4.6 / D-10).
 *
 * ASCII ONLY - `src/ui/**` is inside `glyphs.test.ts::inScope`.
 *
 * WHY THE ROWS ARE COMPUTED HERE AND NOT IN THE COMPONENT: three surfaces print
 * the same three connections (this list, the settings manager, `/kit list`).
 * One function produces them, so the wording of "the fast tier is off" cannot
 * differ between the key the user pressed and the command they typed.
 */

import type { CliConfig, TeamConfig } from '../../config/schema.js';
import type { ModelProfilesConfig } from '../../config/model-profiles.js';
import { kitSlotConnections, type AgentKit, type KitConnection, type KitSlot }
  from '../../config/model-kits.js';
import { CURRENT_SETUP_NAME, type ActiveKit } from '../../config/kit-resolution.js';

export interface KitPickerRow {
  /** `null` = `Current setup` (the release action). */
  id: string | null;
  /** The one-line label, markers included. */
  label: string;
  /** Machine-checkable markers, so tests never grep a rendered string. */
  markers: { inUse: boolean; isDefault: boolean; modified: boolean };
  /** Non-empty when a referenced profile is gone. */
  missing: KitSlot[];
}

export interface KitPickerInput {
  library?: ModelProfilesConfig | undefined;
  active: ActiveKit;
}

function duplicateNames(kits: readonly AgentKit[]): Set<string> {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const kit of kits) {
    if (seen.has(kit.name)) repeated.add(kit.name);
    seen.add(kit.name);
  }
  return repeated;
}

/** `provider:model` plus the endpoint clause shared by every surface. */
export function connectionText(connection: KitConnection): string {
  const endpoint = connection.baseUrl ? hostOf(connection.baseUrl) : 'default URL';
  return `${connection.provider}:${connection.model}  ${endpoint}`;
}

function hostOf(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    return url.username || url.password || url.search || url.hash ? 'Invalid URL' : url.host;
  } catch { return 'Invalid URL'; }
}

/**
 * Rows in a FIXED order: `Current setup` first, then the library's own order.
 *
 * The first row never moves (AC-24) - it is the only row that can always be
 * chosen, and a list whose "off" entry wanders with the data is a list a user
 * has to read every single time.
 */
export function kitRows(input: KitPickerInput): KitPickerRow[] {
  const kits = input.library?.kits ?? [];
  const repeated = duplicateNames(kits);
  const rows: KitPickerRow[] = [{
    id: null,
    label: `${input.active.source === 'none' ? '[In use] ' : ''}${CURRENT_SETUP_NAME}`,
    markers: { inUse: input.active.source === 'none', isDefault: false, modified: false },
    missing: [],
  }];
  for (const kit of kits) {
    const inUse = input.active.source !== 'none' && input.active.id === kit.id;
    const isDefault = (input.library?.defaultKitId ?? null) === kit.id;
    const modified = inUse && input.active.modified;
    const missing = inUse ? input.active.missingProfiles : [];
    // A DUPLICATE NAME gets its id prefix, exactly as the profile picker does:
    // two rows reading `Cheap` would make Enter a coin flip.
    const identity = repeated.has(kit.name) ? `#${kit.id.slice(0, 8)} ` : '';
    const markers = [inUse ? '[In use]' : '', isDefault ? '[Default]' : '']
      .filter(Boolean).join(' ');
    rows.push({
      id: kit.id,
      label: `${identity}${markers ? `${markers} ` : ''}${kit.name}${modified ? '~' : ''}`,
      markers: { inUse, isDefault, modified },
      missing,
    });
  }
  return rows;
}

/**
 * The three bindings `Current setup` describes.
 *
 * STRUCTURAL, NOT `CliConfig`: the caller hands in the PERSISTED config for this
 * block (§4.6), because the live config no longer holds the file's bindings once
 * a session kit is applied - it mirrors the kit (I-6). Both shapes satisfy this
 * interface, so neither layer has to convert anything.
 */
export interface KitConnectionsSource {
  provider: string;
  model: string;
  team?: { model: TeamConfig['model']; modelProfileId?: string | null } | undefined;
  fast: { enabled: boolean; provider: string; model: string };
  modelProfiles?: ModelProfilesConfig | undefined;
}

function subagentText(config: KitConnectionsSource): string {
  const mode = config.team?.model ?? 'main';
  if (mode === 'main') return 'same as main';
  if (mode === 'fast') return 'fast tier model';
  const id = config.team?.modelProfileId ?? null;
  const entry = id ? config.modelProfiles?.entries.find((item) => item.id === id) : undefined;
  return entry ? `profile ${entry.name}` : 'Profile missing';
}

/** The three lines under the focused row (§4.6). */
export function kitDetail(input: {
  row: KitPickerRow;
  library?: ModelProfilesConfig | undefined;
  config: CliConfig;
  /** The config file's copy of the bindings; see the `Current setup` note below. */
  diskConfig?: KitConnectionsSource | undefined;
}): string[] {
  const { row, library, config } = input;
  const kit = row.id ? (library?.kits ?? []).find((item) => item.id === row.id) : undefined;
  if (!kit) {
    // `Current setup` describes the FILE's bindings - what the next process
    // would run - because that is exactly what choosing it restores.
    //
    // THE LIVE CONFIG IS THE WRONG SOURCE WHILE A SESSION KIT IS HELD: it mirrors
    // the kit (I-6), so this block would print the current values and thereby
    // promise that releasing the kit changes nothing. The first row is the only
    // row whose whole meaning is "what the file says", so it is the only one that
    // has to be read from the file.
    const file = input.diskConfig ?? config;
    const fast = file.fast.enabled
      ? `${file.fast.provider || file.provider}:${file.fast.model || '(not set)'}`
      : 'off';
    return [`main      ${file.provider}:${file.model}`,
      `subagent  ${subagentText(file)}`,
      `fast      ${fast}`];
  }
  const connections = kitSlotConnections(library, kit);
  const mainLine = connections.main ? connectionText(connections.main) : 'Profile missing';
  const fastLine = kit.fastProfileId === null ? 'off (this kit turns the tier off)'
    : connections.fast ? `${connectionText(connections.fast)}  tier on` : 'Profile missing';
  // THE SUBAGENT LINE REUSES THE SLOT'S OWN THREE-STATE VOCABULARY (`same as main`
  // / `fast tier` / a profile), so this block and the settings screen's subagent
  // row cannot say different things about the same kit.
  const subagentLine = kit.subagent.model === 'main' ? 'same as main'
    : kit.subagent.model === 'fast'
      ? (connections.fast ? 'fast tier' : 'fast tier (off - falls back to main)')
      : connections.subagent.name
        ? `profile ${connections.subagent.name}  ${connections.subagent.provider}:${
          connections.subagent.model}` : 'Profile missing';
  return [`main      ${mainLine}`, `subagent  ${subagentLine}`, `fast      ${fastLine}`];
}

/**
 * The footer. `busy` is a warning, never a reason to hide the list (§4.7).
 *
 * THE LAST CLAUSE IS D-7, VERBATIM: this overlay is a session-only surface, so it
 * says where the persistence actually lives. Without it the natural reading of
 * `Enter` is "make this my default", and D-7 exists to keep that action one
 * deliberate trip to `/settings` instead of one keystroke next to a browse key.
 * It is LAST so that a 40-column terminal clips the pointer, never the action.
 */
export function kitPickHint(input: { busy: boolean; hasKits: boolean }): string {
  if (!input.hasKits) return 'Esc close | Create a kit in /settings';
  if (input.busy) {
    return 'Enter use for this session (blocked while running) | Esc close'
      + ' | Set a default in /settings';
  }
  return 'Enter use for this session | Esc close | Set a default in /settings';
}

/** The one guidance row an empty library renders (AC-26). */
export const NO_KITS_HINT = 'No kits yet. Create one in /settings (Settings > Kit pack).';
