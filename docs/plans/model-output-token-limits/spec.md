# Model Output Token Limits — Implementation Specification

> **Document version:** v1
>
> **For the downstream engineer:** use `superpowers:test-driven-development` while implementing this specification, and run `superpowers:verification-before-completion` before handing it off. Every acceptance criterion in §9 is written so it can be turned into a Vitest case before the production line that satisfies it exists.

**Goal:** Give every model and every provider a sane, generous, *configurable* output-token cap that defaults to **64000**, is editable from the TUI, is editable from `~/.aragon-agent/config.json` (on this machine `C:\Users\jdqqj\.aragon-agent\config.json`), and — the part that actually matters — can never itself become the reason an agent run fails.

**Architecture:** One authority module in `@aragon-agent/core` (`llm/output-limits.ts`) owns the number, the per-model ceilings and the resolution algorithm. A second core module (`llm/output-limit-recovery.ts`) owns a one-shot self-healing retry that repairs a request the provider rejected because of the cap, and teaches the authority module what it learned. The three provider adapters stop carrying private copies of the constant and call the authority instead. The CLI package keeps ownership of *user intent* only: config file, env var, flag, settings screen, and a new `/max-tokens` slash command.

**Tech stack:** Node.js 18+, TypeScript/ESM, npm workspaces (`packages/core`, `packages/cli`), React + Ink for the TUI, Commander for argv, Vitest for tests.

---

## 1. Overview

The requirement is short: *all models and providers should default to 64000 max output tokens, the user must be able to change that from the TUI and from the config file, and the agent must stop failing because of output-token limits.* Commit `b98e37d3` ("fix: default max output tokens to 64000") already took the first, most literal step — it set `DEFAULT_CONFIG.maxTokens = 64_000` and replaced three provider constants (`16384`, `16384`, and an absent Google default) with `64_000`. That commit is a necessary down payment, but on its own it makes the *third* clause of the requirement measurably worse, and this specification exists mostly to explain why and to finish the job.

Sending `max_tokens: 64000` unconditionally is only safe for models whose ceiling is at least 64000. Today the CLI's own builtin catalog lists nine models, and **six of them cannot accept 64000**: `gpt-4o` and `gpt-4o-mini` cap at 16384, `gemini-1.5-pro` and `gemini-1.5-flash` at 8192, `claude-sonnet-4-5` is fine at 64000 but `claude-haiku-4-5` and every Claude 3.x model cap at 8192, and `claude-opus-4-6` is listed at 32000. Anthropic, OpenAI and Google all answer an over-large cap with an HTTP 400, and in this codebase an HTTP 400 during `runAgentLoop` is thrown, caught by `Agent.runLoopWithLifecycle`'s `catch`, printed as `console.error('[Agent] loop error:', err)` and bridged into the transcript as a red notice — the turn is over, the user sees a raw provider string, and nothing retries. There are two further guaranteed-400 combinations that ship today: `--thinking xhigh` sets `budget_tokens: 65536`, and Anthropic requires `max_tokens > budget_tokens`, so *every request* under `xhigh` + the new 64000 default is rejected; and OpenAI's reasoning family (`o1`, `o3`, `gpt-5`) rejects the `max_tokens` parameter outright in favour of `max_completion_tokens` — which used to work by accident, because before `b98e37d3` the field was only sent when the user had explicitly configured it.

So the design here is not "raise a number". It is: make **64000 the ambition, and the model's real ceiling the law**, with the gap between the two closed automatically and invisibly rather than by a failed run. Concretely — a single resolver clamps the configured value down to whatever the target model actually accepts; a static ceiling table plus runtime discovery plus a *learned* cache supply that ceiling; a one-shot recovery pass repairs the request when the provider disagrees with all three, parses the true ceiling out of the provider's own error text, and remembers it for the rest of the process; and the user-facing layers (config file, env, flag, settings screen, slash command) gain an explicit `auto` value plus honest feedback about what the effective cap turned out to be. The result satisfies the requirement's literal text — untouched config means 64000 — while making the failure mode it was written to eliminate genuinely unreachable.

---

## 2. Current-state audit

Everything below is present in the tree at the time of writing and is the input to this design.

| Fact | Location | Consequence |
| --- | --- | --- |
| `DEFAULT_MAX_TOKENS = 64_000` declared privately three times | `core/src/llm/providers/anthropic.ts:41`, `openai.ts:37`, `google.ts:34` | Four copies of the product default (with `schema.ts:590`); no single source of truth. |
| `max_tokens` / `maxOutputTokens` now sent unconditionally | `anthropic.ts:337`, `openai.ts:308`, `google.ts:249` | Every request carries the cap, including to models that cannot accept it. |
| Builtin catalog ceilings are stale/conservative | `core/src/llm/model-registry.ts:153-298` | 8192/16384/32000/65536/100000 values are never consulted when building a request. |
| `buildRuntimeModel` still returns `maxOutputTokens: 16_384` | `model-registry.ts:122` | Unknown models claim a ceiling nothing else agrees with. |
| Anthropic `listModels` hardcodes `maxOutputTokens: DEFAULT_MAX_TOKENS` | `anthropic.ts:316` | Discovery *asserts* 64000 for `claude-3-5-haiku` (real ceiling 8192). |
| `THINKING_BUDGET.xhigh = 65536`, no interaction with `max_tokens` | `core/src/llm/types.ts:99-106`, `anthropic.ts:356-367` | `--thinking xhigh` is a guaranteed 400 under the new default. |
| OpenAI always writes `body.max_tokens` | `openai.ts:308` | `o1`/`o3`/`gpt-5` reject the parameter name. |
| A provider 400 ends the run | `agent-loop.ts:170-178` → `agent.ts:408` | No retry, no downshift, raw error text in the transcript. |
| Config key already exists and is already layered | `schema.ts:534/590`, `load.ts:258-260`, `env.ts:79-82`, `cli.tsx:571-573` | The plumbing for "user can change it" is 80 % there; what is missing is `auto`, validation, and feedback. |
| TUI already has a `Max tokens` text field | `ui/overlays/SettingsScreen.tsx:64`, `ui/App.tsx:621-641,910` | Editable, but unvalidated, with no indication of the effective cap. |
| `pick()` skips `null` | `load.ts:213-218` | A user who writes `"maxTokens": null` gets 64000 back and has **no way to express "auto"**. |

---

## 3. Approaches considered

### 3.1 Static clamp only — rejected as insufficient

Ship an accurate per-model ceiling table and clamp against it. Cheap and covers the nine catalog models, but the CLI supports arbitrary `--model` strings, arbitrary `--base-url` proxies (LiteLLM, OpenRouter, Ollama, Azure), and new model IDs that ship weekly. A table alone is stale the day after it lands, and its failure mode is the exact 400 this work exists to remove.

### 3.2 Runtime recovery only — rejected as insufficient

Send 64000 always and repair on 400. This does work, but it pays a full failed round trip on the *first* request of every session against a small model, and for streaming requests the round trip is the expensive one. It also produces a warning in the transcript for a condition we could have known statically.

### 3.3 Static table + discovery + learned ceilings + one-shot recovery — **selected**

Four sources, ranked, feeding one resolver:

