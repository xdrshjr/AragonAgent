import { randomUUID } from 'node:crypto';
import { emptyModelProfiles, duplicateModelProfile, normalizeModelProfiles,
  validateModelProfiles, type ModelProfile, type ModelProfilesConfig,
  type ModelRole } from '../../model/config/model-profiles.js';
import type { AgentKit, KitSlot } from '../../model/config/model-kits.js';
import { parseContextWindowInput } from '../../model/config/schema.js';
import type { ModelSettingsDraft } from '../../model/config/model-settings-types.js';
import type { SubagentModelMode } from '../../model/team/model.js';
import type { KitDraft } from './kit-settings-state.js';
import { stepFanoutValue, teamFanoutValues, type TeamFanoutField }
  from './team-fanout-state.js';
import { draftGovernance, stepGovernanceSetting, type GovernanceSettingKey }
  from './governance-settings.js';

export type ProfilePage = 'root' | 'picker' | 'manager' | 'editor' | 'models'
  | 'delete-confirm' | 'discard-confirm'
  | 'kits' | 'kit-edit' | 'kit-slot' | 'kit-delete' | 'team' | 'governance';
/**
 * `'team'` is the fan-out page (subagent-fanout D-5), and it is a PAGE rather
 * than three more fields on the root page for a measurable reason: the root page
 * already scrolls on a 24-row terminal, and three arrows-adjustable rows would
 * push `Save` and `Reload` off the first screen on every machine.
 */
/**
 * Which role a PROFILE PICKER page is choosing for.
 *
 * `'subagent'` is a PICKER-ONLY role (subagent-model 6.2): `ModelRole` stays
 * `'main' | 'fast'` because it is the type basis of the config layer's
 * `${role}Id` template keys - widening it would invent a `subagentId` library
 * key nothing reads. The subagent picker writes `draft.patch.team` instead.
 *
 * `'binding'` IS A KIT SLOT CHOOSER (agent-model-kits §4.5): a plain profile
 * list with no `Current custom` row, no built-in rows and one `Create profile`
 * action. A kit slot can only ever name a profile, so offering "no profile" as a
 * choice there would be offering an invalid kit.
 */
export type ProfilePickerRole = ModelRole | 'subagent' | 'binding';

/** The picker's built-in `Fast tier model` row; never a profile id on disk. */
export const SUBAGENT_FAST_ROW_ID = '__fast__';
export interface ProfileEditorDraft {
  original: ModelProfile;
  name: string;
  provider: string;
  model: string;
  /** Text exactly as typed; `''` renders `(auto)` and parses to AUTO (§6.5). */
  contextWindow: string;
  baseUrl: string;
  credentialMode: 'keep' | 'replace' | 'shared';
  apiKey: string;
  endpointChanged: boolean;
}
export interface ModelProfileState {
  draft: ModelSettingsDraft;
  page: ProfilePage;
  role: ProfilePickerRole;
  editor?: ProfileEditorDraft;
  /**
   * Where the editor and the delete confirmation hand control back.
   *
   * `'kit-slot'` JOINS `'picker'` (agent-model-kits §4.5): the kit slot chooser
   * is a profile picker too, and its `Create profile` action must return to the
   * slot it was creating for rather than to the profile manager.
   */
  returnPage: 'picker' | 'manager' | 'kit-slot';
  bindNew: boolean;
  dirty: boolean;
  error?: string;
  deleteId?: string;
  /** Who referenced the entry being deleted ('Main + Subagent', or ''). */
  deleteUsers?: string;
  /**
   * The kit editor's own draft (agent-model-kits §4.5), owned by `kitReducer`.
   *
   * ONE FIELD, NOT A SECOND STATE OBJECT: the page axis stays shared, so `Save`
   * and `Esc` mean the same thing on every page of this screen.
   */
  kitDraft?: KitDraft;
}
export type ModelProfileAction =
  | { type: 'page'; page: ProfilePage; role?: ProfilePickerRole }
  | { type: 'select'; role: ProfilePickerRole; id: string | null }
  | { type: 'edit'; profile: ModelProfile; bindNew?: boolean }
  | { type: 'editor-field'; field: keyof Omit<ProfileEditorDraft, 'original' | 'endpointChanged'>;
      value: string }
  | { type: 'retain-key' }
  | { type: 'merge-editor' }
  | { type: 'cancel-editor' }
  /**
   * The ONE write path for a discovered model (§6.3 / D-2 / D-3): only `model`
   * changes - never the credential, never the context window, never the draft.
   */
  | { type: 'choose-model'; model: string }
  | { type: 'duplicate'; id: string }
  | { type: 'delete'; id: string }
  | { type: 'confirm-delete' }
  | { type: 'reload'; draft: ModelSettingsDraft }
  /**
   * One arrow press on the fan-out page (subagent-fanout 3.4.2).
   *
   * The reducer, not the page, owns the write: the page holds a cursor and
   * nothing else, so there is exactly one place a draft can change.
   */
  | { type: 'team-fanout'; field: TeamFanoutField; delta: -1 | 1 }
  | { type: 'governance-step'; key: GovernanceSettingKey; delta: -1 | 1 };

