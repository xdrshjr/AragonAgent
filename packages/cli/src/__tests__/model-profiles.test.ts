import { describe, expect, it } from 'vitest';
import * as profiles from '../config/model-profiles.js';

const entry: profiles.ModelProfile = { id: 'one', name: 'Daily', provider: 'openai', model: 'custom',
  baseUrl: null, apiKey: null };
const library = (entries = [entry]) => ({ version: 1, entries, mainId: 'one', fastId: null });

describe('profile validation', () => {
  it('accepts custom models and rejects duplicate IDs and missing references', () => {
    expect(profiles.validateModelProfiles(library())).toEqual([]);
    expect(profiles.validateModelProfiles(library([entry, entry]))[0]?.code).toBe('duplicate_id');
    expect(profiles.validateModelProfiles({ ...library(), fastId: 'missing' })[0]?.code)
      .toBe('missing_reference');
  });
  it('rejects unsafe URLs and never includes their contents in diagnostics', () => {
    for (const baseUrl of ['https://secret@host/v1', 'https://host?key=secret',
      'https://host/#secret', 'file:///secret', 'https://host/?', 'https://host/#']) {
      const issues = profiles.validateModelProfiles(library([{ ...entry, baseUrl }]));
      expect(issues.length).toBeGreaterThan(0);
      expect(JSON.stringify(issues)).not.toContain(baseUrl);
    }
  });
  it('normalizes names by Unicode code point and preserves endpoint spelling', () => {
    const result = profiles.normalizeModelProfiles(library([{ ...entry, name: '',
      model: '😀'.repeat(90), baseUrl: ' https://host/v1/ ' }]));
    expect([...result.entries[0].name]).toHaveLength(80);
    expect(result.entries[0].baseUrl).toBe('https://host/v1/');
    expect(profiles.validateModelProfiles(library([{ ...entry, name: '😀'.repeat(81) }]))[0])
      .toMatchObject({ path: 'modelProfiles.entries[0].name' });
  });
  it('rejects control characters, empty dedicated credentials and invalid structures', () => {
    for (const value of [null, [], { version: 2 }, library([{ ...entry, apiKey: '' }]),
      library([{ ...entry, name: 'x\ny' }]), library([{ ...entry, id: '' }])]) {
      expect(profiles.validateModelProfiles(value).length).toBeGreaterThan(0);
    }
  });
  it('creates and copies distinct stable IDs without splitting Unicode names', () => {
    const created = profiles.createModelProfile({ ...entry, name: '', model: '😀'.repeat(90) });
    const copied = profiles.duplicateModelProfile(created);
    expect(created.id).not.toBe(copied.id);
    expect([...created.name]).toHaveLength(80);
    expect([...copied.name]).toHaveLength(80);
    expect(copied.name.endsWith(' (copy)')).toBe(true);
  });
  it('protects referenced entries from deletion and enforces the library limit', () => {
    const current = { ...library(), version: 1 as const };
    expect(() => profiles.removeModelProfile(current, 'one')).toThrow();
    expect(profiles.removeModelProfile({ ...current, mainId: null }, 'one').entries).toEqual([]);
    const entries = Array.from({ length: 201 }, (_, index) => ({ ...entry, id: `${index}` }));
    expect(profiles.validateModelProfiles({ ...library(entries), mainId: '0' })[0]?.path)
      .toBe('modelProfiles.entries');
  });
});
