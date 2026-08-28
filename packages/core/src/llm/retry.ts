/**
 * Retry & exponential backoff — THE authority for "a provider call failed, now
 * what" (llm-api-retry-backoff §4).
 *
 * One module owns the policy type, the classification predicate, the backoff
 * arithmetic and a single generator `withRetry()` that wraps ANY
 * `AsyncIterableIterator<StreamEvent>`. `ProviderRegistry.stream()` applies it,
 * so all three adapters, the lead agent and every subagent inherit retry with
 * zero call-site changes.
 *
 * THE WRAPPER IS THE ONLY LAYER THAT CAN DO THIS JOB, and that is why it lives
 * here rather than in the adapters or in `runAgentLoop` (§3.1 / §3.2):
 *
 *   - it knows whether any CONTENT has already been forwarded downstream (the
 *     commit point), which decides whether a replay would duplicate text on the
 *     user's screen;
 *   - it holds the `AbortSignal`, which is what keeps a user pressing Esc from
 *     being mistaken for a retryable timeout;
 *   - it can emit its own events, which is what turns a silent 40-second stall
 *     into a countdown a user can read.
 *
 * NO `node:*` IMPORTS. `no-host-coupling.test.ts` rule 2 bans every one of them
 * under core `src/` with a single grandfathered exception, so the abortable
 * `sleep` below uses the GLOBAL `setTimeout` plus one `abort` listener rather
 * than `node:timers/promises` (whose `setTimeout` takes `{ signal }` natively
 * and would be the idiomatic choice anywhere else).
 */

import type { LLMErrorType } from './provider.js';
import { LLMError } from './provider.js';
import type { StreamEvent } from './types.js';

// ---------------------------------------------------------------------------
// Structural bounds
// ---------------------------------------------------------------------------

/**
 * Structural bounds. NOT user policy: these describe what the mechanism can
 * physically do, and a hand-edited config must not be able to exceed them.
 * (The same split `TEAM_LIMITS` states for team mode, one package over.)
 *
 * ENFORCED AT THIS BOUNDARY by `normalizePolicy`, not only by the CLI's
 * `clampRetryConfig` (§4.5 G4). Hardening one path and leaving the other open
 * would let an embedder passing `{ maxRetries: 5000 }` get 5000.
 */
export const RETRY_LIMITS = {
  /** Ceiling on `maxRetries` from any layer. */
  hardMaxRetries: 20,
  /** Ceiling on one wait, whatever the config or a `Retry-After` header says. */
  absoluteMaxDelayMs: 120_000,
  /**
   * A `Retry-After` LARGER than this is not honoured and not retried — it is
   * surfaced immediately with the provider's own number in the message. A
   * provider asking us to come back in an hour is telling the user something,
   * and silently wedging the terminal for an hour is not relaying it.
   */
  retryAfterCeilingMs: 60_000,
  /** Floor under any computed wait, so jitter can never produce a 0 ms "retry". */
  minDelayMs: 100,
} as const;

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export interface RetryPolicy {
  /** Retries AFTER the initial attempt. `10` => up to 11 total requests. */
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  /** Growth factor per retry. `2` doubles. */
  multiplier: number;
  /** Equal jitter (`d/2 + rand*d/2`). See `computeBackoffDelay` for why not full. */
  jitter: boolean;
  /** Honour `Retry-After` / `anthropic-ratelimit-*-reset` when present. */
  respectRetryAfter: boolean;
  /** Wall-clock budget from the FIRST failure of this request. */
  maxElapsedMs: number;
  /** Allow a restart after content has already been forwarded (§3.5). */
  onPartialStream: boolean;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 10,
  initialDelayMs: 1_000,
  /**
   * Core's default `idleTimeout` is 60 000 ms. Even with the watchdog pause of
   * §4.6 in place, a single wait longer than half the idle window is a design
   * smell: it means the mechanism depends on the pause being correct rather
   * than merely benefiting from it. Two independent guards, and the numeric one
   * costs nothing.
   */
  maxDelayMs: 30_000,
  multiplier: 2,
  jitter: true,
  respectRetryAfter: true,
  /**
   * 240 s, NOT 300 s. The CLI's `DEFAULT_TEAM_CONFIG.subagentTimeoutMs` is
   * 300 000, and a retry budget EQUAL to the per-child timeout means the child
   * is killed at the same instant its ladder ends — the user is then told
   * "subagent timed out" for what was a provider outage. 240 s fits the full
   * ten-step ladder (181 s worst case) with 59 s of headroom and still leaves
   * the child 60 s of its own window to actually produce an answer.
   *
   * THE INVARIANT IS `maxElapsedMs + one model round-trip <
   * team.subagentTimeoutMs` (§5.6). It is invisible at both edit sites, so the
   * CLI's `retry-config.test.ts` pins the inequality statically.
   */
  maxElapsedMs: 240_000,
  onPartialStream: true,
};

