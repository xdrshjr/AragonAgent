/**
 * @argon-agent/core — consumer-smoke (D1 + D2).
 *
 * Proves the BUILT ARTIFACT (`dist/`) can be run by an external consumer the way
 * `npm install @argon-agent/core` would resolve it — without ever placing the
 * package in `node_modules`.
 *
 * Mechanism: Node "package self-referencing". Code inside a package may import
 * the package by its own `name`; Node resolves that through the package's
 * `exports` map. So `import('@argon-agent/core')` from this file resolves to
 * `exports["."]` → `./dist/index.js`, exercising the same
 * (exports map + NodeNext + `.js` extension + end-to-end run) main link an
 * external consumer hits after `npm install`.
 *
 * RV-3 boundary: this equivalence does NOT cover the "optional dependency
 * missing" branch — when `verify:dist` runs INSIDE the package, `ajv` /
 * `isolated-vm` are present as `devDependencies`, and this smoke deliberately
 * avoids exercising either (the stub tool is only registered, never executed —
 * `done` carries no `tool_call` — so `validator.ts`'s `await import('ajv')` is
 * never reached; `sandbox/*` is never imported, so `isolated-vm` is never
 * loaded). The "missing optional dep" case is covered by the pack-into-a-fresh-
 * project golden check documented in this directory's README.
 *
 * Runs offline: a stub `LLMProvider` yields a fixed `StreamEvent` sequence; no
 * network is ever touched.
 *
 * Exit code 0 = reuse verified (stdout contains `[consumer-smoke] OK`).
 * Any assert failure throws → non-zero exit.
 */

import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// D1 — resolve the package BY NAME (self-reference → exports["."] → dist/).
// If `dist/` is missing or any `.js` extension is wrong, this import alone
// throws ERR_MODULE_NOT_FOUND before anything else runs (AC2 resolution layer).
// ---------------------------------------------------------------------------

import {
  ArgonAgent,
  Agent,
  defineTool,
  textResult,
  ProviderRegistry,
  getProviderRegistry,
  setProviderRegistry,
  initProviders,
  THINKING_BUDGET,
} from '@argon-agent/core';

// Hard timeout guard (R2): if the agent loop fails to converge, fail fast with a
// non-zero exit instead of hanging the scheduler / CI.
const HARD_TIMEOUT_MS = 30_000;
const timeoutHandle = setTimeout(() => {
  console.error('[consumer-smoke] FAILED: timed out after 30s (agent loop did not converge)');
  process.exit(1);
}, HARD_TIMEOUT_MS);
// Do not let the guard itself keep the event loop alive.
timeoutHandle.unref?.();

