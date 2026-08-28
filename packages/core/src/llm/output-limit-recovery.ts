/**
 * One-shot self-healing for a request the provider rejected because of the
 * output-token cap.
 *
 * The static table in `output-limits.ts` makes the common case correct without a
 * round trip; this module makes the UNCOMMON case survivable — a proxy, a model
 * that shipped last week, a dialect the heuristic guessed wrong. It reads the
 * true ceiling out of the provider's own error text, repairs the request, sends
 * it EXACTLY ONCE more, and teaches `output-limits.ts` what it learned so the
 * rest of the process gets it right on the first try.
 *
 * TWO CONTRACTS THAT BREAK LOUDLY IF IGNORED:
 *
 *   1. A `Response` body can be read once. `RecoveryAttempt.bodyText` carries the
 *      already-consumed error body; callers MUST pass it on rather than calling
 *      `response.text()` again, which throws `TypeError: Body is unusable`. On
 *      the success path the body is NEVER touched — a streaming response has to
 *      reach the SSE parser intact.
 *
 *   2. Exactly one retry, structurally: `send` is called at most twice and there
 *      is no loop construct in this file. A recovery loop doubles every user's
 *      bill.
 *
 * TEST HYGIENE: `learnTokenField` writes a module-level map with process
 * lifetime. Any test that memoizes a dialect MUST call `clearLearnedTokenFields()`
 * from `afterEach`.
 */

import {
  CONTEXT_SAFETY_MARGIN_TOKENS,
  MIN_MAX_OUTPUT_TOKENS,
  MIN_THINKING_BUDGET_TOKENS,
  SAFE_FALLBACK_MAX_OUTPUT_TOKENS,
  THINKING_HEADROOM_TOKENS,
  learnModelCeiling,
  normalizeModelId,
} from './output-limits.js';

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

export type OutputLimitFailure =
  | { kind: 'exceeds_ceiling'; ceiling?: number }
  | { kind: 'context_sum'; contextWindow?: number; promptTokens?: number }
  | { kind: 'unsupported_field'; expected: 'max_tokens' | 'max_completion_tokens' }
  | { kind: 'thinking_conflict' };

/** The wire name of the field carrying the cap. Google's is a dotted path. */
export type TokenField = 'max_tokens' | 'max_completion_tokens' | 'generationConfig.maxOutputTokens';

const UNSUPPORTED_FIELD_PATTERNS = [
  /unsupported parameter:?\s*'?max_tokens'?/i,
  /use\s+'?max_completion_tokens'?/i,
];

const THINKING_CONFLICT_PATTERN = /max_tokens must be greater than (?:thinking\.)?budget_tokens/i;

/** Numeric ceiling captures, in priority order; group 1 is the real ceiling. */
const CEILING_PATTERNS = [
  /max_tokens:\s*\d+\s*>\s*(\d+),\s*which is the maximum/i,
  /supports at most (\d+) completion tokens/i,
  /exceeds the model limit of (\d+)/i,
];

