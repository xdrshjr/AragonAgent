/**
 * The settings screen's kit pages: manager rows, the editor draft, and the ONE
 * reducer that turns intents into draft mutations (agent-model-kits §4.5).
 *
 * ASCII ONLY - `src/ui/**` is inside `glyphs.test.ts::inScope`.
 *
 * TWO REDUCERS, ONE PAGE AXIS. `modelProfileReducer` owns the profile pages and
 * `kitReducer` owns kit data; both return the same `ModelProfileState`, so the
 * screen still has exactly one state object and one Save button. The alternative
 * - a second state machine inside `SettingsScreen.tsx`, which is already over the
 * 1000-line cap - is what this module exists to avoid.
 *
 * NOTHING HERE WRITES ANYTHING: every action mutates the transaction draft and
 * sets `dirty`. `Save` stays the only writer (F-7/F-10).
 */

import type { KitSlot, AgentKit, KitSlotConnections, SessionKitState }
  from '../../model/config/model-kits.js';
import { KIT_LIMITS, createAgentKit, duplicateAgentKit, findKit, kitCandidate,
  kitSlotConnections } from '../../model/config/model-kits.js';
import { resolveActiveKit } from '../../model/config/kit-resolution.js';
import { emptyModelProfiles } from '../../model/config/model-profiles.js';
import type { ModelProfilesConfig, ModelRole } from '../../model/config/model-profiles.js';
import type { CliConfig } from '../../model/config/schema.js';
import type { SubagentModelMode } from '../../model/team/model.js';
import type { ModelProfileState } from './model-profile-state.js';

export interface KitDraft {
  /** `null` while creating; the delete confirmation reuses this field as its id. */
  id: string | null;
  name: string;
  mainProfileId: string;
  /** `null` = this kit turns the fast tier off (D-8). */
  fastProfileId: string | null;
  subagent: { model: SubagentModelMode; modelProfileId: string | null };
  /** Which slot the profile picker is choosing for; `null` on the editor page. */
  slot: KitSlot | null;
  error?: string;
  /** The row the cursor jumps to when `error` is set (focus-lands-on-error). */
  field?: KitSlot | 'name';
}

export type KitAction =
  | { type: 'kit-open'; id: string | null }
  | { type: 'kit-name'; value: string }
  | { type: 'kit-slot'; slot: KitSlot }
  | { type: 'kit-main'; id: string | null }
  | { type: 'kit-fast'; id: string | null }
  | { type: 'kit-subagent'; model: SubagentModelMode; modelProfileId: string | null }
  | { type: 'kit-save' }
  | { type: 'kit-cancel' }
  | { type: 'kit-duplicate'; id: string }
  | { type: 'kit-delete'; id: string }
  | { type: 'kit-confirm-delete' }
  | { type: 'kit-apply'; id: string }
  | { type: 'kit-default'; id: string };

/** The library the transaction would save, with a read error falling back to empty. */
export function draftLibrary(state: ModelProfileState): ModelProfilesConfig {
  return state.draft.profiles ?? emptyModelProfiles();
}

function kitsOf(state: ModelProfileState): AgentKit[] { return draftLibrary(state).kits ?? []; }

export function findKitInState(state: ModelProfileState, id: string | null): AgentKit | undefined {
  return id ? findKit(draftLibrary(state), id) : undefined;
}

/**
 * Open the editor on an existing kit, or on a PREFILLED new one (§4.10).
 *
 * THE FIRST KIT IS NEVER A BLANK FORM (D-13): it starts from the three bindings
 * this machine already runs, so "create a kit" is one rename and one Save. When
 * no Main profile is bound the kit starts with an empty main slot and Save
 * refuses - the picker's own `Create profile` action is where a profile is born,
 * which keeps this module free of the profile-creating code path.
 */