/** Keep the original secret separate from the empty replacement field. */
export function createProfileEditor(profile: ModelProfile): ProfileEditorDraft {
  return { original: { ...profile }, name: profile.name, provider: profile.provider,
    model: profile.model, baseUrl: profile.baseUrl ?? '', apiKey: '',
    contextWindow: profile.contextWindow === null ? '' : String(profile.contextWindow),
    credentialMode: profile.apiKey ? 'keep' : 'shared', endpointChanged: false };
}
/** Validate locally before merging the child form into the root transaction. */
export function finishProfileEditor(editor: ProfileEditorDraft):
{ profile?: ModelProfile; error?: string; field?: string } {
  // STRICT IN THE UI, TOLERANT ON DISK (§6.5 / invariant 4): a typo is refused
  // here with an inline error and the focus jump its `field` enables; it never
  // reaches the draft. The message prefix matches the editor's LABELS row.
  const window = parseContextWindowInput(editor.contextWindow);
  if (window.kind === 'invalid') {
    return { error: 'Context window: use a number or auto.', field: 'contextWindow' };
  }
  const profile: ModelProfile = { id: editor.original.id, name: editor.name.trim(),
    provider: editor.provider, model: editor.model.trim(), baseUrl: editor.baseUrl.trim() || null,
    apiKey: editor.credentialMode === 'keep' ? editor.original.apiKey
      : editor.credentialMode === 'replace' ? editor.apiKey.trim() : null,
    contextWindow: window.kind === 'auto' ? null : window.value };
  const library = { ...emptyModelProfiles(), entries: [profile] };
  const issue = validateModelProfiles(library)[0];
  if (issue) return { error: issue.message, field: issue.path.split('.').at(-1) };
  return { profile: normalizeModelProfiles(library).entries[0]! };
}
/** Make an isolated root draft; opening the screen never mutates live config. */
export function createModelProfileState(draft: ModelSettingsDraft): ModelProfileState {
  const copy = structuredClone(draft);
  if (validateModelProfiles(copy.profiles).length
    || validateModelProfiles(copy.baseline.modelProfiles).length) {
    copy.profiles = undefined;
    copy.readError = 'invalid_profiles';
  }
  return { draft: copy, page: 'root', role: 'main', returnPage: 'manager',
    bindNew: false, dirty: false };
}
/** The kits whose three slots name `id`, for the delete confirmation (D-9). */
export function kitsUsingProfile(profiles: ModelProfilesConfig | undefined,
  id: string): AgentKit[] {
  return (profiles?.kits ?? []).filter((kit) => kit.mainProfileId === id
    || kit.fastProfileId === id
    || (kit.subagent.model === 'profile' && kit.subagent.modelProfileId === id));
}

/**
 * Drop `slot` from the session kit (§4.3 row 2 / AC-38).
 *
 * THE DRAFT IS NARROWED HERE, NOT ONLY AT SAVE TIME. `releasedSlots` already
 * strips the same slot from the transaction before it commits, but the ROOT PAGE
 * paints the kit's effective value for every HELD slot - so without this line a
 * user picks a profile and the row keeps showing the one they just replaced,
 * which is the most confusing thing a settings screen can do. Releasing the last
 * slot ends the kit: `held: []` is not a state any surface can render.
 */
function releaseHeldSlot(draft: ModelSettingsDraft, slot: KitSlot): ModelSettingsDraft {
  const current = draft.sessionKit;
  if (!current || !current.held.includes(slot)) return draft;
  const held = current.held.filter((item) => item !== slot);
  return { ...draft, sessionKit: held.length ? { id: current.id, held } : null };
}