const CONTEXT_SUM_PATTERN =
  /maximum context length is (\d+) tokens.*?you requested \d+ tokens \((\d+) in the messages/is;

/** Last resort: the provider named the field but gave us no number to work with. */
const GENERIC_LIMIT_PATTERN = /max(?:imum)?[_ ](?:output|completion)[_ ]tokens/i;

function parseCount(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Decide whether a provider rejection was about the output-token cap.
 *
 * ONLY `status === 400` is inspected — every other status is somebody else's
 * problem and repairing the cap would just spend a second round trip to fail the
 * same way.
 */
export function classifyOutputLimitFailure(
  providerId: string,
  status: number,
  body: string,
): OutputLimitFailure | undefined {
  if (status !== 400 || typeof body !== 'string' || body.length === 0) return undefined;
  void providerId; // the patterns are provider-specific but mutually exclusive

  if (UNSUPPORTED_FIELD_PATTERNS.some((p) => p.test(body))) {
    return { kind: 'unsupported_field', expected: 'max_completion_tokens' };
  }
  if (THINKING_CONFLICT_PATTERN.test(body)) return { kind: 'thinking_conflict' };

  for (const pattern of CEILING_PATTERNS) {
    const match = pattern.exec(body);
    if (match) {
      const ceiling = parseCount(match[1]);
      return ceiling === undefined ? { kind: 'exceeds_ceiling' } : { kind: 'exceeds_ceiling', ceiling };
    }
  }

  const ctx = CONTEXT_SUM_PATTERN.exec(body);
  if (ctx) {
    return {
      kind: 'context_sum',
      ...(parseCount(ctx[1]) !== undefined ? { contextWindow: parseCount(ctx[1]) } : {}),
      ...(parseCount(ctx[2]) !== undefined ? { promptTokens: parseCount(ctx[2]) } : {}),
    };
  }

  if (GENERIC_LIMIT_PATTERN.test(body)) return { kind: 'exceeds_ceiling' };
  return undefined;
}

// ---------------------------------------------------------------------------
// Learned token-field dialect
// ---------------------------------------------------------------------------

type OpenAiTokenField = 'max_tokens' | 'max_completion_tokens';

const learnedTokenFields = new Map<string, OpenAiTokenField>();

function fieldKey(providerId: string, modelId: string): string {
  return `${String(providerId ?? '').toLowerCase()}:${normalizeModelId(modelId)}`;
}

/**
 * Remember which parameter name this `provider:model` actually accepts.
 *
 * The heuristic in `openai.ts` is only the first guess; a proxy fronting an
 * o-series model under a `gpt-` alias disagrees with it. One round trip corrects
 * that, permanently for the life of the process.
 */
export function learnTokenField(providerId: string, modelId: string, field: OpenAiTokenField): void {
  learnedTokenFields.set(fieldKey(providerId, modelId), field);
}

export function getLearnedTokenField(
  providerId: string,
  modelId: string,
): OpenAiTokenField | undefined {
  return learnedTokenFields.get(fieldKey(providerId, modelId));
}

/** Test hook. MUST be called from `afterEach` in every test that memoizes a dialect. */
export function clearLearnedTokenFields(): void {
  learnedTokenFields.clear();
}

// ---------------------------------------------------------------------------
// Body field access (Google's field is a dotted path)
// ---------------------------------------------------------------------------

function readTokenValue(body: Record<string, unknown>, field: TokenField): number | undefined {
  if (field !== 'generationConfig.maxOutputTokens') {
    const v = body[field];
    return typeof v === 'number' ? v : undefined;
  }
  const nested = body.generationConfig as Record<string, unknown> | undefined;
  const v = nested?.maxOutputTokens;
  return typeof v === 'number' ? v : undefined;
}

function withTokenValue(
  body: Record<string, unknown>,
  field: TokenField,
  value: number,
): Record<string, unknown> {
  if (field !== 'generationConfig.maxOutputTokens') {
    return { ...body, [field]: value };
  }
  const nested = (body.generationConfig ?? {}) as Record<string, unknown>;
  return { ...body, generationConfig: { ...nested, maxOutputTokens: value } };
}

function readThinkingBudget(body: Record<string, unknown>): number | undefined {
  const thinking = body.thinking as Record<string, unknown> | undefined;
  const v = thinking?.budget_tokens;
  return typeof v === 'number' ? v : undefined;
}

// ---------------------------------------------------------------------------
// Repair
// ---------------------------------------------------------------------------

interface RepairPlan {
  body: Record<string, unknown>;
  from: number;
  to: number;
  /**
   * What actually changed, in the words the user reads in the transcript.
   *
   * Carried per repair because `from`/`to` alone do not describe every branch:
   * a field RENAME leaves the number untouched, so rendering it generically
   * produces `output cap adjusted 64000 -> 64000`, which reads as a bug in the
   * one line whose whole job is to explain what happened.
   */
  summary: string;
}

function repairCeiling(
  ctx: { providerId: string; modelId: string; body: Record<string, unknown>; field: TokenField },
  current: number,
  ceiling: number | undefined,
): RepairPlan | undefined {
  const target = Math.max(
    MIN_MAX_OUTPUT_TOKENS,
    ceiling ?? Math.min(current, SAFE_FALLBACK_MAX_OUTPUT_TOKENS),
  );
  if (target >= current) return undefined;
  learnModelCeiling(ctx.providerId, ctx.modelId, target, 'error');
  return {
    body: withTokenValue(ctx.body, ctx.field, target),
    from: current,
    to: target,
    summary: `output cap ${current} -> ${target}`,
  };
}

function repairContextSum(
  ctx: { body: Record<string, unknown>; field: TokenField },
  current: number,
  failure: Extract<OutputLimitFailure, { kind: 'context_sum' }>,
): RepairPlan | undefined {
  const window = failure.contextWindow;
  const prompt = failure.promptTokens;
  if (window === undefined || prompt === undefined) return undefined;
  // NOT learned: a context-sum failure is conversation-specific, not a property
  // of the model, and recording it as a ceiling would cap every later turn.
  const target = Math.max(MIN_MAX_OUTPUT_TOKENS, window - prompt - CONTEXT_SAFETY_MARGIN_TOKENS);
  if (target >= current) return undefined;
  return {
    body: withTokenValue(ctx.body, ctx.field, target),
    from: current,
    to: target,
    summary: `output cap ${current} -> ${target} to fit the context window`,
  };
}

function repairThinkingConflict(
  ctx: { body: Record<string, unknown>; field: TokenField },
  current: number,
): RepairPlan | undefined {
  const budget = readThinkingBudget(ctx.body);
  if (budget === undefined || budget <= 0) return undefined;
  const raised = budget + THINKING_HEADROOM_TOKENS;
  if (raised > current) {
    return {
      body: withTokenValue(ctx.body, ctx.field, raised),
      from: current,
      to: raised,
      summary: `output cap ${current} -> ${raised} to clear the thinking budget`,
    };
  }
  // The ceiling forbids raising the cap, so lower the budget instead.
  const lowered = Math.max(MIN_THINKING_BUDGET_TOKENS, current - THINKING_HEADROOM_TOKENS);
  if (lowered >= current) return undefined;
  const thinking = ctx.body.thinking as Record<string, unknown>;
  return {
    body: { ...ctx.body, thinking: { ...thinking, budget_tokens: lowered } },
    from: budget,
    to: lowered,
    // `from`/`to` are the BUDGET here, not the cap — the cap is what could not
    // move. Saying "output cap" would name the wrong number.
    summary: `thinking budget ${budget} -> ${lowered}`,
  };
}

// ---------------------------------------------------------------------------
// sendWithOutputLimitRecovery
// ---------------------------------------------------------------------------

export interface RecoveryAttempt {
  response: Response;
  /** The 400 body, ALREADY CONSUMED. Callers must not call `response.text()`. */
  bodyText: string;
  adjustment?: { from: number; to: number; reason: OutputLimitFailure['kind'] };
}

export interface RecoveryOptions {
  providerId: string;
  modelId: string;
  body: Record<string, unknown>;
  tokenField: TokenField;
  send: (body: Record<string, unknown>) => Promise<Response>;
}

function planRepair(
  opts: RecoveryOptions,
  failure: OutputLimitFailure,
): RepairPlan | undefined {
  const current = readTokenValue(opts.body, opts.tokenField);
  const ctx = {
    providerId: opts.providerId,
    modelId: opts.modelId,
    body: opts.body,
    field: opts.tokenField,
  };

  if (failure.kind === 'unsupported_field') {
    if (opts.tokenField === 'generationConfig.maxOutputTokens') return undefined;
    if (opts.tokenField === failure.expected) return undefined;
    learnTokenField(opts.providerId, opts.modelId, failure.expected);
    const renamed = { ...opts.body };
    delete renamed[opts.tokenField];
    // The reasoning family rejects `temperature` for the same reason it rejects
    // `max_tokens`; leaving it behind just buys a second 400 on a different key.
    delete renamed.temperature;
    renamed[failure.expected] = current ?? MIN_MAX_OUTPUT_TOKENS;
    return {
      body: renamed,
      from: current ?? 0,
      to: current ?? 0,
      summary: `token parameter ${opts.tokenField} -> ${failure.expected}`,
    };
  }

  if (current === undefined) return undefined;
  if (failure.kind === 'thinking_conflict') return repairThinkingConflict(ctx, current);
  if (failure.kind === 'context_sum') return repairContextSum(ctx, current, failure);
  return repairCeiling(ctx, current, failure.ceiling);
}

/**
 * Send a request, and on an output-limit 400 repair it and send it once more.
 *
 * The hot path is untouched: a 2xx returns immediately with an unread body.
 */
export async function sendWithOutputLimitRecovery(opts: RecoveryOptions): Promise<RecoveryAttempt> {
  const first = await opts.send(opts.body);
  // The body is NOT read here — a streaming response must reach the SSE parser
  // intact, and `bodyUsed` would already be true if we peeked.
  if (first.ok) return { response: first, bodyText: '' };

  const bodyText = await first.text().catch(() => '');
  const failure = classifyOutputLimitFailure(opts.providerId, first.status, bodyText);
  if (!failure) return { response: first, bodyText };

  const plan = planRepair(opts, failure);
  if (!plan) return { response: first, bodyText };

  const second = await opts.send(plan.body);
  const adjustment = { from: plan.from, to: plan.to, reason: failure.kind };
  if (!second.ok) {
    // A second failure surfaces exactly as it would have without recovery.
    return { response: second, bodyText: await second.text().catch(() => ''), adjustment };
  }

  warnAdjusted(opts.providerId, opts.modelId, plan.summary, failure.kind);
  return { response: second, bodyText: '', adjustment };
}

/** Display names for the adapters this package ships; `Openai` reads as a typo. */
const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
};

/**
 * Core has no logger and must not acquire one (that would be host coupling), so
 * this is `console.warn` — exactly what `anthropic.ts` already does for a
 * malformed tool call. In the CLI it reaches the transcript through the console
 * bridge; in a headless embedder it is a plain warning.
 */
function warnAdjusted(
  providerId: string,
  modelId: string,
  summary: string,
  reason: OutputLimitFailure['kind'],
): void {
  const key = String(providerId ?? '').toLowerCase();
  const name = PROVIDER_LABELS[key] ?? providerId.charAt(0).toUpperCase() + providerId.slice(1);
  console.warn(`[${name}] adjusted ${summary} (${reason}) for ${modelId}`);
}