```
learned-from-error  >  discovery (API-reported)  >  static table  >  product default (64000)
```

The static table makes the common case correct without a round trip. Discovery (`ModelRegistry.discoverModels`) makes it correct for Google, which is the only one of the three that reports real per-model limits. The learned cache makes it correct for everything else after exactly one recoverable failure, permanently for the life of the process. Recovery makes that first failure invisible. Nothing here needs a network call the CLI was not already making.

### 3.4 Where the resolver lives: core, not CLI — decided

The cap is a property of the *provider protocol*, not of the CLI. `@aragon-agent/core` is dependency-injected and host-agnostic (`no-host-coupling.test.ts` enforces that), and the CLI is not its only consumer. Putting the resolver in the CLI would leave `AnthropicProvider` shipping a private 64000 to every other embedder. So: core owns the number and the clamp; the CLI owns only the user's intent.

---

## 4. Technical design

### 4.1 The authority module — `packages/core/src/llm/output-limits.ts` (new)

```ts
/** The product default. THE single source of truth; nothing else may spell 64000. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 64_000;

/** Below this a turn cannot produce a usable tool call; never clamp under it. */
export const MIN_MAX_OUTPUT_TOKENS = 256;

/** Every model in the supported set accepts at least this. Used when recovery
 *  cannot parse a real ceiling out of the provider's error. */
export const SAFE_FALLBACK_MAX_OUTPUT_TOKENS = 8_192;

/** Anthropic requires max_tokens > thinking.budget_tokens; this is the margin. */
export const THINKING_HEADROOM_TOKENS = 4_096;

/** Sanity ceiling for a hand-edited config file. */
export const ABSOLUTE_MAX_OUTPUT_TOKENS = 200_000;

/** Subtracted from a context-window computation so the estimate may be wrong. */
export const CONTEXT_SAFETY_MARGIN_TOKENS = 1_024;
```

#### 4.1.1 Static ceiling table

Ordered; **first match wins**; matched against the model id lowercased with any `models/` prefix stripped (Google returns `models/gemini-1.5-pro`).

```ts
interface CeilingRule { pattern: RegExp; ceiling: number }

const CEILING_TABLE: Record<string, CeilingRule[]> = {
  anthropic: [
    { pattern: /^claude-3-5-sonnet/,            ceiling: 8_192 },
    { pattern: /^claude-3(-|\.)/,               ceiling: 8_192 },
    { pattern: /^claude-3-7-sonnet/,            ceiling: 64_000 },
    { pattern: /^claude-opus-4-(0|1)\b/,        ceiling: 32_000 },
    { pattern: /^claude-(sonnet|haiku|opus)-4/, ceiling: 64_000 },
  ],
  openai: [
    { pattern: /^(o1|o3|o4)-mini/,              ceiling: 65_536 },
    { pattern: /^(o1|o3|o4)\b/,                 ceiling: 100_000 },
    { pattern: /^gpt-5/,                        ceiling: 128_000 },
    { pattern: /^gpt-4\.1/,                     ceiling: 32_768 },
    { pattern: /^gpt-4o/,                       ceiling: 16_384 },
    { pattern: /^gpt-4(-turbo)?$/,              ceiling: 4_096 },
    { pattern: /^gpt-3\.5/,                     ceiling: 4_096 },
  ],
  google: [
    { pattern: /^gemini-1\.5/,                  ceiling: 8_192 },
    { pattern: /^gemini-2\.0-flash/,            ceiling: 8_192 },
    { pattern: /^gemini-2\.5/,                  ceiling: 65_536 },
  ],
};

export function staticCeilingFor(providerId: string, modelId: string): number | undefined;
```

**A miss returns `undefined`, not a number.** "Unknown" and "unlimited" must stay distinguishable: an unknown model gets the product default and, if that is wrong, recovery fixes it. Baking a pessimistic 8192 into every unrecognised id would silently halve the output of every proxy user.

#### 4.1.2 Learned ceilings

```ts
export type CeilingSource = 'catalog' | 'discovery' | 'error';
const RANK: Record<CeilingSource, number> = { catalog: 1, discovery: 2, error: 3 };

/** Record a ceiling. A lower-ranked source never overwrites a higher-ranked one. */
export function learnModelCeiling(
  providerId: string, modelId: string, ceiling: number, source: CeilingSource,
): void;

export function getLearnedCeiling(providerId: string, modelId: string):
  { ceiling: number; source: CeilingSource } | undefined;

/** Test hook. MUST be called from `afterEach` in every test that learns. */
export function clearLearnedCeilings(): void;
```

Module-level `Map<string, {ceiling: number; source: CeilingSource}>` keyed `` `${providerId}:${normalizedModelId}` ``. Process-lifetime only; never persisted. `'error'` outranks everything because it came from the API itself.

#### 4.1.3 The resolver

```ts
export interface OutputLimitInput {
  providerId: string;
  modelId: string;
  /** The user's explicit setting. `undefined` means AUTO. */
  requested?: number;
  /** Caller-supplied metadata (optional; see `LLMRequest.modelLimits`). */
  modelLimits?: { maxOutputTokens?: number; contextWindow?: number };
  /** Resolved thinking budget for this request; 0/undefined when off. */
  thinkingBudget?: number;
  /** Rough prompt size, for providers where max + prompt <= context. */
  estimatedPromptTokens?: number;
}

export interface OutputLimitResolution {
  /** The value to put on the wire. Always >= MIN_MAX_OUTPUT_TOKENS. */
  value: number;
  /** The ceiling that was applied, if any was known. */
  ceiling?: number;
  /** Where `value` came from before clamping. */
  source: 'requested' | 'auto';
  /** Which rule reduced it, if any — drives the one-time warning. */
  clampedBy?: 'ceiling' | 'context' | 'absolute';
  /** Adjusted thinking budget when the cap could not accommodate the original. */
  thinkingBudget?: number;
}

export function resolveOutputTokens(input: OutputLimitInput): OutputLimitResolution;
```

Algorithm, in order — this is normative:

1. `ceiling = learned ?? modelLimits?.maxOutputTokens ?? staticCeilingFor(provider, model)`.
2. `base = requested ?? Math.min(DEFAULT_MAX_OUTPUT_TOKENS, ceiling ?? DEFAULT_MAX_OUTPUT_TOKENS)`
   — **AUTO never exceeds the product default**, even when the model would allow 100000. AUTO means "as much as is generous and safe", not "as much as physically possible": on OpenAI, `max_tokens` is charged against the 128k context window, so an AUTO of 100000 would make long conversations fail with a context error. An explicit `requested` may exceed 64000 up to the ceiling; that is the user's decision to make.
3. `value = ceiling !== undefined ? Math.min(base, ceiling) : base`; set `clampedBy = 'ceiling'` when this reduced it.
4. If `providerUsesContextSum(providerId)` (currently `openai` only) **and** `modelLimits?.contextWindow` **and** `estimatedPromptTokens` are all present:
   `value = Math.min(value, contextWindow - estimatedPromptTokens - CONTEXT_SAFETY_MARGIN_TOKENS)`; set `clampedBy = 'context'` when this reduced it.
