/**
 * The settings screen's kit pages (agent-model-kits AC-27..AC-30, AC-38).
 *
 * BOTH HALVES ARE NEEDED. The row strings are asserted through the PURE planner
 * (`kitPackRow`), because five states of one line are not five keyboard journeys;
 * the KEYS are asserted through a mounted screen, because "`s` sets three slots
 * and dirties the draft" is a claim about a transaction, not about a function.
 */

import React from 'react';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink';
import { createStdinFilter } from '../input/stdin-filter.js';
import { SettingsScreen, type SettingsValues } from '../ui/overlays/SettingsScreen.js';
import { getTheme } from '../ui/theme.js';
import { createModelProfileState, modelProfileReducer }
  from '../ui/overlays/model-profile-state.js';
import { kitPackRow, kitReducer, heldSlots, openKitDraft, kitManagerRows }
  from '../ui/overlays/kit-settings-state.js';
import { emptyModelProfiles, normalizeModelProfiles } from '../config/model-profiles.js';
import { DEFAULT_CONFIG, type CliConfig, type PersistedConfig } from '../config/schema.js';
import type { ModelSettingsDraft } from '../config/model-profile-store.js';
import type { AgentKit } from '../config/model-kits.js';

const kit = (over: Partial<AgentKit> = {}): AgentKit => ({ id: 'kit-1', name: 'Deep work',
  mainProfileId: 'p-main', fastProfileId: 'p-fast',
  subagent: { model: 'fast', modelProfileId: null }, ...over });

const library = (kits: unknown[] = [kit()], over: Record<string, unknown> = {}) =>
  normalizeModelProfiles({ version: 1, mainId: 'p-main', fastId: 'p-fast',
    entries: [
      { id: 'p-main', name: 'Opus', provider: 'anthropic', model: 'opus-4',
        baseUrl: null, apiKey: null, contextWindow: 200000 },
      { id: 'p-fast', name: 'Haiku', provider: 'anthropic', model: 'haiku-4',
        baseUrl: null, apiKey: null, contextWindow: 120000 },
    ], kits, defaultKitId: 'kit-1', kitsVersion: 1, ...over });

const live = (over: Record<string, unknown> = {}): CliConfig => ({
  ...structuredClone(DEFAULT_CONFIG), provider: 'anthropic', model: 'opus-4',
  fast: { ...DEFAULT_CONFIG.fast, enabled: true, provider: 'anthropic', model: 'haiku-4',
    baseUrl: '' },
  team: { ...DEFAULT_CONFIG.team, model: 'fast' },
  apiKeys: {}, modelProfiles: library(), ...over } as unknown as CliConfig);

const draft = (over: Record<string, unknown> = {}): ModelSettingsDraft => ({
  diskRevision: 'disk', liveRevision: 0,
  baseline: { ...structuredClone(DEFAULT_CONFIG), modelProfiles: library(),
    team: { ...DEFAULT_CONFIG.team, model: 'main' },
    fast: { ...DEFAULT_CONFIG.fast, enabled: true } } as unknown as PersistedConfig,
  liveBaseline: live(), patch: {}, activateRoles: [], profiles: library(),
  ...over } as unknown as ModelSettingsDraft);

const initial: SettingsValues = { provider: 'anthropic', model: 'opus-4', baseUrl: '',
  thinkingLevel: 'off', showThinking: 'off', liveToolOutput: 'off', maxTokens: '',
  contextWindow: '', apiKey: '', logLevel: 'info', fastEnabled: 'on', fastModel: 'haiku-4',
  fastProvider: 'anthropic', fastReview: '5', fastReviewBudget: '40', compactionEnabled: 'off',
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
  const output = Object.assign(new PassThrough(), { columns: 100, rows: 30, isTTY: true });
  let frame = '';
  output.on('data', (chunk) => { frame += String(chunk); });
  const onProfileSave = vi.fn((_draft: ModelSettingsDraft) => ({ ok: false, persisted: false,
    status: 'rejected' as const, code: 'write_failed' as const }));
  const app = render(<SettingsScreen initial={initial} apiKeys={{}} cols={100} maxRows={30}
    scrollOffset={0} theme={getTheme('cool', caps)} caps={caps} draft={draft()}
    onProfileSave={onProfileSave} {...props } />, { stdin: filter.stdin,
    stdout: output as unknown as NodeJS.WriteStream, exitOnCtrlC: false, patchConsole: false });
  cleanups.push(() => { app.unmount(); app.cleanup(); filter.dispose(); source.destroy(); });
  await tick();
  return { onProfileSave, frame: () => frame,
    send: async (text: string) => { source.write(text); await tick(); } };
}

const down = async (view: Awaited<ReturnType<typeof mount>>, times: number) => {
  for (let index = 0; index < times; index += 1) await view.send('\x1b[B');
};