/**
 * The events that mean "the consumer has already rendered answer content", i.e.
 * the commit point (§4.5a).
 *
 * `thinking_start` is in the set even though it carries no text: it flips
 * `thinkingOpen` in the CLI reducer, which is visible state a restart must
 * rewind. The tool events are in the set because `tool_call_start` appends a
 * transcript card — that is why `stream_restart` carries `discardedToolCallIds`
 * at all. `done` and `error` are terminal, not content; the three `retry_*`
 * variants are ours and never round-trip through `makeStream()`.
 */
export const CONTENT_EVENTS: ReadonlySet<StreamEvent['type']> = new Set<StreamEvent['type']>([
  'text_delta',
  'thinking_start',
  'thinking_delta',
  'tool_call_start',
  'tool_call_delta',
  'tool_call_end',
]);

// ---------------------------------------------------------------------------
// normalizePolicy
// ---------------------------------------------------------------------------

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Clamp a policy to `RETRY_LIMITS`. Pure, total, and it NEVER THROWS — a bad
 * policy is corrected rather than rejected, because the alternative is a
 * library that crashes on a config typo.
 *
 * Module-internal by intent: exported so `llm-retry.test.ts` may import it
 * directly, but deliberately NOT re-exported from the barrel. The public
 * assertion is made THROUGH `withRetry`, which is also the only way to catch
 * this being present but unwired.
 */
