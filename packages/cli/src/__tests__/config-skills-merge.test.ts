/**
 * AC-19 / P1-5 — a partial `skills` patch must not erase the rest of the section.
 *
 * The bug this pins is silent DATA LOSS, not a crash: `/skills disable x` sends
 * `{ skills: { disabled: ['x'] } }`, and under the original shallow spread that
 * replaced the whole section — taking `trustedProjectDirs`, `allowedHosts` and
 * `requireApproval` with it. The user's experience is that disabling one skill
 * makes every previously-trusted project folder start prompting again, with
 * nothing anywhere connecting the two.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// `store.ts` calls `envPaths()` ONCE at module load, so the directory has to
// exist before the dynamic import below — a per-test `beforeEach` assignment
// would be captured as the empty string and every test would then share (and
// pollute) one real config file.
const dir = mkdtempSync(join(tmpdir(), 'argon-cfg-'));
const configPath = (): string => join(dir, 'config.json');

vi.mock('env-paths', () => ({
  default: () => ({ config: dir, data: join(dir, 'data'), cache: '', log: '', temp: '' }),
}));

const { loadPersistedConfig, updatePersistedConfig } = await import('../config/store.js');
const { DEFAULT_SKILLS_CONFIG, clampSkillsConfig } = await import('../config/schema.js');

beforeEach(() => {
  if (existsSync(configPath())) rmSync(configPath());
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('AC-19 — skills config survives a partial patch', () => {
  it('keeps trustedProjectDirs when only `disabled` is written', () => {
    updatePersistedConfig({
      skills: { ...DEFAULT_SKILLS_CONFIG, trustedProjectDirs: ['/work/repo'] },
    });
    expect(loadPersistedConfig().skills.trustedProjectDirs).toEqual(['/work/repo']);

    // Exactly the patch `/skills disable x` sends.
    updatePersistedConfig({
      skills: { disabled: ['pdf-forms'] } as (typeof DEFAULT_SKILLS_CONFIG),
    });

    const reloaded = loadPersistedConfig().skills;
    expect(reloaded.disabled).toEqual(['pdf-forms']);
    expect(reloaded.trustedProjectDirs).toEqual(['/work/repo']);
    expect(reloaded.requireApproval).toBe(true);
    expect(reloaded.allowedHosts).toEqual(DEFAULT_SKILLS_CONFIG.allowedHosts);
  });

  it('apiKeys keeps its existing deep-merge behaviour alongside skills', () => {
    updatePersistedConfig({ apiKeys: { anthropic: 'a' } });
    updatePersistedConfig({ skills: { disabled: ['x'] } as (typeof DEFAULT_SKILLS_CONFIG) });
    expect(loadPersistedConfig().apiKeys.anthropic).toBe('a');
  });
});

describe('skills.integrity / skills.usageTracking clamping', () => {
  it('defaults to warn + tracking on', () => {
    expect(DEFAULT_SKILLS_CONFIG.integrity).toBe('warn');
    expect(DEFAULT_SKILLS_CONFIG.usageTracking).toBe(true);
  });

  it('accepts all three integrity modes', () => {
    for (const mode of ['off', 'warn', 'strict'] as const) {
      expect(clampSkillsConfig({ integrity: mode }).integrity).toBe(mode);
    }
  });

  it('falls back on a bogus integrity value instead of throwing', () => {
    expect(clampSkillsConfig({ integrity: 'paranoid' }).integrity).toBe('warn');
    expect(clampSkillsConfig({ integrity: 7 }).integrity).toBe('warn');
    expect(clampSkillsConfig({ integrity: null }).integrity).toBe('warn');
  });

  it('coerces usageTracking only from a real boolean', () => {
    expect(clampSkillsConfig({ usageTracking: false }).usageTracking).toBe(false);
    // A string "false" is a config-file typo, not an opt-out; falling back to
    // the default is the same rule every other boolean field follows.
    expect(clampSkillsConfig({ usageTracking: 'false' }).usageTracking).toBe(true);
  });

  it('both keys survive a partial patch of the section (AC-19 applies to them too)', () => {
    updatePersistedConfig({
      skills: { ...DEFAULT_SKILLS_CONFIG, integrity: 'strict', usageTracking: false },
    });
    updatePersistedConfig({
      skills: { disabled: ['pdf-forms'] } as (typeof DEFAULT_SKILLS_CONFIG),
    });

    const reloaded = loadPersistedConfig().skills;
    expect(reloaded.integrity).toBe('strict');
    expect(reloaded.usageTracking).toBe(false);
    expect(reloaded.disabled).toEqual(['pdf-forms']);
  });

  it('a config file written before these keys existed still loads', () => {
    // The on-disk shape from iteration 1 — neither key present.
    writeFileSync(
      configPath(),
      JSON.stringify({ version: 1, skills: { enabled: true, disabled: ['x'] } }),
      'utf-8',
    );
    const loaded = loadPersistedConfig().skills;
    expect(loaded.integrity).toBe('warn');
    expect(loaded.usageTracking).toBe(true);
    expect(loaded.disabled).toEqual(['x']);
  });
});

describe('AC-11 — a config file predating skills still loads', () => {
  it('fills in the whole section from defaults', () => {
    writeFileSync(
      configPath(),
      JSON.stringify({ version: 1, provider: 'openai', model: 'gpt-4o' }),
      'utf-8',
    );
    const loaded = loadPersistedConfig();
    expect(loaded.provider).toBe('openai');
    expect(loaded.skills).toEqual(DEFAULT_SKILLS_CONFIG);
  });

  it('a corrupt skills section falls back instead of throwing', () => {
    writeFileSync(
      configPath(),
      JSON.stringify({ version: 1, skills: 'not an object' }),
      'utf-8',
    );
    expect(() => loadPersistedConfig()).not.toThrow();
    expect(loadPersistedConfig().skills).toEqual(DEFAULT_SKILLS_CONFIG);
  });

  it('wrong-typed fields inside skills fall back field by field', () => {
    writeFileSync(
      configPath(),
      JSON.stringify({
        version: 1,
        skills: {
          enabled: 'yes',
          disabled: 'pdf-forms',
          allowedHosts: 42,
          catalogMaxBytes: 'huge',
          trustedProjectDirs: ['/keep/me'],
        },
      }),
      'utf-8',
    );
    const skills = loadPersistedConfig().skills;
    expect(skills.enabled).toBe(true);
    expect(skills.disabled).toEqual([]);
    expect(skills.allowedHosts).toEqual(DEFAULT_SKILLS_CONFIG.allowedHosts);
    expect(skills.catalogMaxBytes).toBe(DEFAULT_SKILLS_CONFIG.catalogMaxBytes);
    // A well-formed field alongside broken ones is still honoured.
    expect(skills.trustedProjectDirs).toEqual(['/keep/me']);
  });

  it('the written file round-trips', () => {
    updatePersistedConfig({ skills: { requireApproval: false } as (typeof DEFAULT_SKILLS_CONFIG) });
    const raw = JSON.parse(readFileSync(configPath(), 'utf-8'));
    expect(raw.skills.requireApproval).toBe(false);
    expect(raw.skills.allowedHosts).toEqual(DEFAULT_SKILLS_CONFIG.allowedHosts);
  });
});

describe('clampSkillsConfig — byte budgets (C6)', () => {
  it('clamps catalogMaxBytes into [500, 40000]', () => {
    expect(clampSkillsConfig({ catalogMaxBytes: 1 }).catalogMaxBytes).toBe(500);
    expect(clampSkillsConfig({ catalogMaxBytes: 999_999 }).catalogMaxBytes).toBe(40_000);
    expect(clampSkillsConfig({ catalogMaxBytes: 8000 }).catalogMaxBytes).toBe(8000);
  });

  it('clamps bodyMaxBytes to 50000, NOT the 90000 an earlier draft allowed', () => {
    // 90 000 CHARACTERS of CJK is 270 000 bytes — three times ToolExecutor's
    // ceiling, which would chop the closing tag off every large skill (D19).
    expect(clampSkillsConfig({ bodyMaxBytes: 90_000 }).bodyMaxBytes).toBe(50_000);
    expect(clampSkillsConfig({ bodyMaxBytes: 10 }).bodyMaxBytes).toBe(1000);
  });

  it('is idempotent over its own output', () => {
    const once = clampSkillsConfig({ disabled: ['a'], catalogMaxBytes: 7000 });
    expect(clampSkillsConfig(once)).toEqual(once);
  });
});

describe('skills.toolPolicy (§12.1 / D-G8)', () => {
  it('defaults to enforce', () => {
    // Not `warn`, unlike `integrity`. A false integrity alarm punishes a user
    // for editing a file they own; a ceiling refusal needs a skill AUTHOR to
    // have under-declared their own skill, which doctor reports up front.
    expect(clampSkillsConfig({}).toolPolicy).toBe('enforce');
    expect(DEFAULT_SKILLS_CONFIG.toolPolicy).toBe('enforce');
  });

  it('accepts the three modes and falls back on anything else', () => {
    for (const mode of ['off', 'warn', 'enforce']) {
      expect(clampSkillsConfig({ toolPolicy: mode }).toolPolicy).toBe(mode);
    }
    for (const bad of ['ENFORCE', 'strict', 42, null, {}]) {
      expect(clampSkillsConfig({ toolPolicy: bad }).toolPolicy).toBe('enforce');
    }
  });

  it('survives a partial patch alongside the other skills keys', () => {
    const merged = clampSkillsConfig({ toolPolicy: 'warn', trustedProjectDirs: ['/a'] });
    expect(merged.toolPolicy).toBe('warn');
    expect(merged.trustedProjectDirs).toEqual(['/a']);
    expect(clampSkillsConfig(merged)).toEqual(merged);
  });
});
