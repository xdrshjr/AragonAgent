import React from 'react';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink';
import { createStdinFilter } from '../input/stdin-filter.js';
import { SettingsScreen, readDirtySettings, type SettingsValues }
  from '../ui/overlays/SettingsScreen.js';
import { getTheme } from '../ui/theme.js';
import { createProfileEditor, finishProfileEditor, modelProfileReducer,
  createModelProfileState, createCustomProfile, draftTeam, SUBAGENT_FAST_ROW_ID }
  from '../ui/overlays/model-profile-state.js';
import type { ModelSettingsDraft } from '../config/model-profile-store.js';

const profile = { id: 'profile-a', name: 'Shared', provider: 'openai', model: 'custom',
  baseUrl: null, apiKey: 'disk-secret', contextWindow: null };
const draft = () => ({ diskRevision: 'disk', liveRevision: 0, baseline: {}, liveBaseline: {},
  patch: {}, activateRoles: [], profiles: { version: 1, entries: [profile], mainId: 'profile-a',
    fastId: 'profile-a' } }) as unknown as ModelSettingsDraft;
const initial: SettingsValues = { provider: 'openai', model: 'custom', baseUrl: '',
  thinkingLevel: 'off', showThinking: 'off', liveToolOutput: 'off', maxTokens: '',
  contextWindow: '', apiKey: '', logLevel: 'info', fastEnabled: 'off', fastModel: '',
  fastProvider: '', fastReview: '5', fastReviewBudget: '40', compactionEnabled: 'off',
  compactionThreshold: '90', compactionKeepTurns: '3', compactionSubagents: 'off',
  compactionArchive: 'off' };
const caps = { colorLevel: 0 as const, unicode: false };
const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach((cleanup) => cleanup()); });
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 60));
async function mount(props: Partial<React.ComponentProps<typeof SettingsScreen>> = {}) {
  const source = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => source,
    ref: () => source, unref: () => source });
  const filter = createStdinFilter(source as unknown as NodeJS.ReadStream,
    { mouse: false, paste: true });
  const output = Object.assign(new PassThrough(), { columns: 80, rows: 24, isTTY: true });
  let frame = '';
  output.on('data', (chunk) => { frame += String(chunk); });
  const onProfileSave = vi.fn((_draft: ModelSettingsDraft) => ({ ok: false, persisted: false,
    status: 'rejected' as const, code: 'write_failed' as const }));
  const app = render(<SettingsScreen initial={initial} apiKeys={{}} cols={80} maxRows={24}
    scrollOffset={0} theme={getTheme('cool', caps)} caps={caps} draft={draft()}
    onProfileSave={onProfileSave} {...props} />, { stdin: filter.stdin,
    stdout: output as unknown as NodeJS.WriteStream, exitOnCtrlC: false, patchConsole: false });
  cleanups.push(() => { app.unmount(); app.cleanup(); filter.dispose(); source.destroy(); });
  await tick();
  return { onProfileSave, frame: () => frame,
    send: async (text: string) => { source.write(text); await tick(); } };
}