export function normalizePolicy(policy: RetryPolicy): RetryPolicy {
  const maxRetries = Math.min(
    RETRY_LIMITS.hardMaxRetries,
    Math.max(0, Math.floor(finiteOr(policy.maxRetries, DEFAULT_RETRY_POLICY.maxRetries))),
  );
  const maxDelayMs = Math.min(
    RETRY_LIMITS.absoluteMaxDelayMs,
    Math.max(
      RETRY_LIMITS.minDelayMs,
      Math.floor(finiteOr(policy.maxDelayMs, DEFAULT_RETRY_POLICY.maxDelayMs)),
    ),
  );
  const initialDelayMs = Math.min(
    maxDelayMs,
    Math.max(
      RETRY_LIMITS.minDelayMs,
      Math.floor(finiteOr(policy.initialDelayMs, DEFAULT_RETRY_POLICY.initialDelayMs)),
    ),
  );
  const multiplier = Math.max(1, finiteOr(policy.multiplier, DEFAULT_RETRY_POLICY.multiplier));
  /**
   * FLOORED AT `minDelayMs`, NOT AT `initialDelayMs`.
   *
   * `>= initialDelayMs` reads like the tighter bound and is the wrong one: it
   * would make "give up after 500 ms in total" unexpressible by silently raising
   * the budget to the first delay, at which point the first retry always fires —
   * so a budget SMALLER than one wait would stop being a budget at all, silently.
   * The CLI's own range for this key already starts at 10 000, so nothing a user
   * can type reaches the difference; what does reach it is a unit test asserting
   * that the budget is evaluated on the FIRST failure, which is the one property
   * a mis-ordered implementation gets wrong. See the spec's implementation-findings
   * section (IF-2).
   */
  const maxElapsedMs = Math.max(
    RETRY_LIMITS.minDelayMs,
    Math.floor(finiteOr(policy.maxElapsedMs, DEFAULT_RETRY_POLICY.maxElapsedMs)),
  );
  return {
    maxRetries,
    initialDelayMs,
    maxDelayMs,
    multiplier,
    jitter: policy.jitter !== false,
    respectRetryAfter: policy.respectRetryAfter !== false,
    maxElapsedMs,
    onPartialStream: policy.onPartialStream !== false,
  };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export interface RetryDecision {
  retry: boolean;
  /** Machine reason, for logs and for the acceptance tests. */
  reason:
    | 'retryable'
    | 'aborted'
    | 'not_retryable'
    | 'budget_exhausted'
    | 'attempts_exhausted'
    | 'committed'
    | 'retry_after_too_long';
}

/**
 * Whether this failure may be retried at all, ignoring budgets and counters.
 *
 * THE ORDER OF THE TWO CHECKS IS LOAD-BEARING.
 *
 * 1. `signal?.aborted === true` COMES FIRST. `wrapFetchError` classifies an
 *    `AbortError` as `errorType: 'timeout', retryable: true`, so every user Esc,
 *    every `AgentController.abort()`, every dispatch timeout and every
 *    tool-timeout cancellation arrives here wearing a retryable badge. The CLI's
 *    `team/retry.ts` records this trap in thirty lines of comment because it
 *    cost someone an afternoon; reading the signal BEFORE `err.retryable` is
 *    what makes Esc mean Esc.
 * 2. `retryable` is read STRUCTURALLY, never with `instanceof LLMError`. The
 *    error crosses a package boundary, and a duplicated core instance (a linked
 *    checkout, a hoisting accident) would make `instanceof` false while the
 *    field is plainly there — and the failure mode would be "retries silently
 *    stopped happening". This is the rule `isRetryableStreamError` and
 *    `formatStreamError` already follow.
 */
export function isRetryableError(err: unknown, signal?: AbortSignal): RetryDecision {
  if (signal?.aborted === true) return { retry: false, reason: 'aborted' };
  if ((err as { retryable?: unknown } | null | undefined)?.retryable !== true) {
    return { retry: false, reason: 'not_retryable' };
  }
  return { retry: true, reason: 'retryable' };
}

interface DecideInput {
  error: unknown;
  signal?: AbortSignal;
  /** Any content event was forwarded during the failed attempt. */
  committed: boolean;
  /** Retries COMPLETED so far (pre-increment). */
  retryIndex: number;
  /** Anchored on the FIRST failure of this request; a number by construction. */
  firstFailureAt: number;
  /** The wait that WOULD be used for the next attempt. */
  candidateDelay: number;
  retryAfterMs?: number;
  policy: RetryPolicy;
  now: () => number;
}

/**
 * The retry decision, taking every input EXPLICITLY — no closure reads — and
 * returning the first matching reason (§4.5).
 *
 * Module-internal by intent, like `normalizePolicy` above.
 */
export function decide(input: DecideInput): RetryDecision {
  const base = isRetryableError(input.error, input.signal);
  if (!base.retry) return base;

  if (input.committed && !input.policy.onPartialStream) {
    return { retry: false, reason: 'committed' };
  }
  // PRE-INCREMENT, so `maxRetries: 10` permits retries at `retryIndex` 0...9 and
  // stops the 11th failure.
  if (input.retryIndex >= input.policy.maxRetries) {
    return { retry: false, reason: 'attempts_exhausted' };
  }
  // `firstFailureAt` is a number by construction — the caller anchors it BEFORE
  // deriving `candidateDelay` and before calling here. An ordering that read it
  // first would compute `NaN`, and `NaN > maxElapsedMs` is `false`: a budget
  // that never triggers, silently.
  if (input.now() - input.firstFailureAt + input.candidateDelay > input.policy.maxElapsedMs) {
    return { retry: false, reason: 'budget_exhausted' };
  }
  if (
    input.retryAfterMs !== undefined &&
    input.retryAfterMs > RETRY_LIMITS.retryAfterCeilingMs
  ) {
    return { retry: false, reason: 'retry_after_too_long' };
  }
  return { retry: true, reason: 'retryable' };
}

// ---------------------------------------------------------------------------
// Backoff arithmetic
// ---------------------------------------------------------------------------

/**
 * The wait before retry number `retryIndex` (1-BASED: the first retry is 1).
 *
 * EQUAL JITTER, NOT FULL JITTER. Full jitter (`rand() * base`) is the textbook
 * contention minimiser, but it can return 40 ms on the sixth retry, and a UI
 * that just announced "retrying in 30s" and then fires in 40 ms reads as a bug.
 * Equal jitter keeps the announced number within a factor of two of the truth
 * while still de-correlating N concurrent subagents hitting the same 429. The
 * user-visible countdown is computed from the ACTUAL chosen delay, never from
 * `base`, so what the card says is always what happens.
 */
export function computeBackoffDelay(
  retryIndex: number,
  policy: RetryPolicy,
  opts?: { retryAfterMs?: number; random?: () => number },
): number {
  const rand = opts?.random ?? Math.random;
  const raw = policy.initialDelayMs * Math.pow(policy.multiplier, Math.max(0, retryIndex - 1));
  const base = Math.min(raw, policy.maxDelayMs, RETRY_LIMITS.absoluteMaxDelayMs);
  const jittered = policy.jitter ? base / 2 + rand() * (base / 2) : base;

  // MAX, not replace. A `Retry-After: 1` arriving on the ninth retry must not
  // undo eight retries' worth of backoff — the server is stating a FLOOR ("not
  // before this"), not a ceiling.
  const withHeader =
    policy.respectRetryAfter && opts?.retryAfterMs !== undefined
      ? Math.max(jittered, opts.retryAfterMs)
      : jittered;

  return Math.round(
    Math.min(Math.max(withHeader, RETRY_LIMITS.minDelayMs), RETRY_LIMITS.absoluteMaxDelayMs),
  );
}

// ---------------------------------------------------------------------------
// Retry-After parsing
// ---------------------------------------------------------------------------

/** Seconds-or-HTTP-date -> ms, or `undefined` when unusable. Never negative. */
function parseDelaySeconds(raw: string | null, now: () => number): number | undefined {
  if (raw === null) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const seconds = Number.parseFloat(trimmed);
    if (!Number.isFinite(seconds)) return undefined;
    return Math.max(0, Math.round(seconds * 1000));
  }
  return parseInstant(trimmed, now);
}

