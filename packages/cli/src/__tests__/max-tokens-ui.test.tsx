/**
 * The user-facing half of the output cap (§9 cases 31-35): the parser both write
 * paths share, the settings screen's effective-cap preview, and `/max-tokens`.
 *
 * The invariants here are the ones a manual smoke pass cannot see: a typo that
 * silently resolves to a default the user never chose, a preview that reports
 * the number typed rather than the number the model will accept, and a save that
 * discards a pasted API key because an unrelated field was unusable.
 */

import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import {
  MAX_TOKENS_RANGE,
  clampMaxTokens,
  isAutoToken,
  parseMaxTokensInput,
} from '../config/schema.js';
import { SettingsScreen, effectiveCapLine, readDirtySettings,
  type SettingsValues } from '../ui/overlays/SettingsScreen.js';
import { resolveSettingsMaxTokens } from '../ui/App.js';
import { registerBuiltinCommands } from '../commands/builtins.js';
import { CommandRegistry, runSlashInput, type CommandContext } from '../commands/registry.js';
import { getTheme } from '../ui/theme.js';
import type { TermCapabilities } from '../ui/capabilities.js';

const RICH: TermCapabilities = { colorLevel: 3, unicode: true };
const THEME = getTheme('warm', RICH);

// ---------------------------------------------------------------------------
// case 31 — the shared parser
// ---------------------------------------------------------------------------

