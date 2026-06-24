/**
 * Public API contract snapshot (D3).
 *
 * Freezes the set of RUNTIME (value) exports of the package barrel so that any
 * accidental add / remove / rename of a public symbol breaks this test loudly,
 * protecting downstream reuse consumers from silent API drift.
 *
 * `Object.keys()` only sees runtime VALUE exports — `export type` declarations
 * are erased at compile time and are intentionally out of scope here (they are
 * documented for humans in `API.md` instead).
 *
 * THREE-SYNC DISCIPLINE: whenever a public export changes, update all three in
 * the same change:
 *   1. `src/index.ts`        (the barrel — source of truth),
 *   2. this `EXPECTED` list,
 *   3. `API.md` + `CHANGELOG.md`.
 */

import { describe, it, expect } from 'vitest';
import * as api from '../index.js';

// All runtime (value) exports of `src/index.ts`, enumerated by category. Order
// here is irrelevant — both sides are `.sort()`-ed before comparison.
const EXPECTED = [
  // llm/types
  'THINKING_BUDGET',
  // llm/provider
  'LLMError',
  'classifyHttpError',
  'wrapFetchError',
  // llm/stream-utils
  'parseSSEStream',
  'consumeStream',
  // llm/providers
  'ProviderRegistry',
  'initProviders',
  'getProviderRegistry',
  'setProviderRegistry',
  'streamLLM',
  'completeLLM',
  // individual providers
  'AnthropicProvider',
  'OpenAIProvider',
  'GoogleProvider',
  // model registry
  'ModelRegistry',
  'getModelRegistry',
  'setModelRegistry',
  // tools/helpers
  'textResult',
  'errorResult',
  'imageResult',
  'multiResult',
  'defineTool',
  // tools/registry
  'ToolRegistry',
  // tools/validator
  'ToolParamValidator',
  'ToolValidationError',
  'formatValidationErrors',
  // tools/executor
  'ToolExecutor',
  // engine
  'Agent',
  'MessageManager',
  'MessageQueueManager',
  'IdleWatchdog',
  // brand alias
  'ArgonAgent',
];

describe('@argon-agent/core public API contract', () => {
  it('runtime export surface is frozen (keep API.md in sync)', () => {
    expect(Object.keys(api).sort()).toEqual([...EXPECTED].sort());
  });

  it('expects exactly 33 runtime exports with no duplicates', () => {
    expect(EXPECTED.length).toBe(33);
    expect(new Set(EXPECTED).size).toBe(EXPECTED.length);
  });
});