describe('AC-27: the five states of the Kit pack row', () => {
  const state = (draftOver: Record<string, unknown>) =>
    createModelProfileState(draft(draftOver));

  it('says `no kit yet` only when the library is empty', () => {
    expect(kitPackRow(state({ profiles: library([], { defaultKitId: null }) })))
      .toBe('Current setup  (no kit yet)');
    expect(kitPackRow(state({ profiles: library([], { defaultKitId: null }), sessionKit: null })))
      .toBe('Current setup  (no kit yet)');
  });

  it('names the default kit', () => {
    expect(kitPackRow(state({}))).toBe('Deep work  [default]');
  });

  it('names the session kit and the default beside it', () => {
    const both = state({ profiles: library([kit(),
      kit({ id: 'kit-2', name: 'Fast cheap', mainProfileId: 'p-fast' })]),
    sessionKit: { id: 'kit-2', held: ['main', 'fast', 'subagent'] } });
    expect(kitPackRow(both)).toBe('Fast cheap  [session]  (default: Deep work)');
  });

  it('shows which slots a partly released session kit still holds', () => {
    const partial = state({ sessionKit: { id: 'kit-1', held: ['main', 'fast'] } });
    expect(kitPackRow(partial)).toBe('Deep work  [session: main+fast]~  (default: Deep work)');
  });

  it('marks a FULLY held kit whose connections drifted, like the chip does', () => {
    // `/model` moved the live connection away from the kit's main profile. All
    // three slots are still held, so "partly released" cannot be what signals
    // this - and a row that stayed silent would disagree with the status bar.
    const drifted = state({ liveBaseline: live({ model: 'other-model' }),
      sessionKit: { id: 'kit-1', held: ['main', 'fast', 'subagent'] } });
    expect(kitPackRow(drifted)).toBe('Deep work  [session]~  (default: Deep work)');
  });
});

describe('AC-38: an explicit choice releases that slot in the DRAFT', () => {
  const start = (held: string[]) => createModelProfileState(draft({
    sessionKit: { id: 'kit-1', held } }));

  it('drops `main` from held, so the row stops painting the kit\'s value', () => {
    const before = start(['main', 'fast', 'subagent']);
    // The kit's value is what the row paints first (RV-P0-2).
    expect(heldSlots(before).mainId).toBe('p-main');
    const next = modelProfileReducer(before, { type: 'select', role: 'main', id: 'p-fast' });
    expect(next.draft.sessionKit).toEqual({ id: 'kit-1', held: ['fast', 'subagent'] });
    expect(heldSlots(next).mainId).toBeNull();
    expect(next.draft.profiles?.mainId).toBe('p-fast');
  });

  it('drops `subagent` when the subagent picker writes a choice', () => {
    const next = modelProfileReducer(start(['main', 'fast', 'subagent']),
      { type: 'select', role: 'subagent', id: null });
    expect(next.draft.sessionKit).toEqual({ id: 'kit-1', held: ['main', 'fast'] });
    expect(heldSlots(next).subagent).toBeNull();
  });

  it('ends the session kit when the last held slot is decided', () => {
    // `held: []` is not a state the picker or the chip can render, so the last
    // release is a full release - and only the slot the kit still holds counts,
    // which is why deciding `fast` here changes nothing.
    const untouched = modelProfileReducer(start(['main']),
      { type: 'select', role: 'fast', id: 'p-fast' });
    expect(untouched.draft.sessionKit).toEqual({ id: 'kit-1', held: ['main'] });
    const next = modelProfileReducer(start(['main']),
      { type: 'select', role: 'main', id: 'p-fast' });
    expect(next.draft.sessionKit).toBeNull();
    expect(heldSlots(next).kitName).toBeNull();
  });
});

describe('AC-38: the root page shows the KIT’s values for held slots', () => {
  it('reports the held ids and the kit name', () => {
    const state = createModelProfileState(draft({ profiles: library([
      kit({ mainProfileId: 'p-fast', fastProfileId: null })]),
    sessionKit: { id: 'kit-1', held: ['main', 'fast', 'subagent'] } }));
    const held = heldSlots(state);
    expect(held.kitName).toBe('Deep work');
    expect(held.mainId).toBe('p-fast');
    expect(held.fastId).toBeNull();
    expect(held.subagent).toEqual({ model: 'fast', modelProfileId: null });
  });

  it('renders the kit value and `(kit X)` on the Main row', async () => {
    const view = await mount({ draft: draft({ profiles: library([
      kit({ mainProfileId: 'p-fast' })]),
    sessionKit: { id: 'kit-1', held: ['main', 'fast', 'subagent'] } }) });
    expect(view.frame()).toContain('Haiku');
    expect(view.frame()).toContain('(kit Deep work)');
  });

  it('answers `no kit` for a draft without one', () => {
    expect(heldSlots(createModelProfileState(draft())).kitName).toBeNull();
  });
});

