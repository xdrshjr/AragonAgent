import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const testRoot = fileURLToPath(new URL('../../../../.agentmesh/', import.meta.url));
mkdirSync(testRoot, { recursive: true });
const directory = mkdtempSync(join(testRoot, 'test-model-profiles-'));
process.env.ARAGON_HOME = directory;
const store = await import('../config/store.js');
const transactions = await import('../config/model-profile-store.js');
const { DEFAULT_CONFIG } = await import('../config/schema.js');
const { loadConfig, makeGetApiKey } = await import('../config/load.js');
beforeEach(() => rmSync(store.getConfigPath(), { force: true }));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const profiles = { version: 1 as const, entries: [{ id: 'p', name: 'P', provider: 'openai',
  model: 'custom', baseUrl: null, apiKey: null as string | null }], mainId: 'p', fastId: null };

describe('strict profile persistence', () => {
  it('refuses to overwrite malformed JSON and array roots', () => {
    for (const raw of ['{"apiKey":"private-secret",', '[]']) {
      writeFileSync(store.getConfigPath(), raw);
      expect(() => store.updatePersistedConfig({ theme: 'warm' })).toThrow();
      expect(readFileSync(store.getConfigPath(), 'utf8')).toBe(raw);
      expect(JSON.stringify(store.readConfigFile())).not.toContain('private-secret');
    }
  });
  it('preserves invalid segments on ordinary edits and blocks connection edits', () => {
    const invalid = { version: 99, entries: [{ apiKey: 'private-secret' }], extra: 'keep' };
    writeFileSync(store.getConfigPath(), JSON.stringify({ modelProfiles: invalid }));
    store.updatePersistedConfig({ theme: 'warm' });
    expect(JSON.parse(readFileSync(store.getConfigPath(), 'utf8')).modelProfiles).toEqual(invalid);
    expect(() => store.updatePersistedConfig({ model: 'other' })).toThrow();
  });
  it('commits once and rejects stale revisions', () => {
    const first = transactions.readModelSettingsDisk();
    expect(first.ok).toBe(true);
    const result = transactions.commitModelSettings({ diskRevision: first.revision,
      candidate: { ...DEFAULT_CONFIG, modelProfiles: profiles } });
    expect(result).toMatchObject({ ok: true, persisted: true });
    expect(transactions.commitModelSettings({ diskRevision: first.revision,
      candidate: DEFAULT_CONFIG })).toMatchObject({ ok: false, code: 'conflict' });
  });
  it('unbinds only touched roles and never copies dedicated keys to shared storage', () => {
    const current = { ...DEFAULT_CONFIG, modelProfiles: profiles };
    const patch = transactions.adaptLegacyConnectionPatch({ current, patch: { model: 'new' } });
    expect(patch.modelProfiles?.mainId).toBeNull();
    expect(patch.provider).toBe('openai');
    expect(patch.model).toBe('new');
    current.modelProfiles.entries[0].apiKey = 'dedicated';
    expect(() => transactions.adaptLegacyConnectionPatch({ current, patch: { model: 'new' } }))
      .toThrow(/settings/);
    current.modelProfiles.entries[0].apiKey = null;
  });
  it('rejects lossy fast default-endpoint conversion', () => {
    const current = { ...DEFAULT_CONFIG, provider: 'openai', baseUrl: 'https://gateway',
      modelProfiles: { ...profiles, mainId: null, fastId: 'p' } };
    expect(() => transactions.adaptLegacyConnectionPatch({ current,
      patch: { fast: { model: 'new' } } })).toThrow(/settings/);
  });
  it('does not let explicit replacement overwrite an invalid saved segment', () => {
    const current = { ...DEFAULT_CONFIG, modelProfiles: { version: 99 } };
    expect(() => transactions.adaptLegacyConnectionPatch({ current: current as never,
      patch: { modelProfiles: profiles } })).toThrow();
  });
  it('also rejects prepared commits that would overwrite an invalid segment', () => {
    const raw = JSON.stringify({ modelProfiles: { version: 99, entries: [] } });
    writeFileSync(store.getConfigPath(), raw);
    const current = transactions.readModelSettingsDisk();
    const result = transactions.commitModelSettings({ candidate: DEFAULT_CONFIG,
      diskRevision: current.revision });
    expect(result).toMatchObject({ ok: false, persisted: false, code: 'invalid' });
    expect(readFileSync(store.getConfigPath(), 'utf8')).toBe(raw);
  });
  it('rejects injected write failures without changing the original bytes', () => {
    const initial = transactions.readModelSettingsDisk();
    const result = transactions.commitModelSettings({ candidate: DEFAULT_CONFIG,
      diskRevision: initial.revision }, { read: () => initial,
      write: () => { throw new Error('private-secret'); } });
    expect(result).toMatchObject({ ok: false, persisted: false, code: 'write_failed' });
    expect(JSON.stringify(result)).not.toContain('private-secret');
    expect(transactions.readModelSettingsDisk().revision).toBe(initial.revision);
  });
  it('projects startup bindings after file preferences and before CLI overrides', () => {
    const library = { ...profiles, entries: [{ ...profiles.entries[0],
      baseUrl: 'https://profile/v1', apiKey: 'dedicated-secret' }] };
    const raw = JSON.stringify({ provider: 'google', model: 'legacy',
      apiKeys: { openai: 'shared-secret' }, modelProfiles: library });
    writeFileSync(store.getConfigPath(), raw);
    const loaded = loadConfig({ cwd: directory, model: 'flag-model', apiKey: 'startup-key' });
    expect(loaded.provider).toBe('openai');
    expect(loaded.modelProfileState?.main).toMatchObject({ appliedId: 'p',
      overriddenFields: ['model'] });
    expect(loaded.apiKeyOverrideTarget).toEqual({ provider: 'openai',
      baseUrl: 'https://profile/v1' });
    expect(makeGetApiKey(loaded)('openai')).toBe('startup-key');
    const changed = loadConfig({ cwd: directory, baseUrl: 'https://other/v1' });
    expect(makeGetApiKey(changed)('openai')).toBe('shared-secret');
    expect(changed.modelProfileState?.main.appliedId).toBeNull();
    expect(readFileSync(store.getConfigPath(), 'utf8')).toBe(raw);
    expect(store.loadPersistedConfig().model).toBe('legacy');
  });
  it('rejects dedicated key detachment even when shared credentials exist', () => {
    const current = { ...DEFAULT_CONFIG, apiKeys: { openai: 'shared' }, modelProfiles: {
      ...profiles, entries: [{ ...profiles.entries[0], apiKey: 'dedicated' }] } };
    expect(() => transactions.adaptLegacyConnectionPatch({ current,
      patch: { provider: 'google' } })).toThrow(/profile_key_required/);
  });
  it('clears the old gateway on a provider change and preserves it for model-only changes', () => {
    const current = { ...DEFAULT_CONFIG, modelProfiles: { ...profiles,
      entries: [{ ...profiles.entries[0], baseUrl: 'https://old/v1' }] } };
    expect(transactions.adaptLegacyConnectionPatch({ current,
      patch: { provider: 'google' } }).baseUrl).toBeNull();
    expect(transactions.adaptLegacyConnectionPatch({ current,
      patch: { model: 'other' } }).baseUrl).toBe('https://old/v1');
  });
  it('also clears a custom gateway when an unbound legacy role changes provider', () => {
    const current = { ...DEFAULT_CONFIG, provider: 'openai', baseUrl: 'https://old/v1',
      fast: { ...DEFAULT_CONFIG.fast, provider: 'openai', baseUrl: 'https://old-fast/v1' } };
    const patch = transactions.adaptLegacyConnectionPatch({ current,
      patch: { provider: 'google', fast: { provider: 'google' } } });
    expect(patch.baseUrl).toBeNull();
    expect(patch.fast?.baseUrl).toBe('');
  });
  it('does not let unbound main adaptation change a bound fast gateway', () => {
    const current = { ...DEFAULT_CONFIG, provider: 'anthropic', modelProfiles: {
      ...profiles, mainId: null, fastId: 'p',
      entries: [{ ...profiles.entries[0], baseUrl: 'https://fast/v1' }] } };
    const patch = transactions.adaptLegacyConnectionPatch({ current,
      patch: { provider: 'openai', fast: { provider: 'openai', model: 'new' } } });
    expect(patch.fast?.baseUrl).toBe('https://fast/v1');
  });
  it('replaces profile arrays and normalizes only explicitly submitted profiles', () => {
    store.updatePersistedConfig({ modelProfiles: { ...profiles, entries: [
      { ...profiles.entries[0], id: 'other' }, profiles.entries[0],
    ] } });
    store.updatePersistedConfig({ modelProfiles: { ...profiles, entries: [
      { ...profiles.entries[0], name: '  Daily  ', apiKey: '  dedicated  ' },
    ] } });
    const saved = store.loadPersistedConfig();
    expect(saved.modelProfiles?.entries).toHaveLength(1);
    expect(saved.modelProfiles?.entries[0]).toMatchObject({ name: 'Daily', apiKey: 'dedicated' });
    expect(saved.apiKeys).not.toHaveProperty('openai');
  });
});