describe('profile settings draft', () => {
  it('does not adopt the main gateway for a fast provider with a different endpoint family', () => {
    const input = draft();
    Object.assign(input.baseline, { provider: 'openai', baseUrl: 'https://main.example',
      fast: { provider: 'anthropic', model: 'fast-custom', baseUrl: '' } });
    expect(createCustomProfile(input, 'fast').baseUrl).toBeNull();
  });
  it('keeps credentials out of the editor and requires explicit retention after endpoint changes', () => {
    const editor = createProfileEditor(profile);
    expect(editor.apiKey).toBe('');
    expect(editor.credentialMode).toBe('keep');
    let state = createModelProfileState(draft());
    state = modelProfileReducer(state, { type: 'edit', profile });
    state = modelProfileReducer(state, { type: 'editor-field', field: 'baseUrl',
      value: 'https://other.example' });
    expect(state.editor?.credentialMode).toBe('shared');
    expect(finishProfileEditor(state.editor!).profile?.apiKey).toBeNull();
    state = modelProfileReducer(state, { type: 'retain-key' });
    expect(finishProfileEditor(state.editor!).profile?.apiKey).toBe('disk-secret');
  });
  it('reselecting a bound profile activates only that role and never writes its sibling', () => {
    const state = modelProfileReducer(createModelProfileState(draft()),
      { type: 'select', role: 'main', id: profile.id });
    expect(state.draft.activateRoles).toEqual(['main']);
    expect(state.draft.profiles?.fastId).toBe(profile.id);
  });
  it('offers unbind-and-delete for a profile referenced by Main and Fast (D-6)', () => {
    let state = modelProfileReducer(createModelProfileState(draft()),
      { type: 'delete', id: profile.id });
    // Referenced entries are no longer REFUSED: the flow continues to the
    // confirm page with the references recorded for its disclosure line.
    expect(state.page).toBe('delete-confirm');
    expect(state.deleteUsers).toBe('Main + Fast');
    expect(state.error).toBeUndefined();
    state = modelProfileReducer(state, { type: 'confirm-delete' });
    expect(state.draft.profiles?.entries).toHaveLength(0);
    expect(state.draft.profiles?.mainId).toBeNull();
    expect(state.draft.profiles?.fastId).toBeNull();
  });
  it('confirm-delete also resets the subagent binding when it named the entry (15)', () => {
    const input = draft();
    Object.assign(input.baseline, { team: { model: 'profile', modelProfileId: profile.id } });
    let state = createModelProfileState(input);
    state = modelProfileReducer(state, { type: 'delete', id: profile.id });
    expect(state.deleteUsers).toBe('Main + Fast + Subagent');
    state = modelProfileReducer(state, { type: 'confirm-delete' });
    expect(state.draft.patch.team).toEqual({ model: 'main', modelProfileId: null });
  });
  it('confirm-delete leaves an unrelated subagent binding untouched', () => {
    const other = { ...profile, id: 'profile-b', name: 'Other' };
    const input = draft();
    input.profiles!.entries = [profile, other];
    Object.assign(input.baseline, { team: { model: 'profile', modelProfileId: other.id } });
    let state = createModelProfileState(input);
    state = modelProfileReducer(state, { type: 'delete', id: profile.id });
    expect(state.deleteUsers).toBe('Main + Fast');
    state = modelProfileReducer(state, { type: 'confirm-delete' });
    expect(state.draft.patch.team).toBeUndefined();
  });
  it('subagent picker selection writes patch.team in all three branches (14)', () => {
    const other = { ...profile, id: 'profile-b', name: 'Other' };
    const input = draft();
    input.profiles!.entries = [profile, other];
    let state = createModelProfileState(input);
    state = modelProfileReducer(state, { type: 'page', page: 'picker', role: 'subagent' });
    state = modelProfileReducer(state, { type: 'select', role: 'subagent', id: null });
    expect(state.draft.patch.team).toEqual({ model: 'main', modelProfileId: null });
    expect(state.draft.activateRoles).toEqual([]);
    state = modelProfileReducer(state,
      { type: 'select', role: 'subagent', id: SUBAGENT_FAST_ROW_ID });
    expect(state.draft.patch.team).toEqual({ model: 'fast', modelProfileId: null });
    state = modelProfileReducer(state, { type: 'select', role: 'subagent', id: other.id });
    expect(state.draft.patch.team).toEqual({ model: 'profile', modelProfileId: other.id });
    expect(state.page).toBe('root');
    expect(state.dirty).toBe(true);
  });
  it('draftTeam prefers an explicit patch null over the baseline value', () => {
    const input = draft();
    Object.assign(input.baseline, { team: { model: 'profile', modelProfileId: profile.id } });
    expect(draftTeam(input)).toEqual({ model: 'profile', modelProfileId: profile.id });
    input.patch.team = { model: 'main', modelProfileId: null };
    expect(draftTeam(input)).toEqual({ model: 'main', modelProfileId: null });
  });
  it('copies the merged replacement credential, while child cancellation keeps its parent', () => {
    let state = createModelProfileState(draft());
    state = modelProfileReducer(state, { type: 'edit', profile });
    state = modelProfileReducer(state, { type: 'editor-field', field: 'credentialMode', value: 'replace' });
    state = modelProfileReducer(state, { type: 'editor-field', field: 'apiKey', value: 'replacement-key' });
    state = modelProfileReducer(state, { type: 'merge-editor' });
    state = modelProfileReducer(state, { type: 'duplicate', id: profile.id });
    const copy = state.draft.profiles!.entries[1]!;
    expect(copy.apiKey).toBe('replacement-key');
    expect(copy.id).not.toBe(profile.id);
    expect(state.draft.profiles!.mainId).toBe(profile.id);
    state = modelProfileReducer(state, { type: 'edit', profile: copy });
    state = modelProfileReducer(state, { type: 'editor-field', field: 'apiKey', value: 'discarded' });
    state = modelProfileReducer(state, { type: 'cancel-editor' });
    expect(state.draft.profiles!.entries[1]!.apiKey).toBe('replacement-key');
  });
  it('does not restore replacement credentials when returning to the original endpoint', () => {
    let state = modelProfileReducer(createModelProfileState(draft()), { type: 'edit', profile });
    state = modelProfileReducer(state, { type: 'editor-field', field: 'credentialMode', value: 'replace' });
    state = modelProfileReducer(state, { type: 'editor-field', field: 'apiKey', value: 'temporary' });
    state = modelProfileReducer(state, { type: 'editor-field', field: 'baseUrl', value: 'http://local' });
    state = modelProfileReducer(state, { type: 'editor-field', field: 'baseUrl', value: '' });
    expect(state.editor?.apiKey).toBe('');
    expect(state.editor?.credentialMode).toBe('shared');
  });
  it('deletes the last profile directly - unbinding first is history, not a gate (D-6)', () => {
    let state = createModelProfileState(draft());
    state = modelProfileReducer(state, { type: 'delete', id: profile.id });
    expect(state.page).toBe('delete-confirm');
    expect(state.deleteUsers).toBe('Main + Fast');
    state = modelProfileReducer(state, { type: 'confirm-delete' });
    expect(state.draft.profiles?.entries).toHaveLength(0);
    expect(state.draft.profiles?.mainId).toBeNull();
    expect(state.draft.profiles?.fastId).toBeNull();
  });
});