export function openKitDraft(state: ModelProfileState, id: string | null): KitDraft {
  const existing = findKitInState(state, id);
  if (existing) {
    return { id: existing.id, name: existing.name, mainProfileId: existing.mainProfileId,
      fastProfileId: existing.fastProfileId,
      subagent: { ...existing.subagent }, slot: null };
  }
  const library = draftLibrary(state);
  const team = state.draft.baseline.team;
  return {
    id: null,
    name: `Kit ${kitsOf(state).length + 1}`,
    mainProfileId: library.mainId ?? '',
    // `fastId` alone is not enough: a tier that is switched OFF is off, and
    // prefilling its endpoint would silently turn it back on at the first Save.
    fastProfileId: state.draft.baseline.fast.enabled ? library.fastId ?? null : null,
    subagent: { model: team.model, modelProfileId: team.modelProfileId ?? null },
    slot: null,
  };
}

function withDraft(state: ModelProfileState, kitDraft: KitDraft): ModelProfileState {
  return { ...state, kitDraft, error: undefined };
}

function saveKitDraft(state: ModelProfileState): ModelProfileState {
  const kitDraft = state.kitDraft;
  if (!kitDraft) return state;
  const name = [...kitDraft.name.trim()];
  if (!name.length) {
    return withDraft(state, { ...kitDraft, error: 'Name: enter a name for this kit.',
      field: 'name' });
  }
  if (!kitDraft.mainProfileId) {
    return withDraft(state, { ...kitDraft, error: 'Main profile: choose a profile.',
      field: 'main' });
  }
  if (kitDraft.subagent.model === 'profile' && !kitDraft.subagent.modelProfileId) {
    return withDraft(state, { ...kitDraft, error: 'Subagent: choose a profile.',
      field: 'subagent' });
  }
  const library = draftLibrary(state);
  const kits = library.kits ?? [];
  const fields = { name: name.slice(0, KIT_LIMITS.nameMaxChars).join(''),
    mainProfileId: kitDraft.mainProfileId, fastProfileId: kitDraft.fastProfileId,
    subagent: { ...kitDraft.subagent } };
  let merged: AgentKit[];
  if (kitDraft.id) {
    const existing = kits.find((kit) => kit.id === kitDraft.id);
    if (!existing) return { ...state, page: 'kits', kitDraft: undefined };
    merged = kits.map((kit) => (kit.id === kitDraft.id ? { ...existing, ...fields } : kit));
  } else {
    if (kits.length >= KIT_LIMITS.maxKits) {
      return withDraft(state, { ...kitDraft,
        error: `Maximum ${KIT_LIMITS.maxKits} kits. Delete an unused kit first.` });
    }
    merged = [...kits, createAgentKit(fields)];
  }
  return { ...state, page: 'kits', kitDraft: undefined, dirty: true,
    draft: { ...state.draft, profiles: { ...library, kits: merged } } };
}

/** Exit A: the kit's three slots become the draft's bindings (§4.2). */
function applyKitToDraft(state: ModelProfileState, id: string, asDefault: boolean):
ModelProfileState {
  const library = draftLibrary(state);
  const kit = findKit(library, id);
  if (!kit) return state;
  const patch = kitCandidate({ library, kit, ...(asDefault ? { defaultKitId: kit.id } : {}) });
  return { ...state, dirty: true, page: 'kits', kitDraft: undefined,
    draft: { ...state.draft,
      profiles: patch.modelProfiles,
      patch: { ...state.draft.patch, team: patch.team,
        fast: { ...state.draft.patch.fast, ...patch.fast } },
      // I-13: a kit that turns the tier off must NOT project the fast role.
      activateRoles: [...new Set<ModelRole>([...state.draft.activateRoles,
        'main', ...(kit.fastProfileId === null ? [] : ['fast'] as const)])],
      // The transaction now decides all three slots, so the session kit is done
      // (§4.3 row 4). Leaving it held would make the save ambiguous.
      sessionKit: null } };
}

