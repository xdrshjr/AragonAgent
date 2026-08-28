/**
 * Output-token authority — the single source of truth for "how many tokens may
 * this model produce", and the resolver every provider adapter consults before
 * putting a number on the wire.
 *
 * Why this module exists at all: sending a generous `max_tokens` unconditionally
 * is only safe for models whose ceiling is at least that generous. Anthropic,
 * OpenAI and Google all answer an over-large cap with an HTTP 400, and a 400
 * during the agent loop ends the turn with a raw provider string in the
 * transcript. So the product default is the AMBITION and the model's real
 * ceiling is the LAW, with the gap closed silently rather than by a failed run.
 *
 * Four ranked ceiling sources feed one resolver:
 *
 *   learned-from-error  >  discovery (API-reported)  >  static table  >  default
 *
 * TEST HYGIENE: `learnModelCeiling` writes a MODULE-LEVEL map that lives for the
 * whole process. Any test that learns MUST call `clearLearnedCeilings()` from
 * `afterEach`, or a learned 8192 leaks into the next test file and produces a
 * failure whose cause is not in the failing file.
 */

import type { Message } from './types.js';

// ---------------------------------------------------------------------------
// Constants — nothing else in this package may spell these numbers
// ---------------------------------------------------------------------------

/** The product default. THE single source of truth; nothing else may spell 64000. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 64_000;

/** Below this a turn cannot produce a usable tool call; never clamp under it. */
export const MIN_MAX_OUTPUT_TOKENS = 256;

/**
 * Every model in the supported set accepts at least this. Used when recovery
 * cannot parse a real ceiling out of the provider's error.
 */
export const SAFE_FALLBACK_MAX_OUTPUT_TOKENS = 8_192;

/** Anthropic requires max_tokens > thinking.budget_tokens; this is the margin. */
export const THINKING_HEADROOM_TOKENS = 4_096;

/** Sanity ceiling for a hand-edited config file. */
export const ABSOLUTE_MAX_OUTPUT_TOKENS = 200_000;

/** Subtracted from a context-window computation so the estimate may be wrong. */
export const CONTEXT_SAFETY_MARGIN_TOKENS = 1_024;

/**
 * Anthropic's floor for `thinking.budget_tokens`. A downgrade that lands below
 * it is illegal, so the resolver returns `thinkingBudget: 0` instead and the
 * adapter omits the block entirely.
 */
export const MIN_THINKING_BUDGET_TOKENS = 1_024;

// ---------------------------------------------------------------------------
// Static ceiling table
// ---------------------------------------------------------------------------

interface CeilingRule {
  pattern: RegExp;
  ceiling: number;
}

/**
 * Ordered; FIRST MATCH WINS. Matched against the model id lowercased with any
 * `models/` prefix stripped (Google returns `models/gemini-1.5-pro`).
 *
 * ORDER IS LOAD-BEARING, not cosmetic: `claude-3-7-sonnet` also matches the
 * broad `^claude-3(-|\.)` rule, so the specific 3.7 entry has to come first or
 * it is dead code and every 3.7 request is clamped to 8192 (see the design's
 * "Issues found during implementation" note).
 */
const CEILING_TABLE: Record<string, CeilingRule[]> = {
  anthropic: [
    { pattern: /^claude-3-7-sonnet/, ceiling: 64_000 },
    { pattern: /^claude-3-5-sonnet/, ceiling: 8_192 },
    { pattern: /^claude-3(-|\.)/, ceiling: 8_192 },
    { pattern: /^claude-opus-4-(0|1)\b/, ceiling: 32_000 },
    { pattern: /^claude-(sonnet|haiku|opus)-4/, ceiling: 64_000 },
  ],
  openai: [
    { pattern: /^(o1|o3|o4)-mini/, ceiling: 65_536 },
    { pattern: /^(o1|o3|o4)\b/, ceiling: 100_000 },
    { pattern: /^gpt-5/, ceiling: 128_000 },
    { pattern: /^gpt-4\.1/, ceiling: 32_768 },
    { pattern: /^gpt-4o/, ceiling: 16_384 },
    { pattern: /^gpt-4(-turbo)?$/, ceiling: 4_096 },
    { pattern: /^gpt-3\.5/, ceiling: 4_096 },
  ],
  google: [
    { pattern: /^gemini-1\.5/, ceiling: 8_192 },
    { pattern: /^gemini-2\.0-flash/, ceiling: 8_192 },
    { pattern: /^gemini-2\.5/, ceiling: 65_536 },
  ],
};

