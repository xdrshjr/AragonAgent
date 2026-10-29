import { describe, expect, it } from 'vitest';
import {
  clampCompactionConfig, DEFAULT_CONFIG, HARD_MAX_SUBAGENTS, IDLE_TIMEOUT_MARGIN_MS,
} from '@aragon-agent/tui/model/config/schema';
import type { ConfigViewDto } from '../../../shared/config-view.js';
import { fieldBounds, parseFieldInput } from '../settings-fields.js';
import { pruneEdits, readBase, resolveSection } from '../settings-draft.js';
import { SECTIONS } from '../settings-sections.js';

/** A view shaped like the host's: every section at the engine's defaults, keys masked. */
function viewOf(overrides: Record<string, unknown> = {}): ConfigViewDto {
  return { ...DEFAULT_CONFIG, apiKeys: {}, modelProfiles: null, ...overrides } as unknown as ConfigViewDto;
}

describe('every settings field is backed by the engine', () => {
  it('has a key the engine clamp knows, for every section', () => {
    for (const section of Object.values(SECTIONS)) {
      const known = Object.keys(section.clamp({}));
      for (const field of section.fields) {
        expect(known, `${section.id}.${field.key}`).toContain(field.key);
      }
    }
  });

  it('reads each section from the view', () => {
    const base = readBase(SECTIONS.team, viewOf());
    expect(base.maxSubagents).toBe(DEFAULT_CONFIG.team.maxSubagents);
    expect(readBase(SECTIONS.agent, viewOf({ confirmTools: true })).confirmTools).toBe(true);
  });
});

describe('field bounds are probed from the engine', () => {
  it('reports the team ceiling the engine enforces', () => {
    const merged = readBase(SECTIONS.team, viewOf());
    const field = SECTIONS.team.fields.find((candidate) => candidate.key === 'maxSubagents')!;
    expect(fieldBounds(SECTIONS.team, field, merged)).toEqual({ min: 1, max: HARD_MAX_SUBAGENTS });
  });

  it('bounds a dependent field by its current partner', () => {
    const merged = { ...readBase(SECTIONS.team, viewOf()), maxSubagents: 3 };
    const field = SECTIONS.team.fields.find((candidate) => candidate.key === 'maxConcurrent')!;
    expect(fieldBounds(SECTIONS.team, field, merged).max).toBe(3);
  });

  it('knows a fractional range and that zero is allowed where the engine allows it', () => {
    const merged = readBase(SECTIONS.compaction, viewOf());
    const threshold = SECTIONS.compaction.fields.find((candidate) => candidate.key === 'threshold')!;
    expect(fieldBounds(SECTIONS.compaction, threshold, merged)).toEqual({ min: 0.5, max: 0.95 });
    const timeout = SECTIONS.team.fields.find((candidate) => candidate.key === 'subagentTimeoutMs')!;
    expect(fieldBounds(SECTIONS.team, timeout, readBase(SECTIONS.team, viewOf())).min).toBe(0);
  });

  it('has no ceiling where the engine has none', () => {
    const field = SECTIONS.agent.fields.find((candidate) => candidate.key === 'toolTimeoutMs')!;
    expect(fieldBounds(SECTIONS.agent, field, readBase(SECTIONS.agent, viewOf())).max).toBeUndefined();
  });
});

describe('parsing what the user typed', () => {
  const int = SECTIONS.team.fields.find((candidate) => candidate.key === 'maxSubagents')!;
  const auto = SECTIONS.modelDefaults.fields.find((candidate) => candidate.key === 'contextWindow')!;

  it('rejects text where a whole number is needed', () => {
    expect(parseFieldInput(int, '4.5')).toEqual({ ok: false, error: 'integer' });
    expect(parseFieldInput(int, 'abc')).toEqual({ ok: false, error: 'integer' });
    expect(parseFieldInput(int, ' 4 ')).toEqual({ ok: true, value: 4 });
  });

  it('turns auto, empty and zero into null for an auto field', () => {
    for (const text of ['auto', 'AUTO', '', '0']) expect(parseFieldInput(auto, text)).toEqual({ ok: true, value: null });
    expect(parseFieldInput(auto, '200000')).toEqual({ ok: true, value: 200000 });
  });
});

