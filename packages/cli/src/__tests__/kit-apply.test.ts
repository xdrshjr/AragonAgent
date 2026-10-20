/**
 * The session exit and the release exit (agent-model-kits AC-8..AC-17, AC-39,
 * AC-40, I-5 / I-10 / I-13 / I-14).
 *
 * TWO HALVES, DELIBERATELY. The refusal-CODES half runs against a five-method
 * stub port, because a code that only the disk can produce is a code nobody can
 * prove is reachable - and the point of RV-P1-3 is that every code has a
 * sentence. The SEMANTIC half runs against a real `AgentController` on a
 * throwaway `ARAGON_HOME`, because "the fast endpoints did not move" is a claim
 * about `liveCandidate`, and a stub asserting it would only be asserting itself.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DEFAULT_CONFIG, type CliConfig, type PersistedConfig } from '../config/schema.js';
import { normalizeModelProfiles } from '../config/model-profiles.js';
import { applySessionKit, clearSessionKit, kitApplyMessage, kitNoteMessage,
  type KitApplyPort } from '../agent/kit-apply.js';
import type { AgentKit } from '../config/model-kits.js';
import type { ModelSettingsDraft, ModelSettingsSaveResult } from '../config/model-profile-store.js';

// THIS FILE SEEDS `config.json`, SO IT MUST OWN ITS PATH.
//
// `app-paths.ts` resolves the home root ONCE per process, and the `main` project
// runs its files on the THREADS pool, where every file in a worker shares that
// process - and therefore the pid-based temp root the resolver falls back to.
// Two kit files seeding that one file delete each other's seed (measured: this
// file's `applySessionKit` answered `kit_missing` only when it shared a worker
// with its sibling). Assigning the mutable env key is also how `vitest.config.ts`
// RECOGNISES an env-mutating file and moves it onto the forks pool, where each
// file already has a process of its own; the unique directory below is the
// belt to that braces, and an inherited value is never overwritten.
process.env.ARAGON_HOME = process.env.ARAGON_HOME
  ?? mkdtempSync(join(tmpdir(), 'aragon-kit-apply-'));

const { AgentController } = await import('../agent/controller.js');
const { loadConfig } = await import('../config/load.js');
const { getConfigPath, writeConfigFile } = await import('../config/store.js');
const { resolveSubagentModel } = await import('../team/model.js');

const instances: Array<InstanceType<typeof AgentController>> = [];
beforeEach(() => { rmSync(getConfigPath(), { force: true }); });
afterAll(() => { instances.forEach((instance) => instance.dispose()); });

const kit = (over: Partial<AgentKit> = {}): AgentKit => ({ id: 'kit-1', name: 'Deep work',
  mainProfileId: 'p-main', fastProfileId: 'p-fast',
  subagent: { model: 'fast', modelProfileId: null }, ...over });

const ENTRIES = [
  { id: 'p-main', name: 'Opus', provider: 'anthropic', model: 'opus-4',
    baseUrl: null, apiKey: null, contextWindow: 200000 },
  { id: 'p-fast', name: 'Haiku', provider: 'anthropic', model: 'haiku-4',
    baseUrl: null, apiKey: null, contextWindow: 120000 },
];

const library = (over: Record<string, unknown> = {}) => normalizeModelProfiles({
  version: 1, mainId: 'p-main', fastId: 'p-fast', entries: ENTRIES,
  kits: [kit()], defaultKitId: null, kitsVersion: 1, ...over });

/** A real controller over a throwaway config, seeded with `over`. */
function controller(over: Record<string, unknown> = {}) {
  const seed = { ...structuredClone(DEFAULT_CONFIG), provider: 'openai', model: 'startup',
    apiKey: undefined, apiKeys: {}, modelProfiles: library(over) } as unknown as PersistedConfig;
  writeConfigFile(seed);
  const live = loadConfig({ cwd: process.cwd() });
  live.skills.enabled = false;
  live.team.enabled = false;
  live.fast.enabled = false;
  live.compaction.enabled = false;
  const instance = new AgentController(live, {});
  instances.push(instance);
  return instance;
}