/** Describe references using text so ASCII and no-color modes remain usable. */
export function profileUsers(profiles: ModelProfilesConfig | undefined, id: string,
  subagentProfileId?: string | null): string {
  // THE KITS ARE REFERENCES TOO (D-9 / RV-P2-6): "Main + kit "Deep work"" is what
  // makes the confirmation honest, because deleting this entry also deletes that
  // kit. The empty case must stay empty - a leading ` + ` is what a naive
  // `join` after an unconditional push produces.
  return [profiles?.mainId === id ? 'Main' : '', profiles?.fastId === id ? 'Fast' : '',
    subagentProfileId === id ? 'Subagent' : '',
    ...kitsUsingProfile(profiles, id).map((kit) => `kit "${kit.name}"`)]
    .filter(Boolean).join(' + ');
}

/**
 * The team section a draft would save: the patch first, then the disk baseline
 * (subagent-model §3.6). The explicit-`undefined` test is what makes an
 * explicit `null` in the patch win over the baseline - `??` would fold it away.
 */
export function draftTeam(draft: ModelSettingsDraft): {
  model: SubagentModelMode; modelProfileId: string | null;
} {
  const patch = draft.patch.team;
  const baseline = draft.baseline.team;
  return {
    model: patch?.model !== undefined ? patch.model : baseline?.model ?? 'main',
    modelProfileId: patch?.modelProfileId !== undefined ? patch.modelProfileId
      : baseline?.modelProfileId ?? null,
  };
}

/** The profile id the draft's team section binds, for reference checks (3.7). */
export function draftSubagentProfileId(draft: ModelSettingsDraft): string | null {
  return draftTeam(draft).model === 'profile' ? draftTeam(draft).modelProfileId : null;
}

/** The projected picker selection for the subagent role (6.2). */
export function subagentSelectedId(draft: ModelSettingsDraft): string | null {
  const team = draftTeam(draft);
  if (team.model === 'profile') return team.modelProfileId;
  return team.model === 'fast' ? SUBAGENT_FAST_ROW_ID : null;
}