describe('resolving a section draft', () => {
  it('sends only the changed keys, nested under the section', () => {
    const result = resolveSection(SECTIONS.team, viewOf(), { maxTurnsPerSubagent: '10' });
    expect(result.patch).toEqual({ team: { maxTurnsPerSubagent: 10 } });
    expect(result.adjusted).toEqual([]);
    expect(result.modified).toBe(true);
  });

  it('also sends a field the engine lowers because of the edit (concurrency follows the cap)', () => {
    const result = resolveSection(SECTIONS.team, viewOf(), { maxSubagents: '4' });
    expect(result.patch).toEqual({ team: { maxSubagents: 4, maxConcurrent: 4 } });
    expect(result.adjusted).toEqual([{ key: 'maxConcurrent', typed: DEFAULT_CONFIG.team.maxConcurrent, saved: 4 }]);
  });

  it('shows the value the file will hold when the engine clamps the input', () => {
    const result = resolveSection(SECTIONS.team, viewOf(), { maxSubagents: '9999' });
    expect(result.patch).toEqual({ team: { maxSubagents: HARD_MAX_SUBAGENTS } });
    expect(result.adjusted).toEqual([{ key: 'maxSubagents', typed: 9999, saved: HARD_MAX_SUBAGENTS }]);
  });

  it('carries a dependent value the clamp moved along with the edit', () => {
    const result = resolveSection(SECTIONS.compaction, viewOf(), { threshold: '0.6' });
    const expected = clampCompactionConfig({ ...DEFAULT_CONFIG.compaction, threshold: 0.6 });
    expect(expected.warnThreshold).toBeLessThan(DEFAULT_CONFIG.compaction.warnThreshold);
    expect(result.patch).toEqual({ compaction: { threshold: 0.6, warnThreshold: expected.warnThreshold } });
  });

  it('keeps the idle timeout above the tool timeout, as the engine does', () => {
    const result = resolveSection(SECTIONS.agent, viewOf(), { toolTimeoutMs: '600000' });
    expect(result.patch).toEqual({ toolTimeoutMs: 600000, idleTimeoutMs: 600000 + IDLE_TIMEOUT_MARGIN_MS });
  });

  it('writes top-level keys flat, without a section wrapper', () => {
    expect(resolveSection(SECTIONS.general, viewOf(), { theme: 'warm' }).patch).toEqual({ theme: 'warm' });
    expect(resolveSection(SECTIONS.agent, viewOf(), { confirmTools: true }).patch).toEqual({ confirmTools: true });
  });

  it('stores auto as null', () => {
    const view = viewOf({ contextWindow: 200000 });
    expect(resolveSection(SECTIONS.modelDefaults, view, { contextWindow: 'auto' }).patch).toEqual({ contextWindow: null });
  });

  it('refuses to build a patch from unparseable input and says which field', () => {
    const result = resolveSection(SECTIONS.team, viewOf(), { maxSubagents: 'many' });
    expect(result.errors).toEqual({ maxSubagents: 'integer' });
    expect(result.patch).toBeNull();
    expect(result.modified).toBe(true);
  });

  it('treats an edit that equals the stored value as no change', () => {
    const view = viewOf();
    expect(resolveSection(SECTIONS.team, view, { maxSubagents: String(DEFAULT_CONFIG.team.maxSubagents) }).patch).toBeNull();
    expect(pruneEdits(SECTIONS.team, view, { maxSubagents: String(DEFAULT_CONFIG.team.maxSubagents) })).toEqual({});
  });

  it('ignores edits to a field that is hidden', () => {
    const bound = viewOf({ modelProfiles: { version: 1, entries: [], mainId: null, fastId: 'p1', kits: [] } });
    expect(resolveSection(SECTIONS.fast, bound, { model: 'x' }).patch).toBeNull();
    expect(resolveSection(SECTIONS.fast, viewOf(), { model: 'x' }).patch).toEqual({ fast: { model: 'x' } });
  });
});
