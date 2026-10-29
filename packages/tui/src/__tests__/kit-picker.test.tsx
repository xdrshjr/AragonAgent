/**
 * The `ctrl+K` list's view model (agent-model-kits AC-24 / AC-26 / §4.6).
 *
 * THE ROW ORDER IS AN ASSERTION, NOT A LAYOUT DETAIL: `Current setup` is the
 * only row that can always be chosen and the only way out of a session kit, so a
 * list whose exit moves with the data is a list every user has to re-read.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type CliConfig } from '../model/config/schema.js';
import { normalizeModelProfiles } from '../model/config/model-profiles.js';
import { INACTIVE_KIT, type ActiveKit } from '../model/config/kit-resolution.js';
import { NO_KITS_HINT, connectionText, kitDetail, kitPickHint, kitRows }
  from '../ui/overlays/kit-picker-state.js';
import type { AgentKit } from '../model/config/model-kits.js';

const kit = (over: Partial<AgentKit> = {}): AgentKit => ({ id: 'kit-1', name: 'Deep work',
  mainProfileId: 'p-main', fastProfileId: 'p-fast',
  subagent: { model: 'fast', modelProfileId: null }, ...over });

const library = (kits: unknown[] = [kit()]) => normalizeModelProfiles({ version: 1,
  mainId: 'p-main', fastId: 'p-fast',
  entries: [
    { id: 'p-main', name: 'Opus', provider: 'anthropic', model: 'opus-4',
      baseUrl: null, apiKey: null, contextWindow: 200000 },
    { id: 'p-fast', name: 'Haiku', provider: 'anthropic', model: 'haiku-4',
      baseUrl: 'https://gw.example/v1', apiKey: null, contextWindow: 120000 },
  ], kits, defaultKitId: 'kit-1', kitsVersion: 1 });

const config = (over: Partial<CliConfig> = {}): CliConfig => ({
  ...structuredClone(DEFAULT_CONFIG), provider: 'anthropic', model: 'opus-4',
  fast: { ...DEFAULT_CONFIG.fast, enabled: false, provider: '', model: '', baseUrl: '' },
  team: { ...DEFAULT_CONFIG.team, model: 'main' },
  modelProfiles: library(), ...over } as unknown as CliConfig);

const active = (over: Partial<ActiveKit> = {}): ActiveKit => ({ ...INACTIVE_KIT, ...over });

describe('AC-24: Current setup is always first, and the order never moves', () => {
  it('puts Current setup first and then the library in its own order', () => {
    const rows = kitRows({ library: library([kit(), kit({ id: 'kit-2', name: 'Cheap' })]),
      active: active() });
    expect(rows.map((row) => row.id)).toEqual([null, 'kit-1', 'kit-2']);
    expect(rows[0]!.label).toContain('Current setup');
  });

  it('does not reorder when a kit becomes active', () => {
    const lib = library([kit(), kit({ id: 'kit-2', name: 'Cheap' })]);
    const before = kitRows({ library: lib, active: active() });
    const after = kitRows({ library: lib, active: active({ source: 'session', id: 'kit-2',
      name: 'Cheap', held: ['main', 'fast', 'subagent'] }) });
    expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));
  });

  it('marks in-use, default and drift on the right rows', () => {
    const rows = kitRows({ library: library(), active: active({ source: 'session',
      id: 'kit-1', name: 'Deep work', held: ['main'], modified: true }) });
    expect(rows[0]!.markers.inUse).toBe(false);
    expect(rows[1]!.markers).toEqual({ inUse: true, isDefault: true, modified: true });
    expect(rows[1]!.label).toContain('[In use]');
    expect(rows[1]!.label).toContain('[Default]');
    expect(rows[1]!.label.endsWith('~')).toBe(true);
  });

  it('gives duplicate names an id prefix, like the profile picker does', () => {
    const rows = kitRows({ library: library([kit({ id: 'abcdef12', name: 'Same' }),
      kit({ id: 'abcdef99', name: 'Same' })]), active: active() });
    expect(rows[1]!.label).toContain('#abcdef12');
    expect(rows[2]!.label).toContain('#abcdef99');
  });
});

describe('AC-26: an empty library still offers the way in', () => {
  it('renders only Current setup, marked in use, plus the guidance line', () => {
    const rows = kitRows({ library: library([]), active: active() });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.label).toBe('[In use] Current setup');
    expect(NO_KITS_HINT).toContain('/settings');
    expect(kitPickHint({ busy: false, hasKits: false })).toContain('/settings');
  });

  it('treats a missing library as an empty one', () => {
    expect(kitRows({ library: undefined, active: active() })).toHaveLength(1);
  });
});

describe('the detail block describes the focused row only', () => {
  it('prints the three connections of a kit', () => {
    const rows = kitRows({ library: library(), active: active() });
    const detail = kitDetail({ row: rows[1]!, library: library(), config: config() });
    expect(detail[0]).toContain('anthropic:opus-4');
    expect(detail[1]).toContain('fast tier');
    expect(detail[2]).toContain('tier on');
  });

  it('says `off` for a kit that turns the tier off', () => {
    const lib = library([kit({ fastProfileId: null })]);
    const detail = kitDetail({ row: kitRows({ library: lib, active: active() })[1]!,
      library: lib, config: config() });
    expect(detail[2]).toContain('off');
  });

  it('describes Current setup from the FILE bindings, which is what it restores', () => {
    const detail = kitDetail({ row: kitRows({ library: library(), active: active() })[0]!,
      library: library(), config: config() });
    expect(detail[0]).toContain('anthropic:opus-4');
    expect(detail[1]).toContain('same as main');
    expect(detail[2]).toContain('off');
  });

  it('reads Current setup from the FILE, not from the kit the live config mirrors', () => {
    // THE DEFECT THIS CATCHES: once a session kit is applied the LIVE config
    // carries the kit's bindings (I-6), so describing `Current setup` from it
    // would print the kit's three connections and promise that releasing changes
    // nothing. The first row is the only row whose whole meaning is "the file".
    const live = config({ model: 'kit-model',
      fast: { ...DEFAULT_CONFIG.fast, enabled: true, provider: 'anthropic',
        model: 'kit-fast', baseUrl: '' } });
    const file = config({ model: 'file-model' });
    const detail = kitDetail({ row: kitRows({ library: library(), active: active() })[0]!,
      library: library(), config: live, diskConfig: file });
    expect(detail[0]).toContain('anthropic:file-model');
    expect(detail[0]).not.toContain('kit-model');
  });

  it('renders a missing profile instead of an empty cell', () => {
    const lib = library([kit({ mainProfileId: 'gone' })]);
    const detail = kitDetail({ row: kitRows({ library: lib, active: active() })[1]!,
      library: lib, config: config() });
    expect(detail[0]).toContain('Profile missing');
  });
});

describe('endpoints and the footer', () => {
  it('names the host of a custom endpoint and `default URL` otherwise', () => {
    expect(connectionText({ provider: 'anthropic', model: 'm', baseUrl: null, name: 'n' }))
      .toContain('default URL');
    expect(connectionText({ provider: 'anthropic', model: 'm',
      baseUrl: 'https://gw.example/v1', name: 'n' })).toContain('gw.example');
  });

  it('says the apply is blocked while running, without hiding the list', () => {
    expect(kitPickHint({ busy: true, hasKits: true })).toContain('blocked');
    expect(kitPickHint({ busy: false, hasKits: true })).toContain('Enter');
  });

  it('says where a default is set, because Enter only lasts this session (D-7)', () => {
    const hint = kitPickHint({ busy: false, hasKits: true });
    expect(hint).toContain('Set a default in /settings');
    // The action stays first, so a narrow terminal clips the pointer not the key.
    expect(hint.indexOf('Enter')).toBeLessThan(hint.indexOf('Set a default'));
  });
});