function removeKit(state: ModelProfileState, id: string): ModelProfileState {
  const library = draftLibrary(state);
  const remaining = (library.kits ?? []).filter((kit) => kit.id !== id);
  const released = state.draft.sessionKit?.id === id ? null : state.draft.sessionKit;
  return { ...state, page: 'kits', kitDraft: undefined, dirty: true,
    draft: { ...state.draft, sessionKit: released,
      profiles: { ...library, kits: remaining,
        defaultKitId: (library.defaultKitId ?? null) === id ? null : library.defaultKitId } } };
}

/** Every kit-page intent, applied to the ONE draft. */
export function kitReducer(state: ModelProfileState, action: KitAction): ModelProfileState {
  const kitDraft = state.kitDraft;
  switch (action.type) {
    case 'kit-open':
      return { ...state, page: 'kit-edit', error: undefined,
        kitDraft: openKitDraft(state, action.id) };
    case 'kit-name':
      if (!kitDraft) return state;
      // Control characters are stripped at the boundary rather than refused: a
      // pasted name with a stray newline should become a name, not an error.
      return withDraft(state, { ...kitDraft,
        name: [...action.value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')]
          .slice(0, KIT_LIMITS.nameMaxChars).join(''), error: undefined });
    case 'kit-slot':
      return kitDraft ? { ...state, page: 'kit-slot',
        kitDraft: { ...kitDraft, slot: action.slot } } : state;
    case 'kit-main':
      return kitDraft ? { ...state, page: 'kit-edit',
        kitDraft: { ...kitDraft, mainProfileId: action.id ?? '', slot: null, error: undefined } }
        : state;
    case 'kit-fast':
      return kitDraft ? { ...state, page: 'kit-edit',
        kitDraft: { ...kitDraft, fastProfileId: action.id, slot: null, error: undefined } } : state;
    case 'kit-subagent':
      return kitDraft ? { ...state, page: 'kit-edit', kitDraft: { ...kitDraft,
        subagent: { model: action.model, modelProfileId: action.modelProfileId },
        slot: null, error: undefined } } : state;
    case 'kit-save': return saveKitDraft(state);
    case 'kit-cancel': return { ...state, page: 'kits', kitDraft: undefined, error: undefined };
    case 'kit-duplicate': {
      const library = draftLibrary(state);
      const original = findKit(library, action.id);
      if (!original || (library.kits ?? []).length >= KIT_LIMITS.maxKits) return state;
      return { ...state, page: 'kits', dirty: true, draft: { ...state.draft,
        profiles: { ...library,
          kits: [...(library.kits ?? []), duplicateAgentKit(original, library.kits ?? [])] } } };
    }
    case 'kit-delete': return { ...state, page: 'kit-delete',
      kitDraft: { ...(kitDraft ?? openKitDraft(state, action.id)), id: action.id } };
    case 'kit-confirm-delete': return kitDraft?.id ? removeKit(state, kitDraft.id) : state;
    case 'kit-apply': return applyKitToDraft(state, action.id, false);
    case 'kit-default': return applyKitToDraft(state, action.id, true);
    default: return state;
  }
}

/** One manager row: the label with its markers, plus the three-slot summary. */
export interface KitManagerRow {
  id: string;
  label: string;
  summary: string;
  isDefault: boolean;
  inUse: boolean;
}

function shortConnection(connection: KitSlotConnections['main']): string {
  return connection ? `${connection.provider}:${connection.model}` : 'Profile missing';
}

function subagentSummary(connections: KitSlotConnections, kit: AgentKit): string {
  if (kit.subagent.model === 'main') return 'same as main';
  if (kit.subagent.model === 'fast') return 'fast tier';
  return connections.subagent.name ? `profile ${connections.subagent.name}` : 'Profile missing';
}

/** Rows in library order, each with the markers the picker also uses (§4.5). */
export function kitManagerRows(state: ModelProfileState): KitManagerRow[] {
  const library = draftLibrary(state);
  return (library.kits ?? []).map((kit) => {
    const connections = kitSlotConnections(library, kit);
    const isDefault = (library.defaultKitId ?? null) === kit.id;
    const inUse = state.draft.sessionKit?.id === kit.id;
    const markers = [isDefault ? '[Default]' : '', inUse ? '[In use]' : '']
      .filter(Boolean).join(' ');
    const fast = kit.fastProfileId === null ? 'off' : shortConnection(connections.fast);
    return {
      id: kit.id,
      label: `${markers ? `${markers} ` : ''}${kit.name}`,
      summary: [shortConnection(connections.main), fast, subagentSummary(connections, kit)]
        .join(' | '),
      isDefault,
      inUse,
    };
  });
}

/**
 * Whether the kit this transaction opened on had already drifted (§4.8).
 *
 * READ FROM `liveBaseline`, i.e. the config the screen was opened over, because
 * drift is a fact about the SESSION - the draft cannot change a connection
 * without releasing the slot, so there is nothing newer to look at.
 */
function liveDrift(state: ModelProfileState, session: SessionKitState): boolean {
  // THE DRAFT'S `held`, NOT `liveBaseline.sessionKit`: the transaction may already
  // have given slots back, and the row has to describe THIS transaction.
  const live = resolveActiveKit({ ...state.draft.liveBaseline, sessionKit: session });
  return live.source === 'session' && live.modified;
}

/**
 * The `Kit pack` root row's five states (§4.5 table, AC-27).
 *
 * READ FROM THE DRAFT, not from the live config: the row sits inside a
 * transaction, and showing the saved state under a pending selection is how a
 * settings screen lies to the user about what `Save` is going to do.
 */
export function kitPackRow(state: ModelProfileState): string {
  const library = draftLibrary(state);
  const kits = library.kits ?? [];
  const session = state.draft.sessionKit;
  const sessionKit = session ? findKit(library, session.id) : undefined;
  const defaultKit = findKit(library, library.defaultKitId ?? null);
  const defaultClause = defaultKit ? `  (default: ${defaultKit.name})` : '';
  if (sessionKit && session) {
    const partial = session.held.length < 3;
    const held = partial ? `: ${session.held.join('+')}` : '';
    // THE SAME `~` THE CHIP SHOWS (D-12): dropping a slot is only ONE way to
    // drift. The other is a connection that `/model`, `/fast` or the settings
    // `Subagent model` row rewrote after the kit was applied, and a row that
    // stayed silent about that
    // would disagree with the status bar about the same session.
    const drift = liveDrift(state, session) ? '~' : '';
    return `${sessionKit.name}  [session${held}]${drift}${defaultClause}`;
  }
  if (defaultKit) return `${defaultKit.name}  [default]`;
  return kits.length ? 'Current setup' : 'Current setup  (no kit yet)';
}

/** Which of the three root rows must show the KIT's value, and under which name. */
export interface HeldSlots {
  kitName: string | null;
  /** The slots the session kit still owns; `mainId`/`fastId` are only meaningful
   *  for a slot in this list (`null` means "this kit turns the tier off"). */
  held: KitSlot[];
  mainId: string | null;
  fastId: string | null;
  subagent: { model: SubagentModelMode; modelProfileId: string | null } | null;
}

/**
 * The held slots' EFFECTIVE values (RV-P0-2).
 *
 * WITHOUT THIS the root page shows the file's bindings while the header shows the
 * kit's, and the only conclusion available to the user is that one of them is
 * broken. `Enter` on any of these rows writes an explicit choice, which releases
 * that slot - so "what you see is what you change" stays true.
 */
export function heldSlots(state: ModelProfileState): HeldSlots {
  const session = state.draft.sessionKit;
  const kit = session ? findKitInState(state, session.id) : undefined;
  if (!session || !kit) {
    return { kitName: null, held: [], mainId: null, fastId: null, subagent: null };
  }
  const held = session.held;
  return {
    kitName: kit.name,
    held,
    mainId: held.includes('main') ? kit.mainProfileId : null,
    fastId: held.includes('fast') ? kit.fastProfileId : null,
    subagent: held.includes('subagent') ? { ...kit.subagent } : null,
  };
}
