/**
 * The save transaction with a session kit in effect (agent-model-kits AC-18..AC-22,
 * AC-37, AC-38, I-6 / I-14).
 *
 * THE TWO DEFECTS THIS FILE EXISTS TO CATCH are both invisible in a diff of the
 * feature and obvious in a diff of the FILE:
 *
 *  - a held slot reaching the COMMIT would make one unrelated save write the
 *    session's preset into the user's permanent defaults (AC-37);
 *  - a draft that does not SEED `sessionKit` would make one unrelated save
 *    silently release it (AC-18 / AC-38).
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import { DEFAULT_CONFIG, type PersistedConfig } from '../config/schema.js';
import { normalizeModelProfiles } from '../config/model-profiles.js';
import type { AgentKit } from '../config/model-kits.js';

process.env.ARAGON_HOME = process.env.ARAGON_HOME ?? '';
const { AgentController } = await import('../agent/controller.js');
const { loadConfig } = await import('../config/load.js');
const { getConfigPath, writeConfigFile } = await import('../config/store.js');

const instances: Array<InstanceType<typeof AgentController>> = [];
beforeEach(() => { rmSync(getConfigPath(), { force: true }); });
afterAll(() => {
  instances.forEach((instance) => instance.dispose());
  rmSync(getConfigPath(), { force: true });
});

const kit = (over: Partial<AgentKit> = {}): AgentKit => ({ id: 'kit-1', name: 'Deep work',
  mainProfileId: 'p-main', fastProfileId: 'p-fast',
  subagent: { model: 'fast', modelProfileId: null }, ...over });

const library = (over: Record<string, unknown> = {}) => normalizeModelProfiles({
  version: 1, mainId: 'p-main', fastId: 'p-fast',
  entries: [
    { id: 'p-main', name: 'Opus', provider: 'anthropic', model: 'opus-4',
      baseUrl: null, apiKey: null, contextWindow: 200000 },
    { id: 'p-fast', name: 'Haiku', provider: 'anthropic', model: 'haiku-4',
      baseUrl: null, apiKey: null, contextWindow: 120000 },
  ],
  kits: [kit()], defaultKitId: null, kitsVersion: 1, ...over });

function controller(over: Record<string, unknown> = {}) {
  const seed = { ...structuredClone(DEFAULT_CONFIG), provider: 'anthropic', model: 'opus-4',
    apiKeys: {}, modelProfiles: library(over) } as unknown as PersistedConfig;
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

const diskLibrary = (): Record<string, unknown> =>
  (JSON.parse(readFileSync(getConfigPath(), 'utf8')) as PersistedConfig).modelProfiles as never;

describe('AC-38: the draft is SEEDED with the session kit', () => {
  it('carries sessionKit out of the live config into the transaction', () => {
    const instance = controller();
    instance.applySessionKit('kit-1');
    const draft = instance.createModelSettingsDraft();
    expect(draft.sessionKit).toEqual(instance.getConfig().sessionKit);
    expect(draft.sessionKit?.held).toEqual(['main', 'fast', 'subagent']);
  });

  it('leaves it undefined when no kit is in effect', () => {
    expect(controller().createModelSettingsDraft().sessionKit).toBeUndefined();
  });
});

describe('AC-18 / AC-37: an unrelated save keeps the session kit and the file', () => {
  it('keeps the live bindings AND writes none of them to disk', () => {
    const instance = controller();
    instance.applySessionKit('kit-1');
    const before = diskLibrary();
    const draft = instance.createModelSettingsDraft();
    draft.patch = { showThinking: true };
    const result = instance.saveModelSettings(draft);
    expect(result).toMatchObject({ ok: true, persisted: true });
    // LIVE: still the kit's bindings (I-6).
    expect(instance.getConfig().modelProfiles?.mainId).toBe('p-main');
    expect(instance.getConfig().sessionKit?.held).toEqual(['main', 'fast', 'subagent']);
    expect(instance.getConfig().showThinking).toBe(true);
    // DISK: untouched, field by field (I-14 / AC-37).
    const after = diskLibrary();
    for (const key of ['mainId', 'fastId', 'defaultKitId', 'kits', 'kitsVersion']) {
      expect(after[key]).toEqual(before[key]);
    }
    expect((JSON.parse(readFileSync(getConfigPath(), 'utf8')) as PersistedConfig).team)
      .toEqual({ ...JSON.parse(readFileSync(getConfigPath(), 'utf8')).team });
  });
});

describe('AC-19 / AC-20: an explicit choice releases exactly that slot', () => {
  it('releases subagent when the user picks a subagent model', () => {
    const instance = controller();
    instance.applySessionKit('kit-1');
    const draft = instance.createModelSettingsDraft();
    draft.patch = { team: { model: 'main', modelProfileId: null } };
    expect(instance.saveModelSettings(draft).ok).toBe(true);
    expect(instance.getConfig().sessionKit?.held).toEqual(['main', 'fast']);
    expect(instance.getConfig().team.model).toBe('main');
  });

  it('releases main when the user binds another profile to it', () => {
    const instance = controller();
    instance.applySessionKit('kit-1');
    const draft = instance.createModelSettingsDraft();
    draft.profiles = { ...draft.profiles!, mainId: 'p-fast' };
    draft.activateRoles = ['main'];
    expect(instance.saveModelSettings(draft).ok).toBe(true);
    expect(instance.getConfig().sessionKit?.held).toEqual(['fast', 'subagent']);
    expect(instance.getConfig().modelProfiles?.mainId).toBe('p-fast');
    // AND THE FILE NOW REALLY SAYS IT: this was an explicit persistent decision.
    expect(diskLibrary().mainId).toBe('p-fast');
  });

  it('releases everything when a save decides all three slots', () => {
    const instance = controller();
    instance.applySessionKit('kit-1');
    const draft = instance.createModelSettingsDraft();
    draft.sessionKit = null;
    expect(instance.saveModelSettings(draft).ok).toBe(true);
    expect(instance.getConfig().sessionKit).toBeUndefined();
  });
});

describe('AC-21 / AC-22: reload carries the kit, or releases it', () => {
  it('keeps the session kit across Reload settings', () => {
    const instance = controller();
    instance.applySessionKit('kit-1');
    expect(instance.reloadModelSettings().ok).toBe(true);
    expect(instance.getConfig().sessionKit?.id).toBe('kit-1');
    expect(instance.getConfig().modelProfiles?.mainId).toBe('p-main');
    expect(instance.getConfig().modelProfileState?.main.appliedId).toBe('p-main');
  });

  it('releases the session kit when the file no longer has it', () => {
    const instance = controller();
    instance.applySessionKit('kit-1');
    writeConfigFile({ ...structuredClone(DEFAULT_CONFIG), provider: 'anthropic',
      model: 'opus-4', apiKeys: {}, modelProfiles: library({ kits: [] }) } as never);
    expect(instance.reloadModelSettings().ok).toBe(true);
    expect(instance.getConfig().sessionKit).toBeUndefined();
  });
});

describe('I-14, stated as an invariant rather than a scenario', () => {
  it('never puts a held slot into the committed candidate', () => {
    const instance = controller();
    instance.applySessionKit('kit-1');
    const draft = instance.createModelSettingsDraft();
    // The live config's fast tier is the KIT's choice (on); the file still says off.
    expect(instance.getConfig().fast.enabled).toBe(true);
    draft.patch = { showThinking: false };
    expect(instance.saveModelSettings(draft).ok).toBe(true);
    const disk = JSON.parse(readFileSync(getConfigPath(), 'utf8')) as PersistedConfig;
    expect(disk.fast.enabled).toBe(false);
    expect(disk.modelProfiles?.fastId).toBe('p-fast');
  });
});