/** Lowercase and strip Google's `models/` prefix so one key shape is used everywhere. */
export function normalizeModelId(modelId: string): string {
  return String(modelId ?? '').trim().toLowerCase().replace(/^models\//, '');
}

/**
 * The statically known output ceiling for a model, or `undefined`.
 *
 * A MISS RETURNS `undefined`, NOT A NUMBER. "Unknown" and "small" must stay
 * distinguishable: an unknown model gets the product default and, if that is
 * wrong, recovery fixes it. Baking a pessimistic 8192 into every unrecognised id
 * would silently halve the output of every proxy user.
 */
export function staticCeilingFor(providerId: string, modelId: string): number | undefined {
  const rules = CEILING_TABLE[String(providerId ?? '').toLowerCase()];
  if (!rules) return undefined;
  const id = normalizeModelId(modelId);
  if (id.length === 0) return undefined;
  for (const rule of rules) {
    if (rule.pattern.test(id)) return rule.ceiling;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Learned ceilings
// ---------------------------------------------------------------------------

export type CeilingSource = 'catalog' | 'discovery' | 'error';

/** `'error'` outranks everything because it came from the API itself. */
const RANK: Record<CeilingSource, number> = { catalog: 1, discovery: 2, error: 3 };

interface LearnedCeiling {
  ceiling: number;
  source: CeilingSource;
}

/** Process-lifetime only; never persisted. Key: `${providerId}:${normalizedModelId}`. */
const learnedCeilings = new Map<string, LearnedCeiling>();

function ceilingKey(providerId: string, modelId: string): string {
  return `${String(providerId ?? '').toLowerCase()}:${normalizeModelId(modelId)}`;
}

/** Record a ceiling. A lower-ranked source never overwrites a higher-ranked one. */
export function learnModelCeiling(
  providerId: string,
  modelId: string,
  ceiling: number,
  source: CeilingSource,
): void {
  if (!Number.isFinite(ceiling) || ceiling <= 0) return;
  const key = ceilingKey(providerId, modelId);
  if (key.endsWith(':')) return; // no model id — nothing worth remembering
  const existing = learnedCeilings.get(key);
  if (existing && RANK[existing.source] > RANK[source]) return;
  learnedCeilings.set(key, { ceiling: Math.floor(ceiling), source });
}

export function getLearnedCeiling(
  providerId: string,
  modelId: string,
): LearnedCeiling | undefined {
  return learnedCeilings.get(ceilingKey(providerId, modelId));
}

/** Test hook. MUST be called from `afterEach` in every test that learns. */
export function clearLearnedCeilings(): void {
  learnedCeilings.clear();
}

// ---------------------------------------------------------------------------
// The resolver
// ---------------------------------------------------------------------------

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

/** OpenAI charges `max_tokens` against the context window; the others do not. */
function providerUsesContextSum(providerId: string): boolean {
  return String(providerId ?? '').toLowerCase() === 'openai';
}

/** Step 1: the strongest ceiling anyone knows about, or `undefined`. */
function resolveCeiling(input: OutputLimitInput): number | undefined {
  const learned = getLearnedCeiling(input.providerId, input.modelId);
  if (learned) return learned.ceiling;
  const declared = input.modelLimits?.maxOutputTokens;
  if (typeof declared === 'number' && Number.isFinite(declared) && declared > 0) {
    return Math.floor(declared);
  }
  return staticCeilingFor(input.providerId, input.modelId);
}

/** Step 4: `max_tokens + prompt <= context` on the providers that enforce it. */
function contextBound(input: OutputLimitInput): number | undefined {
  if (!providerUsesContextSum(input.providerId)) return undefined;
  const window = input.modelLimits?.contextWindow;
  const prompt = input.estimatedPromptTokens;
  if (typeof window !== 'number' || !Number.isFinite(window) || window <= 0) return undefined;
  if (typeof prompt !== 'number' || !Number.isFinite(prompt) || prompt < 0) return undefined;
  return window - prompt - CONTEXT_SAFETY_MARGIN_TOKENS;
}

/**
 * Step 6: keep Anthropic's `max_tokens > thinking.budget_tokens` invariant.
 *
 * Returns the (possibly raised) cap and the budget to send. A returned budget of
 * `0` means "omit the thinking block entirely" — `budget_tokens` has a hard floor
 * of 1024 and sending less is illegal, so refusing to think is the only legal
 * move left on a model whose ceiling cannot house both.
 */
function fitThinking(
  value: number,
  thinkingBudget: number,
  ceiling: number | undefined,
): { value: number; thinkingBudget?: number } {
  if (thinkingBudget <= 0 || value > thinkingBudget) return { value };

  const raised = Math.min(ceiling ?? Number.POSITIVE_INFINITY, thinkingBudget + THINKING_HEADROOM_TOKENS);
  if (raised > thinkingBudget) return { value: raised };

  const lowered = Math.max(MIN_THINKING_BUDGET_TOKENS, raised - THINKING_HEADROOM_TOKENS);
  if (lowered < raised) return { value: raised, thinkingBudget: lowered };
  return { value: raised, thinkingBudget: 0 };
}

/**
 * Resolve the output-token cap for one request.
 *
 * Pure apart from reading the learned map. Never throws, never returns `NaN`,
 * `0` or a negative.
 */
export function resolveOutputTokens(input: OutputLimitInput): OutputLimitResolution {
  const ceiling = resolveCeiling(input);
  const requested =
    typeof input.requested === 'number' && Number.isFinite(input.requested) && input.requested > 0
      ? Math.floor(input.requested)
      : undefined;

  // AUTO NEVER EXCEEDS THE PRODUCT DEFAULT, even when the model would allow
  // 100000: on OpenAI `max_tokens` is charged against the context window, so an
  // AUTO of 100000 would make long conversations fail with a context error. An
  // explicit `requested` may exceed 64000 up to the ceiling — the user's call.
  //
  // The AMBITION is kept separate from the clamp on purpose. Folding the ceiling
  // into the AUTO base (`min(DEFAULT, ceiling)`) yields the same number but
  // leaves `clampedBy` unset, and `clampedBy` is what the settings preview and
  // the one-time warning are built on: the user would see a bare
  // `Effective: 16384` with nothing saying where the other 47616 went.
  const ambition = requested ?? DEFAULT_MAX_OUTPUT_TOKENS;

  let value = ambition;
  let clampedBy: OutputLimitResolution['clampedBy'];

  if (ceiling !== undefined && ceiling < value) {
    value = ceiling;
    clampedBy = 'ceiling';
  }

  const bound = contextBound(input);
  if (bound !== undefined && bound < value) {
    value = bound;
    clampedBy = 'context';
  }

  if (value > ABSOLUTE_MAX_OUTPUT_TOKENS) {
    value = ABSOLUTE_MAX_OUTPUT_TOKENS;
    clampedBy = 'absolute';
  }

  const fitted = fitThinking(value, input.thinkingBudget ?? 0, ceiling);
  value = Math.floor(Math.max(fitted.value, MIN_MAX_OUTPUT_TOKENS));

  return {
    value,
    ...(ceiling !== undefined ? { ceiling } : {}),
    source: requested !== undefined ? 'requested' : 'auto',
    ...(clampedBy ? { clampedBy } : {}),
    ...(fitted.thinkingBudget !== undefined ? { thinkingBudget: fitted.thinkingBudget } : {}),
  };
}

// ---------------------------------------------------------------------------
// Prompt estimation
// ---------------------------------------------------------------------------

/**
 * Average characters per token across the model families this package speaks to.
 *
 * EXPORTED (context-auto-compaction P2-3). It was module-private, which would
 * have forced the CLI's compaction digest to grow a second copy for its budget
 * arithmetic — two chars-per-token constants that must agree and nothing
 * checking that they do is exactly how a digest budget and an occupancy estimate
 * drift apart. No behaviour change here.
 */
export const CHARS_PER_TOKEN = 4;
/** Role markers, separators and tool-call scaffolding, per message. */
const PER_MESSAGE_OVERHEAD_TOKENS = 4;

function partLength(content: unknown): number {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const part of content as Array<Record<string, unknown>>) {
    if (typeof part?.text === 'string') total += part.text.length;
    // Base64 image payloads are counted at a flat rate rather than by length:
    // their character count says nothing useful about their token cost.
    else if (part?.type === 'image') total += CHARS_PER_TOKEN * 256;
  }
  return total;
}

function messageLength(message: Message): number {
  if (message.role === 'assistant') {
    let total = 0;
    for (const block of message.content) {
      if (block.type === 'text' || block.type === 'thinking') total += block.text.length;
      else if (block.type === 'tool_call') total += JSON.stringify(block.args ?? {}).length;
    }
    return total;
  }
  return partLength(message.content);
}

/**
 * Deliberately crude: ~4 chars/token plus per-message framing. Used ONLY to keep
 * `max_tokens + prompt <= context` on OpenAI, where being 20 % wrong is absorbed
 * by `CONTEXT_SAFETY_MARGIN_TOKENS` and, failing that, by `context_sum` recovery.
 *
 * No tokenizer dependency is added on purpose — this is a guard rail, not an
 * accounting function.
 */
export function estimatePromptTokens(messages: Message[], systemPrompt?: string): number {
  let chars = systemPrompt ? systemPrompt.length : 0;
  let overhead = 0;
  for (const message of messages ?? []) {
    chars += messageLength(message);
    overhead += PER_MESSAGE_OVERHEAD_TOKENS;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN) + overhead;
}