describe('parseMaxTokensInput', () => {
  it('profile transactions persist only a dirty cap and reject invalid edited values', () => {
    const baseline = { maxTokens: '64000', provider: 'openai', model: 'session-override',
      apiKey: '', fastModel: '', fastProvider: '', fastReview: '5', fastReviewBudget: '40', compactionThreshold: '90',
      compactionKeepTurns: '3' } as SettingsValues;
    expect(readDirtySettings(baseline, { ...baseline })).toEqual({});
    expect(readDirtySettings(baseline, { ...baseline, maxTokens: 'auto' })).toEqual({ maxTokens: null });
    expect(() => readDirtySettings(baseline, { ...baseline, maxTokens: 'invalid' }))
      .toThrow('Max tokens');
  });

  it('case 31: maps auto / empty / 0 to AUTO, a number to a value, junk to invalid', () => {
    for (const raw of ['auto', 'AUTO', ' Auto ', '', '   ', '0']) {
      expect(parseMaxTokensInput(raw), raw).toEqual({ kind: 'auto' });
    }

    expect(parseMaxTokensInput('32000')).toEqual({ kind: 'value', value: 32_000, clamped: false });
    expect(parseMaxTokensInput(' 32000 ')).toEqual({ kind: 'value', value: 32_000, clamped: false });

    for (const raw of ['abc', '32k', '3.5', '-100', '1e5']) {
      expect(parseMaxTokensInput(raw), raw).toEqual({ kind: 'invalid' });
    }
  });

  it('reports a clamp rather than hiding it', () => {
    expect(parseMaxTokensInput('900000')).toEqual({
      kind: 'value',
      value: MAX_TOKENS_RANGE.max,
      clamped: true,
    });
    expect(parseMaxTokensInput('10')).toEqual({
      kind: 'value',
      value: MAX_TOKENS_RANGE.min,
      clamped: true,
    });
  });

  it('keeps AUTO distinguishable from a typo — clampMaxTokens cannot', () => {
    // Both come back `undefined` from the clamp, which is exactly why the parser
    // exists: treating a typo as AUTO discards the number the user meant.
    expect(clampMaxTokens('auto')).toBeUndefined();
    expect(clampMaxTokens('abc')).toBeUndefined();
    expect(isAutoToken('auto')).toBe(true);
    expect(isAutoToken('abc')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// case 32 — the settings-screen preview
// ---------------------------------------------------------------------------

describe('settings screen effective-cap preview', () => {
  it('case 32: shows the model ceiling, not the number in the field', () => {
    const line = effectiveCapLine({ provider: 'openai', model: 'gpt-4o', maxTokens: '64000' });

    expect(line).toContain('Effective: 16384');
    expect(line).toContain('clamped from 64000');
    expect(line).toContain('gpt-4o');
  });

  it('says nothing about clamping when the cap fits', () => {
    const line = effectiveCapLine({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5-20250929',
      maxTokens: '64000',
    });

    expect(line).toBe('Effective: 64000');
  });

  it('labels AUTO as such', () => {
    const line = effectiveCapLine({ provider: 'anthropic', model: 'my-llm-v3', maxTokens: 'auto' });

    expect(line).toBe('Effective: 64000  (auto)');
  });

  it('does not pretend an unusable field has an effective value', () => {
    const line = effectiveCapLine({ provider: 'openai', model: 'gpt-4o', maxTokens: 'abc' });

    expect(line).toContain('Effective: -');
  });

  it('renders the preview as a real row of the overlay', () => {
    const { lastFrame, unmount } = render(
      <SettingsScreen
        initial={{
          provider: 'openai',
          model: 'gpt-4o',
          baseUrl: '',
          thinkingLevel: 'off',
          showThinking: 'off',
          liveToolOutput: 'off',
          maxTokens: '64000',
          apiKey: '',
          logLevel: 'info',
          fastEnabled: 'off',
          fastModel: '',
          fastProvider: '(inherit)',
          fastReview: '5',
          fastReviewBudget: '40',
          compactionEnabled: 'off',
          compactionThreshold: '90',
          compactionKeepTurns: '4',
          compactionSubagents: 'on',
          compactionArchive: 'on',
        }}
        apiKeys={{}}
        maxRows={30}
        cols={120}
        scrollOffset={0}
        theme={THEME}
        caps={RICH}
        onSave={() => {}}
      />,
    );

    expect(stripAnsi(lastFrame() ?? '')).toContain('Effective: 16384');
    unmount();
  });

  /**
   * THE LABEL COLUMN IS A BUDGET, AND OVERRUNNING IT IS SILENT.
   *
   * Labels render `.padEnd(18)`, so a label of 18 or more neither wraps nor
   * truncates: it butts against or pushes its OWN value while every other row's
   * stays put. Nothing fails, nothing warns, and a screen whose entire design is
   * aligned rows quietly stops having a value column. The round-2 budget row
   * arrived as `Fast review budget (1-500)` (26) and was cut to a name matching
   * its command; this pins the rule so the next hint-in-a-label fails loudly.
   */
  it('renders every value in one column, whatever the labels are', () => {
    const { lastFrame, unmount } = render(
      <SettingsScreen
        initial={{
          provider: 'openai',
          model: 'gpt-4o',
          baseUrl: '',
          thinkingLevel: 'off',
          showThinking: 'off',
          liveToolOutput: 'off',
          maxTokens: '64000',
          apiKey: '',
          logLevel: 'info',
          fastEnabled: 'off',
          fastModel: '',
          fastProvider: '(inherit)',
          fastReview: '5',
          fastReviewBudget: '40',
          compactionEnabled: 'off',
          compactionThreshold: '90',
          compactionKeepTurns: '4',
          compactionSubagents: 'on',
          compactionArchive: 'on',
        }}
        apiKeys={{}}
        maxRows={30}
        cols={120}
        scrollOffset={0}
        theme={THEME}
        caps={RICH}
        onSave={() => {}}
      />,
    );

    const lines = stripAnsi(lastFrame() ?? '').split('\n');
    const valueColumn = (label: string, value: string): number => {
      const line = lines.find((l) => l.includes(label));
      expect(line, label).toBeDefined();
      const at = line!.indexOf(value, line!.indexOf(label) + label.length);
      expect(at, `${label} -> ${value}`).toBeGreaterThan(0);
      return at;
    };

    const reference = valueColumn('Max tokens', '64000');
    expect(valueColumn('Fast budget', '40')).toBe(reference);
    expect(valueColumn('Fast review', '5')).toBe(reference);
    expect(valueColumn('Thinking', 'off')).toBe(reference);
    unmount();
  });
});

// ---------------------------------------------------------------------------
// The save path — one bad field must not discard the rest of the form
// ---------------------------------------------------------------------------

describe('resolveSettingsMaxTokens', () => {
  it('turns auto into a persisted null', () => {
    const r = resolveSettingsMaxTokens('auto', 64_000);

    expect(r.applied).toBeUndefined();
    expect(r.persist).toBeNull();
    expect(r.toast?.[0]).toBe('info');
  });

  it('warns when it had to clamp, naming the STORED value', () => {
    const r = resolveSettingsMaxTokens('900000', 64_000);

    expect(r.applied).toBe(200_000);
    expect(r.persist).toBe(200_000);
    expect(r.toast).toEqual(['warn', 'Max tokens clamped to 200000.']);
  });

  it('keeps the previous value and persists NOTHING when the field is unusable', () => {
    const r = resolveSettingsMaxTokens('abc', 8_000);

    expect(r.applied).toBe(8_000);
    expect(r.persist).toBe('skip');
    expect(r.toast).toEqual(['warn', 'Max tokens must be a number or "auto".']);
  });

  it('is silent on the ordinary path so "Settings saved." still shows', () => {
    const r = resolveSettingsMaxTokens('32000', 64_000);

    expect(r).toEqual({ applied: 32_000, persist: 32_000 });
  });
});

// ---------------------------------------------------------------------------
// cases 33-35 — the slash command
// ---------------------------------------------------------------------------

interface CommandHarness {
  ctx: (args: string) => CommandContext;
  setMaxTokens: ReturnType<typeof vi.fn>;
  persistConfig: ReturnType<typeof vi.fn>;
  toasts: string[];
  notices: Array<[string, string]>;
}

// NO DEFAULT PARAMETER: `makeHarness(undefined)` would silently fall back to
// it, and AUTO is exactly the case these tests need to reach.
function makeHarness(maxTokens: number | undefined): CommandHarness {
  const setMaxTokens = vi.fn();
  const persistConfig = vi.fn();
  const toasts: string[] = [];
  const notices: Array<[string, string]> = [];
  const controller = {
    setMaxTokens,
    getConfig: () => ({ provider: 'openai', model: 'gpt-4o', maxTokens }),
  } as unknown as CommandContext['controller'];

  return {
    setMaxTokens,
    persistConfig,
    toasts,
    notices,
    ctx: (args: string) =>
      ({
        args,
        controller,
        persistConfig,
        notify: (level: string, text: string) => notices.push([level, text]),
        toast: (_level: string, text: string) => toasts.push(text),
      }) as unknown as CommandContext,
  };
}

const registry = new CommandRegistry();
registerBuiltinCommands(registry);

describe('/max-tokens', () => {
  it('case 33: sets and persists an explicit number', async () => {
    const h = makeHarness(64_000);

    await runSlashInput(registry, '/max-tokens 32000', h.ctx);

    expect(h.setMaxTokens).toHaveBeenCalledWith(32_000);
    expect(h.persistConfig).toHaveBeenCalledWith({ maxTokens: 32_000 });
    expect(h.toasts[0]).toContain('32000');
  });

  it('case 34: auto persists null', async () => {
    const h = makeHarness(64_000);

    await runSlashInput(registry, '/max-tokens auto', h.ctx);

    expect(h.setMaxTokens).toHaveBeenCalledWith(undefined);
    expect(h.persistConfig).toHaveBeenCalledWith({ maxTokens: null });
  });

  it('case 35: garbage warns and changes NOTHING', async () => {
    const h = makeHarness(64_000);

    await runSlashInput(registry, '/max-tokens abc', h.ctx);

    expect(h.setMaxTokens).not.toHaveBeenCalled();
    expect(h.persistConfig).not.toHaveBeenCalled();
    expect(h.notices[0]?.[0]).toBe('warn');
  });

  it('"default" restores the product default', async () => {
    const h = makeHarness(undefined);

    await runSlashInput(registry, '/max-tokens default', h.ctx);

    expect(h.setMaxTokens).toHaveBeenCalledWith(64_000);
    expect(h.persistConfig).toHaveBeenCalledWith({ maxTokens: 64_000 });
  });

  it('reports the EFFECTIVE cap with no argument, not just the setting', async () => {
    // "I set 64000" and "this model will produce 16384" are different facts, and
    // only the second one explains a truncated answer.
    const h = makeHarness(64_000);

    await runSlashInput(registry, '/max-tokens', h.ctx);

    expect(h.setMaxTokens).not.toHaveBeenCalled();
    expect(h.notices[0]?.[1]).toContain('Max tokens: 64000');
    expect(h.notices[0]?.[1]).toContain('16384');
  });

  it('reports AUTO by name rather than as a blank', async () => {
    const h = makeHarness(undefined);

    await runSlashInput(registry, '/max-tokens', h.ctx);

    expect(h.notices[0]?.[1]).toContain('Max tokens: auto');
  });
});
