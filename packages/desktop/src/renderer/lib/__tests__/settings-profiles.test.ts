import { afterEach, describe, expect, it } from 'vitest';
import { emptyModelProfiles, type ModelProfilesConfig } from '@aragon-agent/tui/model/config/model-profiles';
import type { ConfigViewDto } from '../../../shared/config-view.js';
import {
  addKit, applyProfile, bindRole, checkProfileForm, copyProfile, deleteProfile, emptyProfileForm,
  loadFullLibrary, maskedLibrary, removeKit,
} from '../settings-profiles.js';
import { fail, installBridge, ok, removeBridge } from '../../settings/__tests__/test-bridge.js';

const form = (overrides: Partial<ReturnType<typeof emptyProfileForm>> = {}) =>
  ({ ...emptyProfileForm('anthropic'), model: 'claude-x', apiKey: 'sk-secret-1', ...overrides });

function libraryWith(count = 2): ModelProfilesConfig {
  let library = emptyModelProfiles();
  for (let index = 0; index < count; index += 1) {
    const result = applyProfile(library, null, form({ model: `m${index}`, apiKey: `key-${index}` }));
    if (!result.ok) throw new Error('fixture');
    library = result.library;
  }
  return library;
}

describe('profile form', () => {
  it('names the field that is wrong', () => {
    expect(checkProfileForm(form({ model: '  ' }))).toEqual({ model: 'required' });
    expect(checkProfileForm(form({ baseUrl: 'not a url' }))).toEqual({ baseUrl: 'invalid' });
    expect(checkProfileForm(form({ baseUrl: 'https://gw.example/v1' }))).toEqual({});
    expect(checkProfileForm(form({ contextWindow: 'huge' }))).toEqual({ contextWindow: 'invalid' });
  });

  it('adds a profile with an engine-made id and the typed key', () => {
    const result = applyProfile(emptyModelProfiles(), null, form({ name: 'Work' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entry = result.library.entries[0]!;
    expect(entry).toMatchObject({ name: 'Work', provider: 'anthropic', model: 'claude-x', apiKey: 'sk-secret-1', baseUrl: null, contextWindow: null });
    expect(entry.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('keeps the stored key when an edit leaves the key field empty', () => {
    const library = libraryWith(1);
    const id = library.entries[0]!.id;
    const result = applyProfile(library, id, form({ model: 'renamed', apiKey: '' }));
    expect(result.ok && result.library.entries[0]).toMatchObject({ id, model: 'renamed', apiKey: 'key-0' });
  });

  it('replaces the key when a new one is typed', () => {
    const library = libraryWith(1);
    const result = applyProfile(library, library.entries[0]!.id, form({ apiKey: 'fresh' }));
    expect(result.ok && result.library.entries[0]!.apiKey).toBe('fresh');
  });

  it('parses the context window and the base URL', () => {
    const result = applyProfile(emptyModelProfiles(), null, form({ contextWindow: '200000', baseUrl: ' https://gw.example/v1 ' }));
    expect(result.ok && result.library.entries[0]).toMatchObject({ contextWindow: 200000, baseUrl: 'https://gw.example/v1' });
  });
});

describe('profile library edits', () => {
  it('binds roles without touching other fields', () => {
    const library = libraryWith(2);
    const bound = bindRole(library, 'main', library.entries[1]!.id);
    expect(bound.mainId).toBe(library.entries[1]!.id);
    expect(bound.entries).toBe(library.entries);
  });

  it('refuses to delete a bound profile and a profile a kit uses', () => {
    const solo = libraryWith(1);
    const bound = bindRole(solo, 'main', solo.entries[0]!.id);
    expect(deleteProfile(bound, solo.entries[0]!.id)).toMatchObject({ ok: false, reason: 'bound' });

    const base = libraryWith(2);
    const kitted = addKit(base, { name: 'Pair', mainProfileId: base.entries[0]!.id, fastProfileId: '' });
    expect(kitted.ok).toBe(true);
    if (!kitted.ok) return;
    expect(deleteProfile(kitted.library, base.entries[0]!.id)).toMatchObject({ ok: false, reason: 'kits', kits: ['Pair'] });
    expect(deleteProfile(kitted.library, base.entries[1]!.id).ok).toBe(true);
  });

  it('duplicates a profile under a new id with its key', () => {
    const library = libraryWith(1);
    const copied = copyProfile(library, library.entries[0]!.id)!;
    expect(copied.entries).toHaveLength(2);
    expect(copied.entries[1]!.id).not.toBe(copied.entries[0]!.id);
    expect(copied.entries[1]!.apiKey).toBe('key-0');
    expect(copied.entries[1]!.name).toContain('(copy)');
  });

  it('creates, validates and removes kits', () => {
    const library = libraryWith(1);
    expect(addKit(library, { name: '', mainProfileId: library.entries[0]!.id, fastProfileId: '' })).toEqual({ ok: false, reason: 'name' });
    expect(addKit(library, { name: 'x', mainProfileId: 'missing', fastProfileId: '' })).toEqual({ ok: false, reason: 'main' });
    const added = addKit(library, { name: 'Solo', mainProfileId: library.entries[0]!.id, fastProfileId: '' });
    expect(added.ok && added.library.kits).toHaveLength(1);
    if (!added.ok) return;
    expect(removeKit(added.library, added.library.kits![0]!.id).kits).toEqual([]);
  });
});

describe('loading the full library to save it', () => {
  afterEach(() => { removeBridge(); });

  function masked(keys: Array<{ present: boolean }>): ConfigViewDto {
    const entries = keys.map((key, index) => ({
      id: `p${index}`, name: `Profile ${index}`, provider: 'openai', model: `m${index}`, baseUrl: null, contextWindow: null,
      key: { present: key.present, tail: 'abcd', source: key.present ? 'file' : 'none' },
    }));
    return { modelProfiles: { version: 1, entries, mainId: 'p0', fastId: null, kits: [] } } as unknown as ConfigViewDto;
  }

  it('reveals only the keys that exist', async () => {
    const bridge = installBridge({ 'config:reveal-key': (arg: { profileId?: string }) => ok({ key: `secret-${arg.profileId}` }) });
    const loaded = await loadFullLibrary(masked([{ present: true }, { present: false }]));
    expect(loaded.ok && loaded.library.entries.map((entry) => entry.apiKey)).toEqual(['secret-p0', null]);
    expect(bridge.calls('config:reveal-key')).toHaveLength(1);
  });

  it('fails closed when a stored key cannot be read, instead of sending null', async () => {
    installBridge({ 'config:reveal-key': () => ok({ key: null }) });
    const loaded = await loadFullLibrary(masked([{ present: true }]));
    expect(loaded).toEqual({ ok: false, reason: 'key_unavailable', profile: 'Profile 0' });
  });

  it('fails closed when the reveal channel errors', async () => {
    installBridge({ 'config:reveal-key': () => fail('internal', 'nope') });
    expect((await loadFullLibrary(masked([{ present: true }]))).ok).toBe(false);
  });

  it('has an empty library when there are no profiles at all, without asking for any key', async () => {
    const bridge = installBridge({ 'config:reveal-key': () => ok({ key: 'x' }) });
    const loaded = await loadFullLibrary({ modelProfiles: null } as unknown as ConfigViewDto);
    expect(loaded.ok && loaded.library.entries).toEqual([]);
    expect(bridge.calls('config:reveal-key')).toHaveLength(0);
  });

  it('shapes the masked library for checks with every key blanked', () => {
    expect(maskedLibrary(masked([{ present: true }])).entries[0]!.apiKey).toBeNull();
  });
});