/**
 * profile-context-window §6.3/§6.5 behavior: the editor is STRICT (a typo is
 * refused with an inline error and never reaches the draft), the round-trip
 * seeds from the entry, clamping goes through the single gate, and the root
 * row exists only while Main is unbound (AC-11).
 */
describe('profile context window editing', () => {
  it('seeds the editor from the entry and round-trips through auto and numbers (AC-8)', () => {
    expect(createProfileEditor({ ...profile, contextWindow: 120_000 }).contextWindow)
      .toBe('120000');
    expect(createProfileEditor(profile).contextWindow).toBe('');
    let state = modelProfileReducer(createModelProfileState(draft()),
      { type: 'edit', profile });
    state = modelProfileReducer(state, { type: 'editor-field', field: 'contextWindow',
      value: '120000' });
    state = modelProfileReducer(state, { type: 'merge-editor' });
    expect(state.draft.profiles!.entries[0]!.contextWindow).toBe(120_000);
    state = modelProfileReducer(state, { type: 'edit',
      profile: state.draft.profiles!.entries[0]! });
    state = modelProfileReducer(state, { type: 'editor-field', field: 'contextWindow',
      value: 'auto' });
    state = modelProfileReducer(state, { type: 'merge-editor' });
    expect(state.draft.profiles!.entries[0]!.contextWindow).toBeNull();
  });
  it('refuses a typo with an inline error and leaves the draft untouched (AC-6)', () => {
    let state = modelProfileReducer(createModelProfileState(draft()),
      { type: 'edit', profile });
    state = modelProfileReducer(state, { type: 'editor-field', field: 'contextWindow',
      value: '12k' });
    const refused = finishProfileEditor(state.editor!);
    expect(refused.error).toBe('Context window: use a number or auto.');
    expect(refused.field).toBe('contextWindow');
    state = modelProfileReducer(state, { type: 'merge-editor' });
    // TYPO CHANGES NOTHING: the merge is refused, the editor stays open, and
    // the library entry keeps its previous value.
    expect(state.error).toContain('Context window');
    expect(state.page).toBe('editor');
    expect(state.draft.profiles!.entries[0]!.contextWindow).toBeNull();
  });
  it('clamps through the single gate, exactly like `config set` (AC-7)', () => {
    let state = modelProfileReducer(createModelProfileState(draft()),
      { type: 'edit', profile });
    state = modelProfileReducer(state, { type: 'editor-field', field: 'contextWindow',
      value: '99999999' });
    state = modelProfileReducer(state, { type: 'merge-editor' });
    expect(state.draft.profiles!.entries[0]!.contextWindow).toBe(5_000_000);
    state = modelProfileReducer(state, { type: 'edit',
      profile: state.draft.profiles!.entries[0]! });
    state = modelProfileReducer(state, { type: 'editor-field', field: 'contextWindow',
      value: '100' });
    state = modelProfileReducer(state, { type: 'merge-editor' });
    expect(state.draft.profiles!.entries[0]!.contextWindow).toBe(8_000);
  });
  it('root row: a typo throws, auto maps to null, a number is clamped silently', () => {
    expect(readDirtySettings(initial, { ...initial })).toEqual({});
    expect(() => readDirtySettings(initial, { ...initial, contextWindow: 'abc' }))
      .toThrow('Context window: use a number or auto.');
    expect(readDirtySettings(initial, { ...initial, contextWindow: 'auto' }))
      .toEqual({ contextWindow: null });
    expect(readDirtySettings(initial, { ...initial, contextWindow: '99999999' }))
      .toEqual({ contextWindow: 5_000_000 });
    expect(readDirtySettings(initial, { ...initial, contextWindow: '300000' }))
      .toEqual({ contextWindow: 300_000 });
  });
  it('Current custom seeding carries the existing top-level correction (AC-13)', () => {
    const input = draft();
    Object.assign(input.baseline, { contextWindow: 300_000 });
    expect(createCustomProfile(input, 'main').contextWindow).toBe(300_000);
    Object.assign(input.baseline, { contextWindow: null });
    expect(createCustomProfile(input, 'main').contextWindow).toBeNull();
  });
  it('hides the root row while Main is bound and seeds it from the FILE value when not (AC-11)', async () => {
    const bound = await mount();
    expect(bound.frame()).not.toContain('Context window');
    const input = draft();
    input.profiles!.mainId = null;
    input.profiles!.fastId = null;
    // The FILE value, not the effective one (P2-3): `profileSettingsValues`
    // seeds from `draft.baseline`, same source as provider/model/baseUrl.
    Object.assign(input.baseline, { contextWindow: 300_000 });
    const unbound = await mount({ draft: input });
    expect(unbound.frame()).toContain('Context window');
    expect(unbound.frame()).toContain('300000');
  });
});

