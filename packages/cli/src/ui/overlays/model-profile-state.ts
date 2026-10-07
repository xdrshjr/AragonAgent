import { randomUUID } from 'node:crypto';
import { emptyModelProfiles, duplicateModelProfile, normalizeModelProfiles,
  validateModelProfiles, type ModelProfile, type ModelProfilesConfig,
  type ModelRole } from '../../config/model-profiles.js';
import type { ModelSettingsDraft } from '../../config/model-profile-store.js';

export type ProfilePage = 'root' | 'picker' | 'manager' | 'editor'
  | 'delete-confirm' | 'discard-confirm';
export interface ProfileEditorDraft {
  original: ModelProfile;
  name: string;
  provider: string;
  model: string;
  baseUrl: string;
  credentialMode: 'keep' | 'replace' | 'shared';
  apiKey: string;
  endpointChanged: boolean;
}
export interface ModelProfileState {
  draft: ModelSettingsDraft;
  page: ProfilePage;
  role: ModelRole;
  editor?: ProfileEditorDraft;
  returnPage: 'picker' | 'manager';
  bindNew: boolean;
  dirty: boolean;
  error?: string;
  deleteId?: string;
}
export type ModelProfileAction =
  | { type: 'page'; page: ProfilePage; role?: ModelRole }
  | { type: 'select'; role: ModelRole; id: string | null }
  | { type: 'edit'; profile: ModelProfile; bindNew?: boolean }
  | { type: 'editor-field'; field: keyof Omit<ProfileEditorDraft, 'original' | 'endpointChanged'>;
      value: string }
  | { type: 'retain-key' }
  | { type: 'merge-editor' }
  | { type: 'cancel-editor' }
  | { type: 'duplicate'; id: string }
  | { type: 'delete'; id: string }
  | { type: 'confirm-delete' }
  | { type: 'reload'; draft: ModelSettingsDraft };

/** Keep the original secret separate from the empty replacement field. */
export function createProfileEditor(profile: ModelProfile): ProfileEditorDraft {
  return { original: { ...profile }, name: profile.name, provider: profile.provider,
    model: profile.model, baseUrl: profile.baseUrl ?? '', apiKey: '',
    credentialMode: profile.apiKey ? 'keep' : 'shared', endpointChanged: false };
}
/** Validate locally before merging the child form into the root transaction. */
export function finishProfileEditor(editor: ProfileEditorDraft):
{ profile?: ModelProfile; error?: string; field?: string } {
  const profile: ModelProfile = { id: editor.original.id, name: editor.name.trim(),
    provider: editor.provider, model: editor.model.trim(), baseUrl: editor.baseUrl.trim() || null,
    apiKey: editor.credentialMode === 'keep' ? editor.original.apiKey
      : editor.credentialMode === 'replace' ? editor.apiKey.trim() : null };
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
/** Describe references using text so ASCII and no-color modes remain usable. */
export function profileUsers(profiles: ModelProfilesConfig | undefined, id: string): string {
  return [profiles?.mainId === id ? 'Main' : '', profiles?.fastId === id ? 'Fast' : '']
    .filter(Boolean).join(' + ');
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
    apiKey: role === 'fast' && !model ? null : file.apiKeys?.[provider] || null };
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
    case 'select': return { ...state, page: 'root', dirty: true, error: undefined,
      draft: { ...state.draft, profiles: { ...library, [`${action.role}Id`]: action.id },
        activateRoles: [...new Set([...state.draft.activateRoles, action.role])] } };
    case 'edit': return { ...state, editor: createProfileEditor(action.profile), page: 'editor',
      returnPage: state.page === 'picker' ? 'picker' : 'manager',
      bindNew: action.bindNew ?? false, error: undefined };
    case 'editor-field': return editField(state, action);
    case 'retain-key': return state.editor?.original.apiKey ? { ...state,
      editor: { ...state.editor, credentialMode: 'keep', apiKey: '' } } : state;
    case 'merge-editor': return mergeEditor(state);
    case 'cancel-editor': return { ...state, editor: undefined, page: state.returnPage,
      error: undefined };
    case 'duplicate': {
      if (library.entries.length >= 200) return { ...state,
        error: 'Maximum 200 profiles. Delete an unused profile first.' };
      const original = library.entries.find((entry) => entry.id === action.id);
      return original ? { ...state, dirty: true, draft: { ...state.draft,
        profiles: { ...library, entries: [...library.entries, duplicateModelProfile(original)] } } }
        : state;
    }
    case 'delete': {
      const users = profileUsers(library, action.id);
      return users ? { ...state, error: `Used by ${users}. Select another profile first.` }
        : { ...state, page: 'delete-confirm', deleteId: action.id, error: undefined };
    }
    case 'confirm-delete': return { ...state, page: 'manager', dirty: true,
      draft: { ...state.draft, profiles: { ...library,
        entries: library.entries.filter((entry) => entry.id !== state.deleteId) } },
      deleteId: undefined };
  }
}