5. `value = Math.min(value, ABSOLUTE_MAX_OUTPUT_TOKENS)` (`clampedBy = 'absolute'`).
6. Thinking invariant, only when `thinkingBudget > 0`:
   - if `value <= thinkingBudget`, first try to raise: `value = Math.min(ceiling ?? Infinity, thinkingBudget + THINKING_HEADROOM_TOKENS)`;
   - if it still does not fit, lower the budget instead: `thinkingBudget = Math.max(1024, value - THINKING_HEADROOM_TOKENS)` and return it on the resolution. Anthropic's floor for `budget_tokens` is 1024; if even that does not fit, return `thinkingBudget: 0`, which the adapter must read as "omit the `thinking` block entirely".
7. `value = Math.max(value, MIN_MAX_OUTPUT_TOKENS)`; `Math.floor` the result.

The function is **pure apart from reading the learned map**, never throws, and never returns `NaN`, `0`, or a negative.

#### 4.1.4 Prompt estimation

```ts
/** Deliberately crude: ~4 chars/token plus per-message framing. Used ONLY to
 *  keep `max_tokens + prompt <= context` on OpenAI, where being 20 % wrong is
 *  absorbed by CONTEXT_SAFETY_MARGIN_TOKENS and, failing that, by recovery. */
export function estimatePromptTokens(messages: Message[], systemPrompt?: string): number;
```

No tokenizer dependency is added. This is a guard rail, not an accounting function; §4.3 case C is the real backstop.

### 4.2 Provider adapters

All three lose their private `DEFAULT_MAX_TOKENS` and call the resolver from `buildRequestBody`.

**Anthropic** (`anthropic.ts`) — the resolver is called *before* the thinking block is built, and the block uses `resolution.thinkingBudget ?? requestedBudget`; a resolved budget of `0` means the `thinking` key is omitted (and `temperature` is therefore *not* deleted). This kills the `xhigh` failure.

**OpenAI** (`openai.ts`) — adds a token-field dialect:

```ts
/** Reasoning-family models reject `max_tokens`. */
export function openAiTokenField(modelId: string): 'max_tokens' | 'max_completion_tokens';
// /^(o1|o3|o4|gpt-5)/ → 'max_completion_tokens', else 'max_tokens'
```

The choice is also memoized per `provider:model` by recovery (§4.3 case B), so a proxy that disagrees with the heuristic is corrected once and then right forever. When the field is `max_completion_tokens`, `temperature` is omitted as well — the same models reject it.

**Google** (`google.ts`) — `generationConfig.maxOutputTokens` from the resolver. `listModels` keeps `outputTokenLimit` as authoritative and additionally calls `learnModelCeiling(id, limit, 'discovery')` for every model it returns.

**Anthropic/OpenAI `listModels`** stop asserting 64000. Neither API reports an output ceiling, so they must map through `staticCeilingFor(...) ?? DEFAULT_MAX_OUTPUT_TOKENS` and must **not** call `learnModelCeiling`. Claiming knowledge they do not have is how `claude-3-5-haiku` ends up with a "discovered" ceiling of 64000 that outranks the correct table entry of 8192. (Both existing assertions in `provider-output-limit.test.ts` — `claude-test`, `gpt-4-test` — match no table pattern and therefore still resolve to 64000, so that test keeps passing unchanged.)

### 4.3 Recovery — `packages/core/src/llm/output-limit-recovery.ts` (new)

```ts
export type OutputLimitFailure =
  | { kind: 'exceeds_ceiling';  ceiling?: number }
  | { kind: 'context_sum';      contextWindow?: number; promptTokens?: number }
  | { kind: 'unsupported_field'; expected: 'max_tokens' | 'max_completion_tokens' }
  | { kind: 'thinking_conflict' };

export function classifyOutputLimitFailure(
  providerId: string, status: number, body: string,
): OutputLimitFailure | undefined;
```

Only `status === 400` is inspected. Patterns (case-insensitive), first match wins:

| Kind | Pattern | Real-world text |
| --- | --- | --- |
| `unsupported_field` | `/unsupported parameter:?\s*'?max_tokens'?/` or `/use\s+'?max_completion_tokens'?/` | OpenAI o-series |
| `thinking_conflict` | `/max_tokens must be greater than (?:thinking\.)?budget_tokens/` | Anthropic |
| `exceeds_ceiling` | `/max_tokens:\s*\d+\s*>\s*(\d+),\s*which is the maximum/` | Anthropic → capture group is the ceiling |
| `exceeds_ceiling` | `/supports at most (\d+) completion tokens/` | OpenAI |
| `exceeds_ceiling` | `/exceeds the model limit of (\d+)/` | Google |
| `context_sum` | `/maximum context length is (\d+) tokens.*?you requested \d+ tokens \((\d+) in the messages/s` | OpenAI |
| `exceeds_ceiling` | `/max(?:imum)?[_ ](?:output\|completion)[_ ]tokens/` with no number | generic last resort → `ceiling` undefined |

```ts
export interface RecoveryAttempt {
  response: Response;
  /** The 400 body, ALREADY CONSUMED. Callers must not call `response.text()`. */
  bodyText: string;
  adjustment?: { from: number; to: number; reason: OutputLimitFailure['kind'] };
}

export async function sendWithOutputLimitRecovery(opts: {
  providerId: string;
  modelId: string;
  body: Record<string, unknown>;
  tokenField: 'max_tokens' | 'max_completion_tokens' | 'generationConfig.maxOutputTokens';
  send: (body: Record<string, unknown>) => Promise<Response>;
}): Promise<RecoveryAttempt>;
```

Contract:

1. `res = await send(body)`. If `res.ok`, return `{ response: res, bodyText: '' }` **without touching the body** — a streaming response must reach the SSE parser untouched.
2. Otherwise `bodyText = await res.text()`. **Read exactly once**; a `Response` body cannot be read twice, and the callers pass `bodyText` to `classifyHttpError` rather than re-reading. This is the single most breakable line in the feature.
3. `classifyOutputLimitFailure(...)`; if `undefined`, return as-is.
4. Build the repaired body — exactly one attempt, never a loop:
   - `exceeds_ceiling` with a parsed ceiling → set the field to `ceiling`, `learnModelCeiling(..., ceiling, 'error')`;
   - `exceeds_ceiling` without one → set the field to `min(current, SAFE_FALLBACK_MAX_OUTPUT_TOKENS)`, learn that;
   - `context_sum` → `contextWindow - promptTokens - CONTEXT_SAFETY_MARGIN_TOKENS`, floored at `MIN_MAX_OUTPUT_TOKENS`; do **not** learn (it is conversation-specific, not a model property);
   - `unsupported_field` → rename the key, remember the dialect via `learnTokenField(providerId, modelId, expected)`, keep the value;
   - `thinking_conflict` → raise the cap to `budget + THINKING_HEADROOM_TOKENS`, or lower `thinking.budget_tokens` to `value - THINKING_HEADROOM_TOKENS` when the ceiling forbids raising.
5. `res2 = await send(repaired)`; return it with its own consumed `bodyText` when it also failed. A second failure surfaces exactly as today.
6. On a successful repair, emit `console.warn('[<Provider>] output cap adjusted <from> -> <to> (<reason>) for <model>')`. In the CLI this reaches the transcript through `installConsoleBridge`; in a headless embedder it is a plain warning. Core has no logger and must not acquire one.