async function main() {
  // -------------------------------------------------------------------------
  // Stub LLM provider — implements the public `LLMProvider` interface.
  // Field shapes verified against src/llm/types.ts (RV-2):
  //   - TextDeltaEvent uses `delta` (NOT `text`).
  //   - DoneEvent = { type:'done', message: AssistantMessage, usage: TokenUsage }
  //     — there is NO top-level `stopReason`; `stopReason` lives on `message`.
  // -------------------------------------------------------------------------
  const stubText = 'hello from stub';
  const stubProvider = {
    id: 'anthropic', // matches model.providerId below; reuse a built-in id so we
                     // need not touch ModelRef shape.
    displayName: 'Stub',
    defaultBaseUrl: 'http://stub.local',
    // LLMProvider.stream(request) → AsyncIterableIterator<StreamEvent>; the stub
    // ignores the request entirely.
    async *stream() {
      yield { type: 'text_delta', delta: stubText };
      yield {
        type: 'done',
        message: {
          role: 'assistant',
          // No tool_call block and no ```execute-js``` block → the loop converges
          // in a single turn (agent-loop.ts:344-358).
          content: [{ type: 'text', text: stubText }],
          stopReason: 'end_turn',
        },
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
    async complete() {
      return {
        role: 'assistant',
        content: [{ type: 'text', text: stubText }],
        stopReason: 'end_turn',
      };
    },
    async listModels() {
      return [];
    },
  };

  // -------------------------------------------------------------------------
  // Inject the stub through the public DI seam.
  // ProviderRegistry.register keys by provider.id (llm/providers/index.ts:22),
  // so the stub lands under 'anthropic', aligned with model.providerId below.
  // -------------------------------------------------------------------------
  const registry = new ProviderRegistry();
  registry.register(stubProvider);
  // RV-6: setProviderRegistry is NOT required for the run — ArgonAgent uses
  // `config.providerRegistry` (passed below), not the global singleton. This call
  // exists only to verify the `setProviderRegistry` export is runtime-resolvable.
  setProviderRegistry(registry);

  // -------------------------------------------------------------------------
  // Construct + run the agent end-to-end (one turn, zero network).
  // -------------------------------------------------------------------------
  const echo = defineTool({
    name: 'echo',
    label: 'Echo',
    description: 'echo',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    async execute(_id, p) {
      return textResult(String(p.text));
    },
  });

  const agent = new ArgonAgent({
    systemPrompt: 'You are a test agent.',
    model: { providerId: 'anthropic', modelId: 'stub-model' },
    tools: [echo],
    providerRegistry: registry,
    getApiKey: () => 'stub-key',
  });

  const seen = [];
  const unsub = agent.subscribe((e) => seen.push(e.type));
  await agent.prompt('hi'); // hits the stub provider; zero network
  unsub();

  // -------------------------------------------------------------------------
  // Assertions (RV-1: MUST include success-only signals — `agent_start` /
  // `agent_end` alone are necessary-but-insufficient because
  // runLoopWithLifecycle swallows loop errors and ALWAYS emits `agent_end` in
  // its finally block, see agent.ts:374-391 and §4.1.1 of the spec).
  // -------------------------------------------------------------------------
  assert.equal(ArgonAgent, Agent, 'ArgonAgent must alias Agent');
  assert.ok(agent.state.tools.some((t) => t.name === 'echo'), 'echo tool registered');
  assert.ok(THINKING_BUDGET !== undefined, 'THINKING_BUDGET runtime export present');
  assert.equal(typeof initProviders, 'function', 'initProviders runtime export present');
  assert.equal(typeof getProviderRegistry, 'function', 'getProviderRegistry runtime export present');

  // Lifecycle — necessary but NOT sufficient (see §4.1.1).
  assert.ok(seen.includes('agent_start') && seen.includes('agent_end'), 'lifecycle fired');

  // Success-only signal A: `turn_end` fires only after a valid `done.message`
  // (agent-loop.ts:188), and earlier than any throw point — its presence proves
  // the turn actually completed successfully.
  assert.ok(seen.includes('turn_end'), 'a turn must have completed successfully');

  // Success-only signal B: `done.message` was consumed and pushed into history
  // (agent-loop.ts:189). Assert the assistant message carrying the stub text
  // made it end-to-end.
  const msgs = agent.state.messages;
  const assistant = msgs.find((m) => m.role === 'assistant');
  assert.ok(assistant, 'assistant message must be present after a successful round');
  const text = (assistant.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  assert.ok(text.includes('hello from stub'), 'assistant carried the stub output end-to-end');

  // -------------------------------------------------------------------------
  // D2 — `exports` subpath runtime resolution. Each subpath in
  // package.json#exports (other than ".") must dynamically import and expose its
  // key symbols. Deleting/renaming any `exports` key breaks these imports (AC3).
  // -------------------------------------------------------------------------
  const llmTypes = await import('@argon-agent/core/llm/types');
  // RV-5: llm/types is NOT a pure type module — it exports the runtime constant
  // THINKING_BUDGET (types.ts:99), so its compiled `.js` is non-empty.
  assert.equal(typeof llmTypes.THINKING_BUDGET, 'object', 'llm/types exposes THINKING_BUDGET at runtime');

  const helpers = await import('@argon-agent/core/tools/helpers');
  assert.equal(typeof helpers.textResult, 'function', 'tools/helpers.textResult resolves');
  assert.equal(typeof helpers.defineTool, 'function', 'tools/helpers.defineTool resolves');

  const providers = await import('@argon-agent/core/llm/providers');
  assert.equal(typeof providers.initProviders, 'function', 'llm/providers.initProviders resolves');
  assert.equal(typeof providers.ProviderRegistry, 'function', 'llm/providers.ProviderRegistry resolves');

  // tools/types is (near) pure `export type` — its compiled `.js` may be empty.
  // The contract here is just "import() does not throw" → resolution succeeds.
  await import('@argon-agent/core/tools/types');

  // sandbox/* is on-demand + backed by optional `isolated-vm`; per R3 we do NOT
  // statically import it. The barrel must not pull it in — that invariant is
  // guarded by the public-api / no-host-coupling tests, not here.

  console.log('[consumer-smoke] OK');
}

main()
  .then(() => {
    clearTimeout(timeoutHandle);
    process.exit(0);
  })
  .catch((err) => {
    clearTimeout(timeoutHandle);
    console.error('[consumer-smoke] FAILED:', err);
    process.exit(1);
  });