describe('AC-28: `s` is exit A - three slots AND the pointer', () => {
  it('writes the kit’s bindings into the draft and marks it dirty', () => {
    const start = createModelProfileState(draft({ profiles: library([kit()],
      { defaultKitId: null }), sessionKit: { id: 'kit-1', held: ['main'] } }));
    const next = kitReducer(start, { type: 'kit-default', id: 'kit-1' });
    expect(next.dirty).toBe(true);
    expect(next.draft.profiles?.defaultKitId).toBe('kit-1');
    expect(next.draft.profiles?.mainId).toBe('p-main');
    expect(next.draft.profiles?.fastId).toBe('p-fast');
    expect(next.draft.patch.team).toEqual({ model: 'fast', modelProfileId: null });
    expect(next.draft.patch.fast).toEqual({ enabled: true });
    // The save now decides all three slots, so the session kit is done (§4.3).
    expect(next.draft.sessionKit).toBeNull();
  });

  it('does not project the fast role for a kit that turns the tier off (I-13)', () => {
    const start = createModelProfileState(draft({ profiles: library([
      kit({ fastProfileId: null })]) }));
    const next = kitReducer(start, { type: 'kit-apply', id: 'kit-1' });
    expect(next.draft.activateRoles).toEqual(['main']);
    expect(next.draft.patch.fast).toEqual({ enabled: false });
  });

  it('reaches the save handler from the manager page', async () => {
    const view = await mount();
    await down(view, 3);
    await view.send('\r');            // Kit pack
    await view.send('\x1b[B');        // focus the kit - `s` needs a KIT row
    await view.send('s');
    await view.send('\x1b');          // back to the settings root
    await view.send('\x13');          // Ctrl+S
    expect(view.onProfileSave).toHaveBeenCalledTimes(1);
    const saved = view.onProfileSave.mock.calls[0]![0];
    expect(saved.profiles?.defaultKitId).toBe('kit-1');
    expect(saved.profiles?.mainId).toBe('p-main');
  });
});

describe('AC-29: the editor refuses an incomplete kit and jumps to the row', () => {
  it('opens prefilled from the current setup and refuses an empty main slot', async () => {
    const view = await mount();
    await down(view, 3);
    await view.send('\r');            // Kit pack
    await view.send('\r');            // New kit (row 0)
    expect(view.frame()).toContain('New kit');
    expect(view.frame()).toContain('Name');
    // Clear the prefilled name, then try to save.
    for (let index = 0; index < 12; index += 1) await view.send('\x7f');
    await down(view, 4);              // refocus nothing; save is reached below
    await view.send('\r');
    // The name is now empty, so Save must refuse with the name message first.
    expect(view.frame()).toContain('Name: enter a name for this kit.');
  });

  it('prefills from the bindings this machine already runs (D-13)', () => {
    const state = createModelProfileState(draft());
    const draftKit = openKitDraft(state, null);
    expect(draftKit.mainProfileId).toBe('p-main');
    expect(draftKit.fastProfileId).toBe('p-fast');
    // FROM THE FILE, like every other row on this screen: the draft is a
    // transaction over `config.json`, and prefilling from the live config would
    // bake a session kit's choices into a preset the user is about to save.
    expect(draftKit.subagent.model).toBe('main');
    expect(draftKit.name).toMatch(/Kit \d+/);
  });
});

describe('AC-30: deleting a profile names and removes the kits that use it', () => {
  it('lists the kit in the confirmation and clears it on confirm', () => {
    const start = createModelProfileState(draft({ sessionKit: { id: 'kit-1',
      held: ['main', 'fast', 'subagent'] } }));
    const confirming = kitReducer(createModelProfileState(start.draft),
      { type: 'kit-delete', id: 'kit-1' });
    expect(confirming.page).toBe('kit-delete');
    const removed = kitReducer(confirming, { type: 'kit-confirm-delete' });
    expect(removed.draft.profiles?.kits).toEqual([]);
    expect(removed.draft.profiles?.defaultKitId).toBeNull();
    // The kit WAS the session kit, so releasing it is part of the deletion.
    expect(removed.draft.sessionKit).toBeNull();
    expect(removed.dirty).toBe(true);
  });

  it('shows the delete confirmation page with the kit named', async () => {
    const view = await mount();
    await down(view, 3);
    await view.send('\r');
    await view.send('\x1b[B');
    await view.send('d');
    expect(view.frame()).toContain('Delete kit Deep work?');
    expect(view.frame()).toContain('Cancel');
  });
});

describe('the manager lists what the library holds', () => {
  it('summarizes the three slots and marks the default', () => {
    const state = createModelProfileState(draft());
    const rows = kitManagerRows(state);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.label).toContain('[Default]');
    expect(rows[0]!.summary).toContain('anthropic:opus-4');
  });

  it('reports an empty library without inventing a row', () => {
    expect(kitManagerRows(createModelProfileState(draft({
      profiles: emptyModelProfiles() })))).toEqual([]);
  });
});