### 4.4 Sequence — a single LLM call after this change

```
runAgentLoop
  └─ providerRegistry.stream(providerId, { …, maxTokens: ctx.maxTokens })
       └─ Provider.stream
            ├─ buildRequestBody
            │    ├─ resolveOutputTokens({ providerId, modelId, requested: request.maxTokens,
            │    │                        modelLimits: request.modelLimits,
            │    │                        thinkingBudget, estimatedPromptTokens })
            │    │     ├─ learned? → discovery? → static table? → 64000
            │    │     └─ clamp: ceiling → context → absolute → thinking → floor
            │    └─ write max_tokens | max_completion_tokens | generationConfig.maxOutputTokens
            ├─ sendWithOutputLimitRecovery(send = fetch)
            │    ├─ 200 → straight through to parseSSEStream           (hot path, zero cost)
            │    └─ 400 → classify → repair → learn → send once more
            └─ SSE → StreamEvent*
```

The hot path adds one pure function call and no I/O.

### 4.5 CLI: expressing user intent

#### 4.5.1 The `auto` sentinel

`PersistedConfig.maxTokens` stays `number | null`, and `null` acquires a **defined** meaning: *AUTO — let the resolver pick per model*. Absent-from-file continues to mean 64000, which is what the requirement asks for.

`load.ts` gets a dedicated resolver because `pick()` cannot express this: `pick` skips `null`, so today a file containing `"maxTokens": null` silently resolves to 64000 and AUTO is unreachable.

```ts
/** flag › env › file › default, where an EXPLICIT null at any layer means AUTO. */
function resolveMaxTokens(
  flags: CliFlags, env: Partial<PersistedConfig>, file: Partial<PersistedConfig>,
): number | undefined {
  for (const layer of [flags.maxTokens, env.maxTokens, has(file,'maxTokens') ? file.maxTokens : undefined]) {
    if (layer === undefined) continue;            // layer said nothing
    if (layer === null || isAutoToken(layer)) return undefined;   // AUTO
    const n = clampMaxTokens(layer);
    if (n !== undefined) return n;
    // unparseable → fall through to the next layer, and warn once
  }
  return DEFAULT_CONFIG.maxTokens ?? undefined;    // 64000
}
```

`has(file, 'maxTokens')` must be `Object.prototype.hasOwnProperty.call(...)`, not truthiness: `null` is exactly the value we need to detect. `isAutoToken(v)` accepts `'auto'`, `'AUTO'`, `''` after trimming, and `0`.

#### 4.5.2 The single clamp gate

Following the discipline this package already states for `clampSkillsConfig` / `clampLogConfig` / `clampTeamConfig` — one gate used on **both** the read and the write path, so a bad value on disk cannot present as "my setting won't stick":

```ts
export const MAX_TOKENS_RANGE = { min: MIN_MAX_OUTPUT_TOKENS, max: ABSOLUTE_MAX_OUTPUT_TOKENS };

/** `undefined` for AUTO / unusable input; a clamped integer otherwise. */
export function clampMaxTokens(v: unknown): number | undefined;

/** Parse UI/CLI text. Distinguishes AUTO from "the user typed nonsense". */
export function parseMaxTokensInput(raw: string):
  | { kind: 'auto' }
  | { kind: 'value'; value: number; clamped: boolean }
  | { kind: 'invalid' };
```

`coerceMaxTokens` is kept (other callers exist) and reimplemented as `clampMaxTokens` without the range, so behaviour for in-range values is byte-identical.

#### 4.5.3 Surfaces

| Surface | Change |
| --- | --- |
| `--max-tokens <n\|auto>` | Accepts `auto`; help text becomes `Output token cap: a number, or "auto" for the model ceiling (default 64000)`. |
| `ARAGON_MAX_TOKENS` | Accepts `auto` / `0`; unparseable values are ignored with a warning instead of silently becoming `null`. |
| `aragon config set maxTokens <n\|auto\|default>` | Echoes the **clamped** value, like `team.*` already does (`Set maxTokens = 64000`), so `config set maxTokens 900000` cannot report a number that was never stored. |
| `aragon config get/list` | Prints `auto` for `null`; no code change beyond the renderer. |
| Settings screen | See §4.5.4. |
| `/max-tokens` | See §4.5.5. |
| `/reload` | Already re-applies `config.maxTokens` via `setMaxTokens`; no change. |
| Team subagents | `subagent.ts:273` already forwards `deps.config.maxTokens`; children therefore inherit the same resolution. **No change** — stated explicitly so nobody "fixes" it. |

#### 4.5.4 Settings screen

`SettingsScreen.tsx` keeps the `Max tokens` text field and gains two things:

1. **A resolved preview row** rendered under the field list (a `rows.push(...)` entry, so `OverlayFrame`'s controlled-mode contract — one element per row, `wrap="truncate"` — is preserved):
   `Effective: 16384  (clamped from 64000 by the gpt-4o ceiling)` or `Effective: 64000 (default)`.
   The preview calls `resolveOutputTokens({ providerId: values.provider, modelId: values.model, requested: parsed })` on every render. It is pure and cheap; no effect, no async.
2. **Validation on save.** `App.tsx::handleSettingsSave` runs `parseMaxTokensInput`:
   - `auto` → `controller.setMaxTokens(undefined)`, persist `maxTokens: null`, toast `Max tokens: auto (per-model ceiling).`
   - `value` → set + persist; when `clamped`, toast `warn` naming the stored value.
   - `invalid` → **do not save the field**, keep the previous value, toast `warn: "Max tokens must be a number or \"auto\"."` The rest of the settings still save; one bad field must not discard a pasted API key.

The initial value shown is `cfg.maxTokens ? String(cfg.maxTokens) : 'auto'` (today it renders an empty string, which reads as "unset" and is indistinguishable from AUTO).

#### 4.5.5 `/max-tokens` slash command

Modelled byte-for-byte on `/thinking` in `commands/builtins.ts` (`ctx.args`, `ctx.notify`, `ctx.toast`, `ctx.persistConfig`, `ctx.controller`):

```
/max-tokens              → notify info: current setting + effective cap for the live model
/max-tokens 32000        → set, persist, toast success
/max-tokens auto         → set AUTO (persist null), toast success
/max-tokens default      → reset to 64000
/max-tokens <garbage>    → notify warn, change nothing
```

This exists next to the settings screen for the same reason `/theme` and `/plan` do: the slash palette is the discoverable surface, and it is one keystroke instead of five arrow presses.

### 4.6 Diagnostics

`load.ts::recordResolvedConfig` gains `maxTokens: config.maxTokens ?? 'auto'`. Answering "why is my output truncated" must not require guessing which of four layers won. Core emits nothing per request; only recovery warns, and only when it actually changed something.

---

## 5. File / module change plan

| File | New? | Intent |
| --- | --- | --- |
| `packages/core/src/llm/output-limits.ts` | new | Constants, ceiling table, learned-ceiling cache, `resolveOutputTokens`, `estimatePromptTokens`. The single source of truth for 64000. |
| `packages/core/src/llm/output-limit-recovery.ts` | new | `classifyOutputLimitFailure`, `sendWithOutputLimitRecovery`, token-field memo. |
| `packages/core/src/llm/providers/anthropic.ts` | modify | Drop private const; resolve cap + thinking budget together; wrap `fetch` in recovery; `listModels` uses the static table. |
| `packages/core/src/llm/providers/openai.ts` | modify | Drop private const; `openAiTokenField` dialect; resolve cap; wrap `fetch` in recovery; `listModels` uses the static table. |
| `packages/core/src/llm/providers/google.ts` | modify | Drop private const; resolve cap; wrap `fetch` in recovery; `listModels` feeds `learnModelCeiling(..., 'discovery')`. |
| `packages/core/src/llm/provider.ts` | modify | Add optional `LLMRequest.modelLimits?: { maxOutputTokens?: number; contextWindow?: number }`. |
| `packages/core/src/llm/model-registry.ts` | modify | Correct the nine catalog ceilings; `buildRuntimeModel` default from `DEFAULT_MAX_OUTPUT_TOKENS`; seed `learnModelCeiling(..., 'catalog')` in `registerDefaults`; feed discovery results into the cache. |
| `packages/core/src/index.ts` | modify | Export the new public surface (constants, `resolveOutputTokens`, `OutputLimitResolution`, `learnModelCeiling`, `clearLearnedCeilings`). |
| `packages/core/API.md` | modify | Document the new exports and the resolution order. |
| `packages/cli/src/config/schema.ts` | modify | `MAX_TOKENS_RANGE`, `clampMaxTokens`, `parseMaxTokensInput`, `isAutoToken`; `DEFAULT_CONFIG.maxTokens` stays `64_000`; document `null === auto` on the interface field. |
| `packages/cli/src/config/load.ts` | modify | `resolveMaxTokens` (own-property aware); log the resolved cap. |
| `packages/cli/src/config/env.ts` | modify | `ARAGON_MAX_TOKENS` accepts `auto`/`0`; ignore-and-warn on garbage. |
| `packages/cli/src/cli.tsx` | modify | `--max-tokens <n\|auto>` help; `config set maxTokens` accepts `auto`/`default` and echoes the clamped result. |
| `packages/cli/src/config/cli-commands.ts` | modify | `config get`/`list` render `null` as `auto`. |
| `packages/cli/src/ui/overlays/SettingsScreen.tsx` | modify | Effective-cap preview row; placeholder text `auto`. |
| `packages/cli/src/ui/App.tsx` | modify | `handleSettingsSave` validation + AUTO handling + toasts; initial value renders `auto`. |
| `packages/cli/src/commands/builtins.ts` | modify | New `/max-tokens` command. |
| `packages/cli/src/ui/overlays/HelpOverlay.tsx` | modify | List `/max-tokens`. |
| `packages/cli/README.md` | modify | Flag table, env-var list, config-file reference, a "Output token limits" section with the `~/.aragon-agent/config.json` example. |
| `packages/cli/CHANGELOG.md` | modify | New entry at the top (do not rewrite history entries). |
| `packages/core/src/__tests__/output-limits.test.ts` | new | §9 cases 1–12. |
| `packages/core/src/__tests__/output-limit-recovery.test.ts` | new | §9 cases 13–20. |
| `packages/core/src/__tests__/provider-output-limit.test.ts` | modify | Extend with per-model clamping and dialect cases; existing cases must keep passing unchanged. |
| `packages/cli/src/__tests__/config.test.ts` | modify | AUTO precedence + clamping cases. |
| `packages/cli/src/__tests__/max-tokens-ui.test.tsx` | new | Settings-screen preview + `/max-tokens` command. |

**Not changed, deliberately:** `packages/cli/src/team/subagent.ts` (already forwards the value), `packages/cli/src/agent/controller.ts::setMaxTokens` (already correct), `packages/core/src/engine/agent-loop.ts` (already forwards `ctx.maxTokens`), `config/store.ts` (no new nested section — every key added here is flat, so the hand-written one-level merge it documents needs no replacement).

---

## 6. Interface design

### 6.1 Exported TypeScript API (`@aragon-agent/core`)

```ts
export const DEFAULT_MAX_OUTPUT_TOKENS: 64_000;
export const MIN_MAX_OUTPUT_TOKENS: 256;
export const SAFE_FALLBACK_MAX_OUTPUT_TOKENS: 8_192;
export const ABSOLUTE_MAX_OUTPUT_TOKENS: 200_000;
export const THINKING_HEADROOM_TOKENS: 4_096;

export function resolveOutputTokens(input: OutputLimitInput): OutputLimitResolution;
export function staticCeilingFor(providerId: string, modelId: string): number | undefined;
export function learnModelCeiling(p: string, m: string, c: number, s: CeilingSource): void;
export function getLearnedCeiling(p: string, m: string): { ceiling: number; source: CeilingSource } | undefined;
export function clearLearnedCeilings(): void;
export function estimatePromptTokens(messages: Message[], systemPrompt?: string): number;

export type { OutputLimitInput, OutputLimitResolution, CeilingSource, OutputLimitFailure };
```

`LLMRequest` gains one optional field; no existing field changes type, so every current caller compiles unchanged.

### 6.2 CLI signatures

```bash
aragon --max-tokens 32000            # this run only
aragon --max-tokens auto             # this run only, per-model ceiling
aragon config set maxTokens 32000    # persisted; prints "Set maxTokens = 32000"
aragon config set maxTokens auto     # persisted as null; prints "Set maxTokens = auto"
aragon config set maxTokens default  # persisted as 64000
aragon config get maxTokens          # "64000" | "auto"
ARAGON_MAX_TOKENS=32000 aragon       # env layer, between flag and file
```

### 6.3 Slash command

```
/max-tokens [<n> | auto | default]
```

### 6.4 Config file — `~/.aragon-agent/config.json`

On this machine: `C:\Users\jdqqj\.aragon-agent\config.json` (the path is `$ARAGON_HOME` when set, else `<homedir>/.aragon-agent`; see `config/app-paths.ts`). The file is written `0600` on POSIX and updated atomically, so hand-editing it while the CLI is closed is a supported workflow, and `/reload` picks up an edit made in another window.

```jsonc
{
  "version": 1,
  "provider": "anthropic",
  "model": "claude-sonnet-4-5-20250929",
  "thinkingLevel": "off",

  // Output token cap.
  //   64000  (or any 256..200000 integer) — an explicit cap, clamped down to
  //          the target model's real ceiling when that ceiling is lower.
  //   null   — AUTO: use each model's own ceiling, never above 64000.
  //   absent — the product default, 64000.
  "maxTokens": 64000
}
```

No other key in the file changes shape. There is no new nested section.

---

## 7. Data model

No database, no migration, no persisted schema version bump (`CONFIG_VERSION` stays `1` — the key already exists and its type is unchanged; only the meaning of `null` is *defined* where it was previously unreachable).

In-memory shapes:

| Shape | Where | Lifetime |
| --- | --- | --- |
| `PersistedConfig.maxTokens: number \| null` | `~/.aragon-agent/config.json` | Durable |
| `CliConfig.maxTokens?: number` (`undefined` = AUTO) | `loadConfig()` result, `controller.getConfig()` | Process |
| `LLMRequest.maxTokens?: number` | Per request | Request |
| `LLMRequest.modelLimits?: {...}` | Per request, optional | Request |
| `learnedCeilings: Map<'provider:model', {ceiling, source}>` | `output-limits.ts` module scope | Process |
| `learnedTokenFields: Map<'provider:model', 'max_tokens' \| 'max_completion_tokens'>` | `output-limit-recovery.ts` module scope | Process |
| `ModelInfo.maxOutputTokens: number` | `ModelRegistry` catalog + 5-min discovery cache | Process |

Two module-level caches are introduced. Both are process-scoped, both are bounded by the number of distinct models a session touches (single digits in practice), neither is serialized, and both expose a `clear*()` test hook that **must** be called from `afterEach` in any test that populates them — otherwise a learned 8192 leaks into the next test file and produces a failure whose cause is not in the failing file.

---

## 8. Behavioural matrix

| Scenario | Configured | Model | On the wire | User sees |
| --- | --- | --- | --- | --- |
| Fresh install, no config | (absent → 64000) | `claude-sonnet-4-5` | 64000 | nothing |
| Fresh install, small model | (absent → 64000) | `gpt-4o` | 16384 | nothing (static table hit) |
| Fresh install, unknown proxy model | (absent → 64000) | `my-llm-v3` @ custom base URL | 64000, then one repaired retry at the parsed ceiling | one `warn` notice, run continues |
| `--thinking xhigh` | 64000 | `claude-sonnet-4-5` | `max_tokens 64000`, `budget_tokens 59904` | nothing |
| User sets 8000 | 8000 | any | 8000 | nothing |
| User sets 900000 | clamped to 200000 | `claude-sonnet-4-5` | 64000 (ceiling) | `Set maxTokens = 200000` at write time; no run-time noise |
| `maxTokens: null` | AUTO | `o1` | 64000 (AUTO caps at the product default) | nothing |
| User sets 100000 explicitly | 100000 | `o1` | 100000 (`max_completion_tokens`) | nothing |
| Long conversation on `gpt-4o` | 64000 | `gpt-4o` | `min(16384, ctx − prompt − 1024)` | nothing |
| Second failure after repair | — | — | — | today's error text, unchanged |

---

## 9. Testing & acceptance criteria

All tests are Vitest, colocated in the existing `src/__tests__` directories. Write the test first in every case.

### Core — `output-limits.test.ts`

1. `resolveOutputTokens` with no `requested` and an unknown model returns exactly `64000`, `source: 'auto'`, no `clampedBy`.
2. AUTO against `gpt-4o` returns `16384` with `clampedBy: 'ceiling'`.
3. AUTO against `o1` (table ceiling 100000) returns `64000` — AUTO never exceeds the product default.
4. `requested: 100000` against `o1` returns `100000` (an explicit value may exceed the default, up to the ceiling).
5. `requested: 900000` returns `200000` with `clampedBy: 'absolute'`.
6. `requested: 10` returns `256` (`MIN_MAX_OUTPUT_TOKENS` floor).
7. `thinkingBudget: 65536` with ceiling 64000 returns `value: 64000` and `thinkingBudget: 59904`.
8. `thinkingBudget: 32768` with `value: 64000` leaves both untouched.
9. Ceiling 8192 with `thinkingBudget: 65536` returns `thinkingBudget: 0` (block omitted) and never a negative.
10. `learnModelCeiling(..., 'error')` outranks a `'discovery'` value; `'catalog'` never overwrites `'error'`.
11. `staticCeilingFor('google', 'models/gemini-1.5-pro')` returns `8192` — the `models/` prefix is normalized.
12. `staticCeilingFor` returns `undefined` for an unrecognised id (unknown ≠ 8192).

### Core — `output-limit-recovery.test.ts`

13. Each of the five real provider error strings in §4.3 classifies to the expected kind, and the numeric ones yield the right captured number.
14. A non-400 status classifies to `undefined` and the body is never read.
15. A 200 response is returned with the body **unconsumed** (assert `response.bodyUsed === false`).
16. A 400 `exceeds_ceiling` produces exactly **two** `send` calls, the second carrying the parsed ceiling, and leaves the ceiling in the learned cache.
17. A 400 that is not an output-limit failure produces exactly **one** `send` call.
18. Two consecutive 400s produce exactly two calls and return the second response with its consumed `bodyText`.
19. `unsupported_field` renames the key, preserves the value, and memoizes the dialect so a *subsequent* request uses the right name on the first try.
20. `context_sum` does **not** write to the learned-ceiling cache.

### Core — `provider-output-limit.test.ts` (extended; existing four cases unchanged)

21. Anthropic with `model: 'claude-3-5-haiku-20241022'` and no `maxTokens` sends `max_tokens: 8192`.
22. OpenAI with `model: 'o1'` sends `max_completion_tokens` and **no** `max_tokens`, and no `temperature`.
23. Google with `model: 'gemini-1.5-pro'` sends `generationConfig.maxOutputTokens: 8192`.
24. Anthropic with `thinkingLevel: 'xhigh'` sends `max_tokens > thinking.budget_tokens` (the guaranteed-400 regression).
25. Google `listModels` populates the learned cache from `outputTokenLimit`; Anthropic/OpenAI `listModels` do **not** write to it.

### CLI — `config.test.ts` (extended)

26. No config file → `loadConfig().maxTokens === 64000` (already asserted; must keep passing).
27. `{"maxTokens": null}` → `loadConfig().maxTokens === undefined` (AUTO). **This is the case that fails today.**
28. `{"maxTokens": 4096}` + `--max-tokens 16384` → `16384` (already asserted; must keep passing).
29. `ARAGON_MAX_TOKENS=auto` → `undefined`; `ARAGON_MAX_TOKENS=abc` → falls through to the file/default and does not become AUTO.
30. `{"maxTokens": 900000}` → `200000` on read; `updatePersistedConfig({maxTokens: 900000})` writes `200000` (the same gate on both paths).

### CLI — `max-tokens-ui.test.tsx`

31. `parseMaxTokensInput` maps `'auto'`/`''`/`'0'` → `auto`; `'32000'` → `value`; `'abc'` → `invalid`.
32. The settings screen renders `Effective: 16384` when provider/model are `openai`/`gpt-4o` and the field holds `64000`.
33. `/max-tokens 32000` calls `setMaxTokens(32000)` and persists `{ maxTokens: 32000 }`.
34. `/max-tokens auto` persists `{ maxTokens: null }`.
35. `/max-tokens abc` notifies `warn` and calls neither `setMaxTokens` nor `persistConfig`.

### Manual acceptance (record results in `manual-test.md`)

- **M1** — Delete `config.json`, run `aragon`, open `/settings`: `Max tokens` shows `64000`, `Effective: 64000`.
- **M2** — `aragon --model gpt-4o -p "write 100 words"`: the run completes; no 400 in the transcript.
- **M3** — Hand-edit `C:\Users\jdqqj\.aragon-agent\config.json` to `"maxTokens": 4096`, run `/reload`, confirm `/max-tokens` reports `4096`.
- **M4** — `aragon --thinking xhigh -p "hello"` against Anthropic completes.
- **M5** — Point `--base-url` at a proxy serving a model with a small ceiling: the first turn shows one adjustment warning and completes; the second turn shows none.
- **M6** — Set `"maxTokens": null`, confirm `/max-tokens` reports `auto` and the effective cap tracks the selected model.

### Definition of done

- `npm test` green in both workspaces; no existing assertion weakened or deleted.
- `grep -rn "64_000\|64000" packages/core/src packages/cli/src` shows the literal only in `output-limits.ts` and `schema.ts::DEFAULT_CONFIG` (plus tests).
- README, `API.md` and `CHANGELOG.md` updated.
- No `any` introduced; `tsc --noEmit` clean in both packages.

---

## 10. Risks & mitigations

| # | Risk | Severity | Mitigation |
| --- | --- | --- | --- |
| R1 | **The static ceiling table goes stale** and clamps a new model below its real capability. | Medium | The table is only ever consulted when discovery and the learned cache have nothing; a wrong *low* entry costs output length, never a failure. Discovery (Google) and recovery (all) both outrank it, and both write to the learned cache. New entries are a one-line change with a test. |
| R2 | **`response.text()` called twice** in the recovery path throws `TypeError: Body is unusable`. | High | `RecoveryAttempt` carries `bodyText` and the contract states callers must not re-read. Test 15 asserts `bodyUsed === false` on the success path; tests 16/18 assert the failure path reads exactly once. |
| R3 | **Recovery loops** and doubles every user's bill. | High | Exactly one retry, structurally: `sendWithOutputLimitRecovery` calls `send` at most twice with no loop construct. Tests 16–18 pin the call count. |
| R4 | **The learned cache leaks across tests**, producing failures whose cause is in another file. | Medium | `clearLearnedCeilings()` / `clearLearnedTokenFields()` exported and required in `afterEach`; the module header says so. |
| R5 | **The OpenAI dialect heuristic is wrong** for a proxy (e.g. LiteLLM fronting o3 under a `gpt-` alias). | Medium | The heuristic is only the first guess; `unsupported_field` recovery renames the parameter and memoizes the correct dialect after one round trip. |
| R6 | **Prompt estimation is wrong** and clamps the cap too aggressively on OpenAI. | Medium | The estimate only ever applies on OpenAI, only when `contextWindow` is known, and carries a 1024-token margin. Being wrong low costs output length; being wrong high is caught by `context_sum` recovery. |
| R7 | **`null` in the config file changes meaning** for an existing user. | Low | Today `null` resolves to 64000 by accident (`pick` skips it) and is unreachable through any supported write path — the settings screen writes `maxTokens ?? null` only when the field is empty, which was previously indistinguishable from "unset". The new meaning (AUTO ≤ 64000) differs from the old accident by at most a downward clamp on a small model, i.e. in the direction that prevents failures. Documented in the CHANGELOG. |
| R8 | **AUTO surprises a user** who expected `o1`'s full 100000. | Low | `/max-tokens` and the settings preview both print the effective number; an explicit value still reaches the ceiling. |
| R9 | **The settings preview calls the resolver on every keystroke.** | Low | `resolveOutputTokens` is pure, allocation-light and does no I/O; the ceiling lookup is a `Map.get` plus at most seven regex tests. |
| R10 | **Anthropic's `budget_tokens` floor (1024)** makes the thinking downgrade illegal on a tiny-ceiling model. | Low | Step 6 returns `thinkingBudget: 0` in that case and the adapter omits the block entirely rather than sending an illegal value. Test 9. |
| R11 | **Core acquires host coupling** by importing a logger for the warning. | Medium | Recovery uses `console.warn` only, exactly as `anthropic.ts:199` already does; `no-host-coupling.test.ts` continues to pass unmodified. |

---

## 11. Non-goals

- No tokenizer dependency (`tiktoken`, `@anthropic-ai/tokenizer`) is added; §4.1.4 is a heuristic on purpose.
- No per-model *override map* in the config file. One number plus AUTO covers the requirement; a `maxTokensByModel` object would be a second nested section and `store.ts`'s hand-written one-level merge would have to be replaced first.
- No automatic continuation when a response legitimately stops at `stopReason: 'max_tokens'`. That is a different feature (turn continuation), and the executor already emits a clear message for a truncated tool call (`tools/executor.ts:111`).
- No change to `contextWindow` handling for Anthropic or Google, neither of which enforces `max + prompt <= context` the way OpenAI does.
- No persistence of learned ceilings across process restarts.
- `xai` and `groq` remain catalog-only: `ADAPTER_PROVIDERS` is `['anthropic','openai','google']`, so they have no adapter to reach. Their catalog entries are corrected for consistency but nothing consults them at runtime.

---

## 12. Implementation order

Each phase leaves the tree green and shippable.

| Phase | Content | Gate |
| --- | --- | --- |
| P1 | `output-limits.ts` + tests 1–12. No caller yet. | Core tests green. |
| P2 | Wire the three adapters to the resolver; delete the three private constants; fix `listModels`; correct `model-registry.ts`; tests 21–25. | `provider-output-limit.test.ts` green **including its four original cases**. |
| P3 | `output-limit-recovery.ts` + tests 13–20; wrap the three `fetch` calls. | Core tests green; M5 passes. |
| P4 | CLI intent layer: `clampMaxTokens` / `parseMaxTokensInput` / `resolveMaxTokens`, env, flag, `config set`; tests 26–30. | CLI tests green; M3 passes. |
| P5 | TUI: settings preview + validation, `/max-tokens`, help overlay; tests 31–35. | M1, M6 pass. |
| P6 | README, `API.md`, `CHANGELOG.md`, `manual-test.md` results. | Definition of done in §9. |

---

## 实施过程发现的方案缺陷 (Issues Found During Implementation)

Seven places where the design as written could not be implemented literally. Each
one is corrected in the code, and each correction is the one the design's own
stated intent asks for.

### IF-1 — The Anthropic ceiling table's order makes the 3.7 entry dead code

§4.1.1 declares the table "ordered; **first match wins**" and then lists
`/^claude-3-5-sonnet/` and `/^claude-3(-|\.)/` **before** `/^claude-3-7-sonnet/`.
`claude-3-7-sonnet-20250219` matches `/^claude-3(-|\.)/`, so under first-match-wins
the 3.7 entry is unreachable and every Claude 3.7 request is clamped to 8192 —
one eighth of that model's real ceiling, silently, forever.

**Corrected:** `/^claude-3-7-sonnet/` is listed first. Every other entry keeps its
relative order, so no other model's resolution changes. A regression case in
`output-limits.test.ts` pins all four Claude 3.x outcomes so the order cannot be
"tidied" back.

### IF-2 — §9 case 9's expected value contradicts §4.1.3 step 6

§9 case 9 asserts that a ceiling of 8192 with `thinkingBudget: 65536` returns
`thinkingBudget: 0`. The normative algorithm in §4.1.3 step 6 says otherwise:
`Math.max(1024, value - THINKING_HEADROOM_TOKENS)` = `max(1024, 8192 - 4096)` =
`4096`, which is above Anthropic's 1024 floor and strictly below the cap, so the
budget is DOWNGRADED rather than dropped. R10 describes the `0` branch as being
for a "tiny-ceiling model", and 8192 is not one — the case's numbers do not
exercise the branch its own text names.

**Corrected:** the normative algorithm is implemented. Case 9 asserts the real
behaviour (`thinkingBudget: 4096`, positive, strictly below the cap) and a new
case 9b uses a ceiling of 1024, which genuinely cannot house the floor, to pin
the `thinkingBudget: 0` branch. A working request with reduced thinking is
strictly better than a request with no thinking at all, so preferring the
algorithm here also preferres the better outcome.

### IF-3 — §4.1.3 step 2 makes `clampedBy: 'ceiling'` unreachable for AUTO

Step 2 computes `base = requested ?? Math.min(DEFAULT, ceiling ?? DEFAULT)` and
step 3 then sets `clampedBy = 'ceiling'` "when this reduced it". For AUTO the
ceiling is already folded into `base`, so step 3 can never reduce anything and
`clampedBy` is never set — which makes §9 case 2 (`AUTO against gpt-4o returns
16384 with clampedBy: 'ceiling'`) unsatisfiable, and, more importantly, leaves
§4.5.4's settings preview with nothing to say: the user would see a bare
`Effective: 16384` and no indication of where the other 47616 went.

**Corrected:** the ambition (`requested ?? DEFAULT`) is kept separate from the
clamp. Every resolved VALUE is identical to what the spec's arithmetic produces;
only `clampedBy` differs, and only by being set when it should be.

### IF-4 — `config/store.ts` had to change after all

§5 lists `store.ts` under "Not changed, deliberately", on the grounds that no new
nested section is added. That reasoning is about the hand-written one-level merge
and is correct as far as it goes, but §9 case 30 requires
`updatePersistedConfig({maxTokens: 900000})` to write `200000` — a WRITE-path
clamp, which lives in `store.ts` and nowhere else. §4.5.2 also states the gate
must be "used on **both** the read and the write path".

**Corrected:** `store.ts` gains a `normalizeMaxTokens` helper applied in
`loadPersistedConfig` and `updatePersistedConfig`. Both use an own-property test
rather than a spread, because `null` (AUTO) and "key absent" (the default) are
different settings and a spread cannot tell them apart. No new nested section was
introduced; the merge is untouched.

### IF-5 — `public-api.test.ts` is forced to change by `index.ts`

The change plan lists `packages/core/src/index.ts` but not
`src/__tests__/public-api.test.ts`, which freezes the runtime export surface and
its exact count. The file's own header states the three-sync discipline that
makes this mandatory.

**Corrected:** `EXPECTED` gains the seventeen new value exports and the count
assertion moves 58 → 75. No existing entry was removed or weakened. `API.md`'s
own "Runtime (value) exports — 56" heading was already stale relative to that
test; it is now 75 and consistent.

### IF-6 — `config set: every accepted key actually writes something` needed
teaching, not weakening

`maxTokens` has to echo the STORED value rather than the typed one (§4.5.3), so
it is handled by a dedicated early-return branch before `runConfigSet`'s switch —
the same shape `team.*` uses. The existing source-text guard in `config.test.ts`
only recognised `case '<key>':`, so it reported `maxTokens` as unhandled.

**Corrected:** the guard now accepts either a `case` or an
`if (key === '<key>')` early-return branch. A key with NEITHER still fails, which
is the class of bug the guard exists for.

### IF-7 — `--json` output of `config list` deliberately keeps the raw `null`

§4.5.3 says `config get`/`list` print `auto` for `null`. Applied to `--json` that
would emit `"maxTokens": "auto"`, which is not a value the config file accepts
and would break any script that round-trips the output.

**Corrected:** the `auto` label applies to the human-readable renderers only;
`--json` mirrors the file. The override is also scoped to `maxTokens` rather than
replacing both renderers, because `get` and `list` format everything else
differently (unquoted vs. JSON) and unifying them would have changed the output
of every other key.

---

## 评审阶段发现的问题 (Issues Found During Review)

### RV-1 — `ModelRegistry.discoverModels` laundered the placeholder default back into an assertion

§4.2 is explicit that Anthropic's and OpenAI's `listModels` must **not** call
`learnModelCeiling`, because neither API reports an output ceiling and claiming
otherwise is how a small model ends up with a "discovered" 64000 that outranks
its correct table entry. The adapters obey that, and `provider-output-limit.test.ts`
pins it. But §5's line for `model-registry.ts` — "feed discovery results into the
cache" — was implemented as an unconditional loop over **every** provider's
`listModels` result at `'discovery'` rank, which re-introduced the same defect one
level up: the two adapters fall back to `DEFAULT_MAX_OUTPUT_TOKENS` for any model
outside the static table, and the registry then recorded that placeholder as a
fact outranking everything but `'error'`.

The damage is narrow but real, and it is precisely what §4.1.1's "a miss returns
`undefined`, not a number" exists to prevent: for a model nothing knows —
a proxy, a `--base-url` endpoint — "unknown" silently became "capped at 64000",
so an explicit `--max-tokens 100000` the user is entitled to make against that
endpoint was clamped to 64000 on the strength of a value nobody ever reported.
The trigger is opening `/model` (which is what runs discovery), so it is also
invisible in a transcript.

**Corrected:** the loop skips a reported ceiling that is exactly
`DEFAULT_MAX_OUTPUT_TOKENS`, with the reasoning in a comment at the call site.
The loop keeps its stated purpose — a third-party provider that genuinely reports
a per-model limit is still learned — and skipping costs nothing, because AUTO
tops out at the default anyway and a genuinely over-large explicit request is
repaired by §4.3. Two cases in `provider-output-limit.test.ts` pin both
directions so the `continue` cannot be "tidied" away.

### RV-2 — the recovery warning named the wrong number on two of its four branches

§4.3 step 6 specifies one message shape, `<from> -> <to>`, for all four repair
kinds. Two of them do not fit it. A `unsupported_field` repair changes the
parameter *name* and leaves the value alone, so the line rendered as
`output cap adjusted 64000 -> 64000` — a warning whose only job is to explain
what happened, reading instead like a bug in the thing that emitted it. And the
`thinking_conflict` branch that lowers the budget carries the *budget* in
`from`/`to` while the cap is the thing that could not move, so the same template
labelled the wrong quantity.

**Corrected:** each repair now carries the phrase describing what it actually
changed (`RepairPlan.summary`, module-private — the exported
`RecoveryAttempt.adjustment` shape is unchanged), and `warnAdjusted` renders it.
The existing assertion on `'64000 -> 8192'` for the ceiling branch still holds.
The provider label also comes from a small map, because
`providerId.charAt(0).toUpperCase()` produced `[Openai]`.

### RV-3 — Anthropic's `budget_tokens` floor was spelled twice

`output-limits.ts` declares `MIN_THINKING_BUDGET_TOKENS = 1_024` and
`output-limit-recovery.ts` repeated the literal in `repairThinkingConflict`. Two
copies of a provider constant is the exact defect §2 opens by counting four
copies of the default, so the constant is now exported from its owning module and
imported. It is deliberately **not** added to the package barrel: it is an
implementation detail of the two modules that reconcile thinking with the cap,
and adding it would move `public-api.test.ts`'s count for no consumer.