const diskBytes = (): string => readFileSync(getConfigPath(), 'utf8');

describe('AC-8..AC-11: applying a kit for this session', () => {
  it('rebinds all three roles from the kit', () => {
    const instance = controller();
    const result = instance.applySessionKit('kit-1');
    expect(result).toMatchObject({ ok: true, notes: expect.any(Array) });
    const live = instance.getConfig();
    expect(live.provider).toBe('anthropic');
    expect(live.model).toBe('opus-4');
    expect(live.fast.enabled).toBe(true);
    expect(live.fast.model).toBe('haiku-4');
    expect(live.team.model).toBe('fast');
  });

  it('records exactly the three held slots (AC-9)', () => {
    const instance = controller();
    instance.applySessionKit('kit-1');
    expect(instance.getConfig().sessionKit).toEqual({ id: 'kit-1',
      held: ['main', 'fast', 'subagent'] });
  });

  it('writes NO bytes to config.json (AC-10 / I-5)', () => {
    const instance = controller();
    const before = diskBytes();
    instance.applySessionKit('kit-1');
    expect(diskBytes()).toBe(before);
  });

  it('refuses while work is in flight and changes nothing (AC-11 / I-10)', () => {
    const instance = controller();
    const live = instance.getConfig();
    const spy = vi.spyOn(instance, 'isModelSettingsBusy').mockReturnValue(true);
    const result = instance.applySessionKit('kit-1');
    spy.mockRestore();
    expect(result).toMatchObject({ ok: false, code: 'busy' });
    expect(instance.getConfig()).toBe(live);
  });

  it('leaves the fast endpoints alone when the kit turns the tier OFF (I-13)', () => {
    const instance = controller({ kits: [kit({ fastProfileId: null })] });
    const before = instance.getConfig().fast;
    instance.applySessionKit('kit-1');
    const after = instance.getConfig().fast;
    expect(after.enabled).toBe(false);
    expect({ provider: after.provider, model: after.model, baseUrl: after.baseUrl })
      .toEqual({ provider: before.provider, model: before.model, baseUrl: before.baseUrl });
  });

  it('carries the profile context window and its origin (AC-13)', () => {
    const instance = controller();
    instance.applySessionKit('kit-1');
    expect(instance.getConfig().contextWindow).toBe(200000);
    expect(instance.getConfig().contextWindowOrigin).toBe('profile');
  });

  it('publishes the binding state the settings screen reads (AC-14)', () => {
    const instance = controller();
    instance.applySessionKit('kit-1');
    expect(instance.getConfig().modelProfileState?.main.selectedId).toBe('p-main');
  });
});

describe('AC-15..AC-17: the notes are the disclosure', () => {
  it('warns that the main profile has no key, and still applies (AC-15)', () => {
    const instance = controller();
    const result = instance.applySessionKit('kit-1');
    expect(result.ok).toBe(true);
    expect(result.notes).toContain('main_key_missing');
  });

  it('discloses the recurring review spend the tier switch turns on (AC-16)', () => {
    const instance = controller();
    expect(instance.applySessionKit('kit-1').notes).toContain('fast_review_enabled');
    const quiet = controller({ fast: undefined });
    quiet.setFastConfig({ review: false });
    const notes = quiet.applySessionKit('kit-1').notes;
    expect(notes).toContain('fast_tier_enabled');
    expect(notes).not.toContain('fast_review_enabled');
  });

  it('says so when the kit turns the tier off under a fast-using subagent (AC-17)', () => {
    const instance = controller({ kits: [kit({ fastProfileId: null,
      subagent: { model: 'fast', modelProfileId: null } })] });
    const result = instance.applySessionKit('kit-1');
    expect(result.notes).toContain('subagent_fast_unavailable');
    const resolution = resolveSubagentModel(instance.getConfig(), () => true);
    expect(resolution.effective).toBe('main');
  });
});