describe('profile settings real input', () => {
  it('opens malformed profile data safely and disables Save', async () => {
    const broken = draft();
    broken.profiles = { version: 1 } as ModelSettingsDraft['profiles'];
    const view = await mount({ draft: broken });
    expect(view.frame()).toContain('aragon config edit');
    await view.send('\x13');
    expect(view.onProfileSave).not.toHaveBeenCalled();
  });
  it('offers the persisted custom connection after explicit unbinding, with dirty fields only', async () => {
    const input = draft();
    Object.assign(input.baseline, { provider: 'anthropic', model: 'disk-custom', baseUrl: '' });
    const view = await mount({ draft: input });
    await view.send('\r'); await view.send('\r');
    expect(view.frame()).toContain('disk-custom');
    // FIVE fixed rows precede the fields now (Main, Fast, Subagent model, Kit
    // pack, Manage), plus the `fastEnabled` field row itself: the model field is
    // row 7. The Kit pack row (agent-model-kits §4.5) moved every offset below
    // the Subagent row by one, which is exactly the cost `ROOT_ROWS` exists to
    // make visible in one place.
    for (let index = 0; index < 7; index++) await view.send('\x1b[B');
    await view.send('-changed'); await view.send('\x13');
    expect(view.onProfileSave.mock.calls[0]?.[0].patch).toEqual({ model: 'disk-custom-changed' });
  });
  it.each(['\r', '\x1b[13u', '\x1b[13;1u'])('selects once without saving on %j', async (enter) => {
    const view = await mount();
    await view.send(enter);
    expect(view.frame()).toContain('Current custom');
    await view.send('\x1b[B');
    await view.send(enter);
    expect(view.onProfileSave).not.toHaveBeenCalled();
    await view.send('\x13');
    expect(view.onProfileSave).toHaveBeenCalledTimes(1);
    expect(view.onProfileSave.mock.calls[0]?.[0]).toMatchObject({ activateRoles: ['main'], patch: {} });
    expect(view.frame()).toContain('Could not save');
    expect(view.frame()).not.toContain('disk-secret');
  });
  it('asks before discarding a root change and defaults to Continue', async () => {
    const onClose = vi.fn();
    const view = await mount({ onClose });
    await view.send('\r');
    await view.send('\r');
    await view.send('\x1b');
    expect(view.frame()).toContain('Continue');
    await view.send('\r');
    expect(onClose).not.toHaveBeenCalled();
  });
  it('prevents a second save after persistence succeeded but live application failed', async () => {
    const save = vi.fn(() => ({ ok: false, persisted: true,
      status: 'saved_apply_failed' as const }));
    const view = await mount({ onProfileSave: save });
    await view.send('\x13');
    await view.send('\x13');
    expect(save).toHaveBeenCalledTimes(1);
    expect(view.frame()).toContain('restart');
  });
  it.each([[80, 24], [60, 18], [40, 12]])('keeps focused actions reachable at %s x %s',
    async (cols, maxRows) => {
      const onScrollClamp = vi.fn();
      const view = await mount({ cols, maxRows, onScrollClamp });
      await view.send('\x1b[A');
      expect(view.frame()).toContain('> Reload settings');
      expect(onScrollClamp).toHaveBeenCalled();
    });
  it('searches more than eight profiles and keeps search input away from actions', async () => {
    const many = draft();
    many.profiles!.entries = Array.from({ length: 9 }, (_, index) => ({ ...profile,
      id: `item-${index}`, name: `中文配置 ${index}` }));
    many.profiles!.mainId = null; many.profiles!.fastId = null;
    const view = await mount({ draft: many });
    await view.send('\r');
    await view.send('/');
    await view.send('中文配置 8');
    await view.send('\r');
    await view.send('\x1b[B');
    await view.send('\r');
    await view.send('\x13');
    expect(view.onProfileSave.mock.calls[0]?.[0].profiles?.mainId).toBe('item-8');
  });
  it('reload asks before losing changes and Continue does not call the reader', async () => {
    const onReload = vi.fn(draft);
    const view = await mount({ onReload });
    await view.send('\r'); await view.send('\r');
    await view.send('\x1b[A'); await view.send('\r');
    expect(view.frame()).toContain('Discard unsaved changes');
    await view.send('\r');
    expect(onReload).not.toHaveBeenCalled();
    await view.send('\r'); await view.send('\x1b[B'); await view.send('\r');
    expect(onReload).toHaveBeenCalledTimes(1);
  });
  it('blocks all saves from an unreadable baseline without exposing raw errors', async () => {
    const broken = draft(); broken.readError = 'invalid_json';
    const view = await mount({ draft: broken });
    await view.send('\x13');
    expect(view.onProfileSave).not.toHaveBeenCalled();
    expect(view.frame()).toContain('aragon config edit');
  });
});


