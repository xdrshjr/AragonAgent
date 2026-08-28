/**
 * The output-token authority (§9 cases 1-12).
 *
 * These are the invariants whose failures are an HTTP 400 in the middle of an
 * agent run: a cap the model cannot accept, a thinking budget the cap cannot
 * house, a "helpful" pessimistic default that silently halves every proxy user's
 * output. None of them is visible in a diff.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { Message } from '../llm/types.js';
import {
  ABSOLUTE_MAX_OUTPUT_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  MIN_MAX_OUTPUT_TOKENS,
  clearLearnedCeilings,
  estimatePromptTokens,
  getLearnedCeiling,
  learnModelCeiling,
  resolveOutputTokens,
  staticCeilingFor,
} from '../llm/output-limits.js';

// The learned map has PROCESS lifetime. Without this, a ceiling learned here
// leaks into the next test file and fails it for a reason not in that file.
afterEach(() => {
  clearLearnedCeilings();
});

describe('resolveOutputTokens - the product default', () => {
  it('case 1: AUTO against an unknown model is exactly the product default', () => {
    const r = resolveOutputTokens({ providerId: 'anthropic', modelId: 'my-llm-v3' });

    expect(r.value).toBe(64_000);
    expect(r.value).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
    expect(r.source).toBe('auto');
    expect(r.clampedBy).toBeUndefined();
    expect(r.ceiling).toBeUndefined();
  });

  it('case 2: AUTO against gpt-4o clamps to the model ceiling', () => {
    const r = resolveOutputTokens({ providerId: 'openai', modelId: 'gpt-4o' });

    expect(r.value).toBe(16_384);
    expect(r.clampedBy).toBe('ceiling');
    expect(r.ceiling).toBe(16_384);
  });

  it('case 3: AUTO never exceeds the product default, even on a bigger model', () => {
    // o1's table ceiling is 100000. AUTO means "generous and safe", not "as much
    // as physically possible" — on OpenAI the cap is charged against the context
    // window, so an AUTO of 100000 makes long conversations fail.
    const r = resolveOutputTokens({ providerId: 'openai', modelId: 'o1' });

    expect(r.value).toBe(64_000);
    expect(r.source).toBe('auto');
    expect(r.clampedBy).toBeUndefined();
  });

  it('case 4: an explicit value may exceed the default, up to the ceiling', () => {
    const r = resolveOutputTokens({ providerId: 'openai', modelId: 'o1', requested: 100_000 });

    expect(r.value).toBe(100_000);
    expect(r.source).toBe('requested');
  });
});

describe('resolveOutputTokens - hard bounds', () => {
  it('case 5: an absurd explicit value is clamped to the absolute maximum', () => {
    const r = resolveOutputTokens({
      providerId: 'anthropic',
      modelId: 'unknown-huge',
      requested: 900_000,
    });

    expect(r.value).toBe(ABSOLUTE_MAX_OUTPUT_TOKENS);
    expect(r.value).toBe(200_000);
    expect(r.clampedBy).toBe('absolute');
  });

  it('case 6: a tiny explicit value is raised to the floor', () => {
    const r = resolveOutputTokens({
      providerId: 'anthropic',
      modelId: 'unknown-tiny',
      requested: 10,
    });

    expect(r.value).toBe(MIN_MAX_OUTPUT_TOKENS);
    expect(r.value).toBe(256);
  });

  it('never returns NaN, zero or a negative for hostile input', () => {
    for (const requested of [Number.NaN, 0, -5, Number.POSITIVE_INFINITY]) {
      const r = resolveOutputTokens({ providerId: 'openai', modelId: 'gpt-4o', requested });
      expect(Number.isFinite(r.value)).toBe(true);
      expect(r.value).toBeGreaterThanOrEqual(MIN_MAX_OUTPUT_TOKENS);
    }
  });
});

describe('resolveOutputTokens - the thinking invariant', () => {
  it('case 7: an xhigh budget under a 64000 ceiling lowers the budget, not the cap', () => {
    // The guaranteed-400 regression: Anthropic requires max_tokens >
    // budget_tokens, and `--thinking xhigh` is 65536 against a 64000 default.
    const r = resolveOutputTokens({
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-5-20250929',
      thinkingBudget: 65_536,
    });

    expect(r.value).toBe(64_000);
    expect(r.thinkingBudget).toBe(59_904);
    expect(r.value).toBeGreaterThan(r.thinkingBudget!);
  });

  it('case 8: a budget that already fits leaves both untouched', () => {
    const r = resolveOutputTokens({
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-5-20250929',
      thinkingBudget: 32_768,
    });

    expect(r.value).toBe(64_000);
    // Absent means "no adjustment"; the adapter falls back to what it asked for.
    expect(r.thinkingBudget).toBeUndefined();
  });

  it('case 9: a small ceiling lowers the budget and never goes negative', () => {
    learnModelCeiling('anthropic', 'small-ceiling', 8_192, 'error');

    const r = resolveOutputTokens({
      providerId: 'anthropic',
      modelId: 'small-ceiling',
      thinkingBudget: 65_536,
    });

    expect(r.value).toBe(8_192);
    // 8192 - 4096 = 4096, which is above Anthropic's 1024 floor and strictly
    // below the cap, so thinking is DOWNGRADED rather than switched off. (The
    // design's §9 case 9 predicted `0` here; see the spec's issues section.)
    expect(r.thinkingBudget).toBe(4_096);
    expect(r.thinkingBudget).toBeGreaterThan(0);
    expect(r.value).toBeGreaterThan(r.thinkingBudget!);
  });

  it('case 9b: a ceiling that cannot house the 1024 floor omits the block', () => {
    learnModelCeiling('anthropic', 'micro-ceiling', 1_024, 'error');

    const r = resolveOutputTokens({
      providerId: 'anthropic',
      modelId: 'micro-ceiling',
      thinkingBudget: 65_536,
    });

    // `0` is the adapter's signal to drop the `thinking` key entirely: sending
    // budget_tokens < 1024 is illegal and would be a 400 of its own.
    expect(r.thinkingBudget).toBe(0);
    expect(r.value).toBeGreaterThan(0);
  });
});

describe('learned ceilings', () => {
  it('case 10: error outranks discovery, and catalog never overwrites error', () => {
    learnModelCeiling('openai', 'proxy-model', 32_000, 'discovery');
    learnModelCeiling('openai', 'proxy-model', 8_000, 'error');
    expect(getLearnedCeiling('openai', 'proxy-model')).toEqual({ ceiling: 8_000, source: 'error' });

    learnModelCeiling('openai', 'proxy-model', 64_000, 'catalog');
    expect(getLearnedCeiling('openai', 'proxy-model')).toEqual({ ceiling: 8_000, source: 'error' });

    learnModelCeiling('openai', 'proxy-model', 12_000, 'discovery');
    expect(getLearnedCeiling('openai', 'proxy-model')).toEqual({ ceiling: 8_000, source: 'error' });
  });

  it('a higher-ranked source does replace a lower-ranked one', () => {
    learnModelCeiling('openai', 'ranked', 4_000, 'catalog');
    learnModelCeiling('openai', 'ranked', 16_000, 'discovery');

    expect(getLearnedCeiling('openai', 'ranked')).toEqual({ ceiling: 16_000, source: 'discovery' });
  });

  it('outranks the static table in the resolver', () => {
    expect(resolveOutputTokens({ providerId: 'openai', modelId: 'gpt-4o' }).value).toBe(16_384);

    learnModelCeiling('openai', 'gpt-4o', 4_096, 'error');

    expect(resolveOutputTokens({ providerId: 'openai', modelId: 'gpt-4o' }).value).toBe(4_096);
  });

  it('clearLearnedCeilings really empties the map', () => {
    learnModelCeiling('openai', 'gpt-4o', 4_096, 'error');
    clearLearnedCeilings();

    expect(getLearnedCeiling('openai', 'gpt-4o')).toBeUndefined();
  });
});

describe('staticCeilingFor', () => {
  it('case 11: normalizes the models/ prefix Google returns', () => {
    expect(staticCeilingFor('google', 'models/gemini-1.5-pro')).toBe(8_192);
    expect(staticCeilingFor('google', 'gemini-1.5-pro')).toBe(8_192);
    expect(staticCeilingFor('google', 'MODELS/Gemini-1.5-Flash')).toBe(8_192);
  });

  it('case 12: an unrecognised id is undefined, NOT a pessimistic number', () => {
    // Unknown must stay distinguishable from small: baking 8192 in here would
    // silently halve the output of every proxy user.
    expect(staticCeilingFor('openai', 'my-llm-v3')).toBeUndefined();
    expect(staticCeilingFor('anthropic', 'claude-test')).toBeUndefined();
    expect(staticCeilingFor('openai', 'gpt-4-test')).toBeUndefined();
    expect(staticCeilingFor('nonesuch', 'gpt-4o')).toBeUndefined();
    expect(staticCeilingFor('openai', '')).toBeUndefined();
  });

  it('orders the Anthropic rules so the specific 3.7 entry is reachable', () => {
    // `claude-3-7-sonnet` also matches the broad `^claude-3(-|.)` rule. If the
    // broad rule came first the 3.7 entry would be dead code and every 3.7
    // request would be clamped to 8192.
    expect(staticCeilingFor('anthropic', 'claude-3-7-sonnet-20250219')).toBe(64_000);
    expect(staticCeilingFor('anthropic', 'claude-3-5-sonnet-20241022')).toBe(8_192);
    expect(staticCeilingFor('anthropic', 'claude-3-5-haiku-20241022')).toBe(8_192);
    expect(staticCeilingFor('anthropic', 'claude-3-opus-20240229')).toBe(8_192);
  });

  it('separates the OpenAI reasoning families', () => {
    expect(staticCeilingFor('openai', 'o1-mini')).toBe(65_536);
    expect(staticCeilingFor('openai', 'o1')).toBe(100_000);
    expect(staticCeilingFor('openai', 'o3')).toBe(100_000);
    expect(staticCeilingFor('openai', 'gpt-5')).toBe(128_000);
    expect(staticCeilingFor('openai', 'gpt-4o-mini')).toBe(16_384);
    expect(staticCeilingFor('openai', 'gpt-4')).toBe(4_096);
  });
});

describe('modelLimits and the context guard', () => {
  it('takes a caller-declared ceiling over the static table', () => {
    const r = resolveOutputTokens({
      providerId: 'openai',
      modelId: 'gpt-4o',
      modelLimits: { maxOutputTokens: 4_096 },
    });

    expect(r.value).toBe(4_096);
  });

  it('keeps max_tokens + prompt under the context window on OpenAI', () => {
    const r = resolveOutputTokens({
      providerId: 'openai',
      modelId: 'gpt-4o',
      modelLimits: { maxOutputTokens: 16_384, contextWindow: 128_000 },
      estimatedPromptTokens: 120_000,
    });

    // 128000 - 120000 - 1024 = 6976
    expect(r.value).toBe(6_976);
    expect(r.clampedBy).toBe('context');
  });

  it('does NOT apply the context guard to Anthropic or Google', () => {
    for (const providerId of ['anthropic', 'google']) {
      const r = resolveOutputTokens({
        providerId,
        modelId: 'whatever',
        modelLimits: { contextWindow: 128_000 },
        estimatedPromptTokens: 127_000,
      });
      expect(r.value).toBe(64_000);
      expect(r.clampedBy).toBeUndefined();
    }
  });
});

describe('estimatePromptTokens', () => {
  const messages: Message[] = [
    { role: 'user', content: 'a'.repeat(400), timestamp: 1 },
    { role: 'assistant', content: [{ type: 'text', text: 'b'.repeat(400) }] },
  ];

  it('is roughly four characters per token plus per-message framing', () => {
    const estimate = estimatePromptTokens(messages);

    expect(estimate).toBeGreaterThan(180);
    expect(estimate).toBeLessThan(230);
  });

  it('counts the system prompt and never throws on an empty conversation', () => {
    expect(estimatePromptTokens([], 'x'.repeat(40))).toBe(10);
    expect(estimatePromptTokens([])).toBe(0);
  });
});
