import React from 'react';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink';
import { createStdinFilter } from '../input/stdin-filter.js';
import { SettingsScreen, type SettingsValues } from '../ui/overlays/SettingsScreen.js';
import { getTheme } from '../ui/theme.js';
import { createProfileEditor, finishProfileEditor, modelProfileReducer,
  createModelProfileState, createCustomProfile } from '../ui/overlays/model-profile-state.js';
import type { ModelSettingsDraft } from '../config/model-profile-store.js';

const profile = { id: 'profile-a', name: 'Shared', provider: 'openai', model: 'custom',
  baseUrl: null, apiKey: 'disk-secret' };
const draft = () => ({ diskRevision: 'disk', liveRevision: 0, baseline: {}, liveBaseline: {},
  patch: {}, activateRoles: [], profiles: { version: 1, entries: [profile], mainId: 'profile-a',
    fastId: 'profile-a' } }) as unknown as ModelSettingsDraft;
const initial: SettingsValues = { provider: 'openai', model: 'custom', baseUrl: '',
  thinkingLevel: 'off', showThinking: 'off', liveToolOutput: 'off', maxTokens: '', apiKey: '',
  logLevel: 'info', fastEnabled: 'off', fastModel: '', fastProvider: '', fastReview: '5',
  fastReviewBudget: '40', compactionEnabled: 'off', compactionThreshold: '90',
  compactionKeepTurns: '3', compactionSubagents: 'off', compactionArchive: 'off' };
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
  it('refuses deletion of a profile referenced by either draft role', () => {
    const state = modelProfileReducer(createModelProfileState(draft()),
      { type: 'delete', id: profile.id });
    expect(state.draft.profiles?.entries).toHaveLength(1);
    expect(state.error).toContain('Main + Fast');
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
  it('deletes the last profile only after both roles are explicitly unbound', () => {
    let state = createModelProfileState(draft());
    state = modelProfileReducer(state, { type: 'select', role: 'main', id: null });
    state = modelProfileReducer(state, { type: 'select', role: 'fast', id: null });
    state = modelProfileReducer(state, { type: 'delete', id: profile.id });
    expect(state.page).toBe('delete-confirm');
    expect(state.draft.profiles?.entries).toHaveLength(1);
    state = modelProfileReducer(state, { type: 'confirm-delete' });
    expect(state.draft.profiles?.entries).toHaveLength(0);
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
    // Four summary rows precede the legacy provider/model connection fields.
    for (let index = 0; index < 5; index++) await view.send('\x1b[B');
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


describe('short inactive settings', () => {
  it('does not save or navigate while hidden', async () => {
    const view = await mount({ maxRows: 3, cols: 40, isActive: false });
    await view.send('\x1b[B'); await view.send('\x13'); await view.send('\r');
    expect(view.onProfileSave).not.toHaveBeenCalled();
    expect(view.frame()).not.toContain('Save failed');
  });
  it('retains an action row while focused fields move through the one-row body', async () => {
    const view = await mount({ maxRows: 3, cols: 40 });
    await view.send('\x1b[B'); await view.send('\x1b[B');
    expect(view.frame()).toContain('Manage profiles');
    expect(view.frame()).toContain('Esc');
  });
});