describe('the subagent model row and the delete flow (subagent-model 16/17/17b)', () => {
  it('17b: row 3 opens the subagent picker; Fast tier selection saves patch.team (AC-2)', async () => {
    const view = await mount();
    // Root page summary renders the parity default before anything is chosen.
    expect(view.frame()).toContain('Subagent model');
    expect(view.frame()).toContain('Same as main (openai:custom)');
    await view.send('\x1b[B'); await view.send('\x1b[B');   // row 2 = Subagent model
    await view.send('\r');
    // The picker: two built-in rows, the fast one annotated as off.
    expect(view.frame()).toContain('Same as main');
    expect(view.frame()).toContain('Fast tier model');
    expect(view.frame()).toContain('(fast tier off)');
    await view.send('\x1b[B');   // cursor on `Fast tier model`
    await view.send('\r');       // select -> back to root, dirty
    expect(view.frame()).toContain('Fast tier (off - falls back to main)');
    await view.send('\x13');     // Ctrl+S: the single transaction
    expect(view.onProfileSave).toHaveBeenCalledTimes(1);
    expect(view.onProfileSave.mock.calls[0]?.[0].patch.team)
      .toEqual({ model: 'fast', modelProfileId: null });
  });

  it('17: a profile selection rides the same save with its id (AC-2)', async () => {
    const view = await mount();
    await view.send('\x1b[B'); await view.send('\x1b[B'); await view.send('\r');
    // rows: Same as main, Fast tier model, Shared, Create profile
    await view.send('\x1b[B'); await view.send('\x1b[B');   // cursor on `Shared`
    await view.send('\r');
    await view.send('\x13');
    expect(view.onProfileSave.mock.calls[0]?.[0].patch.team)
      .toEqual({ model: 'profile', modelProfileId: 'profile-a' });
  });

  it('17b: a validation failure refocuses the FIELD row it names (V-5)', async () => {
    const view = await mount();
    // The draft has Main bound, so fields are [fastEnabled, thinkingLevel,
    // showThinking, liveToolOutput, maxTokens, ...]: maxTokens is row 9 now that
    // the Kit pack root row sits above the field block.
    for (let index = 0; index < 9; index++) await view.send('\x1b[B');
    await view.send('abc');
    // Move AWAY from the row, so only the error's focus jump can return.
    await view.send('\x1b[B'); await view.send('\x1b[B');
    await view.send('\x13');
    expect(view.frame()).toContain('Max tokens: use a number or auto.');
    expect(view.onProfileSave).not.toHaveBeenCalled();
    // Backspace only lands on maxTokens if the jump went to the right row;
    // clearing it makes the retry valid and the save fires.
    await view.send('\x7f'); await view.send('\x7f'); await view.send('\x7f');
    await view.send('\x13');
    expect(view.onProfileSave).toHaveBeenCalledTimes(1);
  });

  it('16/AC-6: d deletes the focused entry; an unreferenced one keeps plain Delete', async () => {
    const two = draft();
    two.profiles!.entries = [profile, { ...profile, id: 'profile-b', name: 'Other' }];
    const view = await mount({ draft: two });
    // Four fixed rows precede `Manage profiles` (Main, Fast, Subagent, Kit pack).
    await view.send('\x1b[B'); await view.send('\x1b[B'); await view.send('\x1b[B');
    await view.send('\x1b[B');
    await view.send('\r');       // Manage profiles
    expect(view.frame()).toContain('d delete');
    await view.send('\x1b[B');   // focus the second entry
    await view.send('d');
    expect(view.frame()).toContain('Delete Other?');
    expect(view.frame()).not.toContain('Unbind and delete');
    expect(view.frame()).not.toContain('The binding(s) will be cleared');
  });

  it('16/AC-5: a referenced entry offers Unbind and delete and names its users', async () => {
    const view = await mount();
    // Four fixed rows precede `Manage profiles` (Main, Fast, Subagent, Kit pack).
    await view.send('\x1b[B'); await view.send('\x1b[B'); await view.send('\x1b[B');
    await view.send('\x1b[B');
    await view.send('\r');       // Manage profiles: `Shared` is Main + Fast
    await view.send('d');
    expect(view.frame()).toContain('Unbind and delete');
    expect(view.frame()).toContain('Used by Main + Fast. The binding(s) will be cleared.');
    // Confirm (down to the second button, Enter) empties the library, then
    // the save transaction carries the emptied, unbound draft.
    await view.send('\x1b[B'); await view.send('\r');
    await view.send('\x1b');        // manager -> root (the picker owns Esc)
    await view.send('\x13');        // Ctrl+S
    expect(view.onProfileSave).toHaveBeenCalledTimes(1);
    expect(view.onProfileSave.mock.calls[0]?.[0].profiles?.entries).toHaveLength(0);
    expect(view.onProfileSave.mock.calls[0]?.[0].profiles?.mainId).toBeNull();
    expect(view.onProfileSave.mock.calls[0]?.[0].profiles?.fastId).toBeNull();
  });
});

describe('short inactive settings', () => {
  it('does not save or navigate while hidden', async () => {
    const view = await mount({ maxRows: 3, cols: 40, isActive: false });
    await view.send('\x1b[B'); await view.send('\x13'); await view.send('\r');
    expect(view.onProfileSave).not.toHaveBeenCalled();
    expect(view.frame()).not.toContain('Save failed');
  });
  it('retains an action row while focused fields move through the one-row body', async () => {
    const view = await mount({ maxRows: 3, cols: 40 });
    // The Subagent model row sits between Fast profile and Kit pack, and the Kit
    // pack row between that and Manage profiles, so the fixed block is five rows
    // deep now (V-5 + agent-model-kits §4.5).
    await view.send('\x1b[B'); await view.send('\x1b[B'); await view.send('\x1b[B');
    await view.send('\x1b[B');
    expect(view.frame()).toContain('Manage profiles');
    expect(view.frame()).toContain('Esc');
  });
});