/** What the settings root row and `/team`'s status lines show for the current mode. */
export interface SubagentModelSummaryInput {
  mode: SubagentModelMode;
  modelProfileId: string | null;
  /** `<provider>:<model>` of the connection the main role runs on. */
  mainConnection: string;
  /** The fast tier's `<provider>:<model>`, or null when it does not resolve. */
  fastConnection: string | null;
  profiles: ModelProfilesConfig | undefined;
  /**
   * KEY EXISTENCE AS THE SETTINGS SCREEN SEES IT (V-10): derived from the
   * config-file keys, exactly like the `name()` row and `fastTierLine` beside
   * it. A key that exists ONLY as an environment variable is invisible here,
   * so an env-key user may see `(off ...)` / `[Missing API key]` where the
   * runtime would succeed - the accepted approximation both sibling lines
   * already ship.
   */
  hasKey: (providerId: string) => boolean;
}
export function subagentModelSummary(input: SubagentModelSummaryInput): string {
  if (input.mode === 'main') return `Same as main (${input.mainConnection})`;
  if (input.mode === 'fast') {
    return input.fastConnection
      ? `Fast tier (${input.fastConnection})`
      : 'Fast tier (off - falls back to main)';
  }
  const entry = input.modelProfileId
    ? input.profiles?.entries.find((candidate) => candidate.id === input.modelProfileId)
    : undefined;
  if (!entry) return 'Profile missing - falls back to main';
  const missing = !entry.apiKey && !input.hasKey(entry.provider);
  return `${entry.name}  ${entry.provider}:${entry.model}${missing ? ' [Missing API key]' : ''}`;
}
/** Adopt persisted fields only, resolving the old fast inheritance once. */
export function createCustomProfile(draft: ModelSettingsDraft,
  role: ModelRole): ModelProfile {
  const file = draft.baseline;
  const provider = (role === 'fast' ? file.fast?.provider : undefined)
    || file.provider || 'anthropic';
  const model = role === 'fast' ? file.fast?.model ?? '' : file.model ?? '';
  const baseUrl = role === 'fast' && !model ? null
    : (role === 'fast' ? file.fast?.baseUrl
      || (provider === (file.provider || 'anthropic') ? file.baseUrl : null)
      : file.baseUrl) || null;
  return { id: randomUUID(), name: '', provider, model, baseUrl,
    apiKey: role === 'fast' && !model ? null : file.apiKeys?.[provider] || null,
    // Carry the user's existing top-level correction into the first profile
    // (§6.5): binding an AUTO profile would otherwise silently retire it
    // (tradeoff B's migration risk, mitigated exactly here).
    contextWindow: file.contextWindow ?? null };
}
function editField(state: ModelProfileState,
  action: Extract<ModelProfileAction, { type: 'editor-field' }>): ModelProfileState {
  if (!state.editor) return state;
  const editor = { ...state.editor, [action.field]: action.value } as ProfileEditorDraft;
  if (action.field === 'provider' || action.field === 'baseUrl') {
    editor.apiKey = '';
    editor.credentialMode = 'shared';
    editor.endpointChanged = true;
  }
  if (action.field === 'credentialMode' && action.value !== 'replace') editor.apiKey = '';
  return { ...state, editor, error: undefined };
}
function mergeEditor(state: ModelProfileState): ModelProfileState {
  if (!state.editor) return state;
  const result = finishProfileEditor(state.editor);
  if (!result.profile) return { ...state, error: result.error };
  const library = state.draft.profiles ?? emptyModelProfiles();
  const exists = library.entries.some((entry) => entry.id === result.profile!.id);
  if (!exists && library.entries.length >= 200) return { ...state,
    error: 'Maximum 200 profiles. Delete an unused profile first.' };
  const profiles = { ...library, entries: exists
    ? library.entries.map((entry) => entry.id === result.profile!.id ? result.profile! : entry)
    : [...library.entries, result.profile] };
  const merged = { ...state, draft: { ...state.draft, profiles }, dirty: true,
    editor: undefined, page: state.returnPage, error: undefined };
  return state.bindNew ? modelProfileReducer(merged,
    { type: 'select', role: state.role, id: result.profile.id }) : merged;
}
/** All child actions modify only the root draft; persistence belongs to Save. */
export function modelProfileReducer(state: ModelProfileState,
  action: ModelProfileAction): ModelProfileState {
  const library = state.draft.profiles ?? emptyModelProfiles();
  switch (action.type) {
    case 'reload': return createModelProfileState(action.draft);
    case 'page': return { ...state, page: action.page, role: action.role ?? state.role,
      error: undefined };
    case 'select': {
      // THE SUBAGENT BRANCH (D-5): selection writes the DRAFT's team patch -
      // `profiles` and `activateRoles` are untouched, because 'subagent' is a
      // picker-only role with no `${role}Id` library key (6.2). Save is the
      // one place the patch ever reaches disk (I-5).
      if (action.role === 'subagent') {
        const team = action.id === null
          ? { model: 'main' as const, modelProfileId: null }
          : action.id === SUBAGENT_FAST_ROW_ID
            ? { model: 'fast' as const, modelProfileId: null }
            : { model: 'profile' as const, modelProfileId: action.id };
        return { ...state, page: 'root', dirty: true, error: undefined,
          draft: releaseHeldSlot({ ...state.draft,
            patch: { ...state.draft.patch, team } }, 'subagent') };
      }
      // `'binding'` NEVER REACHES THIS REDUCER: a kit slot's choice is applied
      // by `kitReducer` (`kit-main` / `kit-fast`), because the value belongs to
      // an editor draft rather than to a `${role}Id` library key. Returning the
      // state unchanged is the honest answer to an impossible action.
      if (action.role === 'binding') return state;
      return { ...state, page: 'root', dirty: true, error: undefined,
        draft: releaseHeldSlot({ ...state.draft,
          profiles: { ...library, [`${action.role}Id`]: action.id },
          activateRoles: [...new Set([...state.draft.activateRoles, action.role])] },
          action.role) };
    }
    case 'edit': return { ...state, editor: createProfileEditor(action.profile), page: 'editor',
      // A PROFILE BORN IN A KIT SLOT RETURNS TO THAT SLOT (§4.5): the picker's
      // `Create profile` action is the only way to invent one and it is offered on
      // the kit's slot chooser - landing in the profile MANAGER there would
      // abandon the half-built kit behind a page the user never asked for.
      returnPage: state.page === 'picker' || state.page === 'kit-slot'
        ? state.page : 'manager',
      bindNew: action.bindNew ?? false, error: undefined };
    case 'editor-field': return editField(state, action);
    case 'retain-key': return state.editor?.original.apiKey ? { ...state,
      editor: { ...state.editor, credentialMode: 'keep', apiKey: '' } } : state;
    case 'merge-editor': return mergeEditor(state);
    case 'choose-model': {
      // Legal ONLY from the list page (§7). `editor-field` would do the same thing,
      // but routing the list page through the generic field action would also let a
      // future `editField` side effect (key reset, endpoint flag) fire on a choice
      // that never touched the endpoint.
      if (!state.editor || state.page !== 'models') return state;
      return { ...state, page: 'editor', error: undefined,
        editor: { ...state.editor, model: action.model } };
    }
    case 'cancel-editor': return { ...state, editor: undefined, page: state.returnPage,
      error: undefined };
    case 'team-fanout': {
      // THE FRAGMENT IS THE ONLY THING WRITTEN (D-17 / R-P0-1). `stepFanoutValue`
      // returns `Partial<TeamFanoutPatch>`, so `model` and `modelProfileId` - the
      // two keys `releasedSlots` reads as "the user re-decided the subagent slot" -
      // cannot enter the patch from here. `teamFanoutValues` is the CLAMPED view
      // (R-P0-2), so a step starts from the number the user is looking at.
      const step = stepFanoutValue(teamFanoutValues(state.draft), action.field, action.delta);
      return { ...state, dirty: true, error: undefined,
        draft: { ...state.draft,
          patch: { ...state.draft.patch, team: { ...state.draft.patch.team, ...step } } } };
    }
    case 'governance-step': {
      // THE FRAGMENT IS THE ONLY THING WRITTEN, as for `team-fanout`: `stepGovernanceSetting`
      // returns exactly one key, clamped, from the value the screen is showing
      // (`draftGovernance`), so a step can never drag a second key into the patch.
      const step = stepGovernanceSetting(draftGovernance(state.draft), action.key, action.delta);
      return { ...state, dirty: true, error: undefined,
        draft: { ...state.draft, patch: { ...state.draft.patch,
          governance: { ...state.draft.patch.governance, ...step } } } };
    }
    case 'duplicate': {
      if (library.entries.length >= 200) return { ...state,
        error: 'Maximum 200 profiles. Delete an unused profile first.' };
      const original = library.entries.find((entry) => entry.id === action.id);
      return original ? { ...state, dirty: true, draft: { ...state.draft,
        profiles: { ...library, entries: [...library.entries, duplicateModelProfile(original)] } } }
        : state;
    }
    case 'delete': {
      // UNBIND-AND-DELETE (D-6): being referenced no longer refuses the flow.
      // The references - subagent included - are computed here, shown on the
      // confirm page, and cleared by `confirm-delete` inside the draft.
      const users = profileUsers(library, action.id, draftSubagentProfileId(state.draft));
      return { ...state, page: 'delete-confirm', deleteId: action.id,
        deleteUsers: users, error: undefined };
    }
    case 'confirm-delete': {
      const id = state.deleteId;
      if (!id) return state;
      // THE DRAFT-SIDE UNBIND: Main/Fast bindings pointing at the entry are
      // nulled here (not refused) and the subagent binding resets to main
      // when it named THIS entry. `removeModelProfile`'s throw stays as the
      // bottom-line defense - the UI has already unbound, so it cannot fire
      // on this path.
      //
      // AND THE KITS GO WITH IT (agent-model-kits D-9 / I-8): a kit naming a
      // deleted profile can neither be applied nor repaired from any screen, so
      // leaving it behind would be leaving a permanent error. The confirmation
      // page has already named them, so this is the action the user agreed to.
      const doomed = kitsUsingProfile(library, id);
      const defaultKitKept = doomed.some((kit) => kit.id === (library.defaultKitId ?? null))
        ? null : library.defaultKitId;
      const sessionReleased = doomed.some((kit) => kit.id === state.draft.sessionKit?.id)
        ? null : state.draft.sessionKit;
      const profiles = {
        ...library,
        mainId: library.mainId === id ? null : library.mainId,
        fastId: library.fastId === id ? null : library.fastId,
        entries: library.entries.filter((entry) => entry.id !== id),
        kits: (library.kits ?? []).filter((kit) => !doomed.includes(kit)),
        defaultKitId: defaultKitKept,
      };
      const teamReset = draftSubagentProfileId(state.draft) === id
        ? { team: { model: 'main' as const, modelProfileId: null } }
        : {};
      return { ...state, page: 'manager', dirty: true,
        draft: { ...state.draft, profiles, sessionKit: sessionReleased,
          patch: { ...state.draft.patch, ...teamReset } },
        deleteId: undefined, deleteUsers: undefined,
        // No orphan editor for a deleted entry (3.7).
        editor: state.editor?.original.id === id ? undefined : state.editor };
    }
  }
}