describe('AC-39: a dangling reference degrades, it does not break', () => {
  it('refuses the apply with a stable code and touches nothing', () => {
    const instance = controller({ kits: [kit({ mainProfileId: 'gone' })] });
    const live = instance.getConfig();
    const before = diskBytes();
    const result = instance.applySessionKit('kit-1');
    expect(result).toMatchObject({ ok: false, code: 'kit_references_missing_profile' });
    expect(result.issues?.[0]?.message).toContain('main');
    expect(instance.getConfig()).toBe(live);
    expect(diskBytes()).toBe(before);
    // AND THE SETTINGS PAGE STILL OPENS: validation is structural only (RV-P1-1).
    expect(instance.createModelSettingsDraft().readError).toBeUndefined();
  });
});

describe('AC-40: the release exit', () => {
  it('returns every role to the config file and keeps the file untouched', () => {
    const instance = controller();
    const diskMain = instance.getConfig().model;
    const before = diskBytes();
    instance.applySessionKit('kit-1');
    const released = instance.clearSessionKit();
    expect(released).toMatchObject({ ok: true, released: true });
    const live = instance.getConfig();
    expect(live.sessionKit).toBeUndefined();
    expect(live.model).toBe(diskMain);
    expect(live.fast.enabled).toBe(false);
    expect(live.modelProfileState?.main.appliedId).toBe('p-main');
    expect(diskBytes()).toBe(before);
  });

  it('refuses while busy, like every other settings action', () => {
    const instance = controller();
    instance.applySessionKit('kit-1');
    const spy = vi.spyOn(instance, 'isModelSettingsBusy').mockReturnValue(true);
    const released = instance.clearSessionKit();
    spy.mockRestore();
    expect(released).toMatchObject({ ok: false, code: 'busy' });
    expect(instance.getConfig().sessionKit).toEqual({ id: 'kit-1',
      held: ['main', 'fast', 'subagent'] });
  });
});

/** The narrow-port half: every refusal code, and a sentence for each. */
describe('AC-12: the code set is closed and every code has a message', () => {
  const CODES = ['busy', 'conflict', 'read_failed', 'write_failed', 'invalid',
    'profile_key_required', 'legacy_conversion_unsupported', 'apply_failed',
    'kit_missing', 'kit_references_missing_profile'] as const;

  function port(previewResult: ModelSettingsSaveResult, over: Partial<KitApplyPort> = {}) {
    const config = { ...structuredClone(DEFAULT_CONFIG), provider: 'anthropic',
      model: 'opus-4', modelProfiles: library() } as unknown as CliConfig;
    const draft: ModelSettingsDraft = { patch: {}, activateRoles: [], diskRevision: 'x',
      liveRevision: 0, profiles: library(), baseline: structuredClone(config) as never,
      liveBaseline: structuredClone(config) };
    const preview = vi.fn(() => previewResult);
    return { port: { getConfig: () => config, isBusy: () => false, hasKey: () => true,
      createDraft: () => structuredClone(draft), preview, ...over } satisfies KitApplyPort,
    preview };
  }

  it.each(CODES)('renders a non-empty sentence for %s', (code) => {
    const message = kitApplyMessage({ ok: false, code, notes: [] });
    expect(message.length).toBeGreaterThan(10);
    expect(message).not.toContain('undefined');
  });

  it('passes the preview failure through unchanged', () => {
    for (const code of ['conflict', 'read_failed', 'invalid', 'apply_failed'] as const) {
      const stub = port({ ok: false, persisted: false, status: 'rejected', code });
      expect(applySessionKit({ kitId: 'kit-1', port: stub.port }))
        .toMatchObject({ ok: false, code });
      expect(stub.preview).toHaveBeenCalledTimes(1);
    }
  });

  it('reports a missing kit before ever reaching the preview', () => {
    const stub = port({ ok: true, persisted: false, status: 'applied' });
    expect(applySessionKit({ kitId: 'nope', port: stub.port }))
      .toMatchObject({ ok: false, code: 'kit_missing' });
    expect(stub.preview).not.toHaveBeenCalled();
  });

  it('has a sentence for every note, including the money one', () => {
    expect(kitNoteMessage('fast_review_enabled')).toContain('/fast review off');
    expect(kitNoteMessage('subagent_fast_unavailable')).toContain('fall back to main');
  });
});