/** An RFC-3339 / HTTP-date instant -> ms from now, or `undefined`. Never negative. */
function parseInstant(raw: string, now: () => number): number | undefined {
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) return undefined;
  return Math.max(0, Math.round(at - now()));
}

/**
 * The server-stated wait, in ms, or `undefined` when absent or unparseable.
 *
 * Read order: `retry-after` (integer seconds, or an HTTP-date), then
 * `x-ratelimit-reset-after` (seconds, OpenAI-flavoured), then
 * `anthropic-ratelimit-requests-reset`, then
 * `anthropic-ratelimit-input-tokens-reset` (both RFC-3339 instants).
 *
 * THE TOKEN HEADER IS READ, not skipped: on a long context it is the limit that
 * actually bites, and a request throttled on tokens that waits out only the
 * REQUEST window comes back to the same 429.
 *
 * A value above `RETRY_LIMITS.retryAfterCeilingMs` is returned AS-IS — the
 * CALLER (`withRetry`) decides to stop, so the honest number reaches the user's
 * error message rather than being silently rounded down to a wait we would then
 * actually perform.
 */
export function parseRetryAfterMs(
  headers: Headers | undefined,
  now: () => number = Date.now,
): number | undefined {
  if (!headers || typeof headers.get !== 'function') return undefined;
  const direct = parseDelaySeconds(headers.get('retry-after'), now);
  if (direct !== undefined) return direct;
  const openai = parseDelaySeconds(headers.get('x-ratelimit-reset-after'), now);
  if (openai !== undefined) return openai;
  const requests = headers.get('anthropic-ratelimit-requests-reset');
  if (requests !== null && requests.trim().length > 0) {
    const parsed = parseInstant(requests.trim(), now);
    if (parsed !== undefined) return parsed;
  }
  const inputTokens = headers.get('anthropic-ratelimit-input-tokens-reset');
  if (inputTokens !== null && inputTokens.trim().length > 0) {
    const parsed = parseInstant(inputTokens.trim(), now);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// withRetry
// ---------------------------------------------------------------------------

export interface WithRetryOptions {
  policy: RetryPolicy;
  providerId: string;
  modelId: string;
  signal?: AbortSignal;
  /** All three injected so tests are deterministic and never sleep. */
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

/**
 * Sleep, resolving on EITHER the timer or the signal's `abort` event.
 *
 * A bare `setTimeout` would make Esc take up to 30 s to be felt, which is the
 * single most visible way this feature can be made to feel cheap. The listener
 * is removed on both paths so a long-lived signal does not accumulate them.
 */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

function errorTypeOf(err: unknown): LLMErrorType {
  const t = (err as { errorType?: unknown } | null | undefined)?.errorType;
  return typeof t === 'string' ? (t as LLMErrorType) : 'unknown';
}

function messageOf(err: unknown): string {
  const m = (err as { message?: unknown } | null | undefined)?.message;
  return typeof m === 'string' && m.length > 0 ? m : 'Unknown provider error';
}

function retryAfterOf(err: unknown): number | undefined {
  const v = (err as { retryAfterMs?: unknown } | null | undefined)?.retryAfterMs;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/**
 * Wrap a stream factory with retry.
 *
 * Six properties are load-bearing and easy to break:
 *
 *  - G1 — THE ABORT GUARD IS CHECKED ON EVERY ITERATION, matching
 *    `agent-loop.ts`'s own guard. Combined with G3 below, an aborted request
 *    never forwards a trailing error to a subscriber.
 *  - G2 — `sleep` MUST OBSERVE `signal`. See `defaultSleep`.
 *  - G3 — `aborted` RETURNS SILENTLY. It is the one non-retry reason that must
 *    not `yield` an `error`. `consumeStream` (the body of `complete()`) does not
 *    consult the signal, so a yielded error would become a thrown, FABRICATED
 *    `network_error` on user Esc — blaming the network for something the user
 *    just did is worse than saying nothing. Three silent return sites: the
 *    in-loop guard, the `decide` short-circuit, and the post-sleep check.
 *  - G4 — `normalizePolicy` RUNS ONCE, at generator entry, so `RETRY_LIMITS`
 *    bounds an embedder's policy and not merely a CLI-resolved one.
 *  - THE SUCCESS PATH IS UNTOUCHED. A request that works yields exactly the
 *    events the adapter produced, in the same order, with no extra allocation
 *    beyond one boolean and one empty array. The wrapper is not installed at all
 *    when `maxRetries <= 0`, so an opted-out embedder is byte-identical to a
 *    pre-feature build.
 *  - THE TERMINAL ERROR IS FORWARDED, NOT REPLACED. After exhaustion the
 *    consumer sees the PROVIDER's own `LLMError`, so `formatStreamError`, the
 *    `retryable` field and any downstream `instanceof` continue to behave. Only
 *    the retry COUNT is new information, and it travels on the events.
 */
export async function* withRetry(
  makeStream: () => AsyncIterableIterator<StreamEvent>,
  opts: WithRetryOptions,
): AsyncIterableIterator<StreamEvent> {
  const policy = normalizePolicy(opts.policy);
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;
  const signal = opts.signal;

  let firstFailureAt: number | undefined;
  /** Retries COMPLETED so far. */
  let retryIndex = 0;

  for (;;) {
    let committed = false;
    const toolCallIds: string[] = [];
    let sawDone = false;
    let terminalError: unknown;

    for await (const event of makeStream()) {
      if (signal?.aborted === true) return; // G1
      if (CONTENT_EVENTS.has(event.type)) committed = true;
      if (event.type === 'tool_call_start') toolCallIds.push(event.toolCallId);
      if (event.type === 'error') {
        // NOT FORWARDED YET: whether the consumer ever sees it depends on the
        // decision below. Breaking here also calls the source iterator's
        // `return()`, which runs its `finally` and releases the SSE reader.
        terminalError = event.error;
        break;
      }
      if (event.type === 'done') sawDone = true;
      yield event;
    }

    if (sawDone) return; // success; the hot path ends here

    if (terminalError === undefined) {
      // Defensive only: with the adapters' terminal-sentinel contract in place
      // (§4.5a) every adapter terminates in `done` or `error`. Reaching here
      // means an adapter broke its own contract, and a silent success would be
      // the worst possible reading of that.
      // NAMES THE PROVIDER *AND* THE MODEL. `agent-loop.ts` throws an almost
      // identical sentence one layer up ("LLM stream ended without producing a
      // done event"), and both can reach a user; without the ids the two are
      // indistinguishable in a bug report, and the id is the first thing worth
      // knowing when one adapter of three is misbehaving. This is also the only
      // read of `opts.modelId` — a required option nothing consumes is one the
      // next caller will start passing wrong.
      terminalError = new LLMError(
        `${opts.providerId}/${opts.modelId} stream ended without producing a done or error event`,
        opts.providerId,
        'network_error',
        true,
      );
    }

    // ---- ORDER IS NORMATIVE FROM HERE -----------------------------------
    // 1. Anchor the budget clock on the FIRST failure, before anything reads it.
    firstFailureAt ??= now();
    // 2. Derive the candidate wait for the NEXT attempt. `retryIndex + 1`
    //    because `computeBackoffDelay` is 1-based and `retryIndex` counts
    //    COMPLETED retries.
    const retryAfterMs = policy.respectRetryAfter ? retryAfterOf(terminalError) : undefined;
    const candidateDelay = computeBackoffDelay(retryIndex + 1, policy, {
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      random,
    });
    // 3. Only now can `decide` answer the budget question.
    const decision = decide({
      error: terminalError,
      ...(signal ? { signal } : {}),
      committed,
      retryIndex,
      firstFailureAt,
      candidateDelay,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      policy,
      now,
    });

    if (decision.reason === 'aborted') return; // G3 — no trailing error event

    if (!decision.retry) {
      yield { type: 'error', error: terminalError as Error };
      return;
    }

    retryIndex += 1;
    // What we ANNOUNCE is what we WAIT. Recomputing here would let the card and
    // the timer disagree by a jitter draw.
    const delay = candidateDelay;

    if (committed) {
      yield { type: 'stream_restart', attempt: retryIndex, discardedToolCallIds: toolCallIds };
    }
    yield {
      type: 'retry_scheduled',
      attempt: retryIndex,
      maxRetries: policy.maxRetries,
      delayMs: delay,
      resumeAt: now() + delay,
      errorType: errorTypeOf(terminalError),
      message: messageOf(terminalError),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    };
    await sleep(delay, signal); // G2
    if (signal?.aborted === true) return; // G3 again: silent
    yield { type: 'retry_attempt', attempt: retryIndex, maxRetries: policy.maxRetries };
  }
}
