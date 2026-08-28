/**
 * CLI-local compaction shapes (context-auto-compaction §5.2 / §3.4.2).
 *
 * ASCII ONLY: `src/compaction/**` is inside the glyph scanner's scope.
 *
 * A CLI-LOCAL EVENT STREAM, like `FastEvent` / `TeamEvent` / `TodoEvent`, for
 * the reason each of those records: core's `AgentEvent` union is a public
 * contract and must not learn host shapes.
 *
 * NOTE THE ASYMMETRY WITH CORE. Core emits the two ENGINE events because the
 * engine is what performs the splice and decides `applied`; the CLI emits the
 * richer ones because only the CLI knows the model name, the price and the
 * session totals.
 *
 * THIS STREAM IS THE SOLE SOURCE OF REDUCER ACTIONS (D-20 / P1-6), and
 * `reduceEvent` gains NO cases for `compaction_start` / `compaction_end`. One
 * compaction arriving through two channels is two transcript cards and a doubled
 * `tokensReclaimed`; `reduceEvent`'s `default: return []` is already exactly
 * right for the two core events, which makes "one authority" also the smallest
 * possible change.
 */

import type { TokenUsage } from '@aragon-agent/core';

/**
 * `relieved` MEANS THE TAIL WAS CLIPPED AND NOTHING WAS DROPPED (hardening
 * RV-5) — the `plan === null` recovery of §3.3.3.
 *
 * IT EXISTS ONLY HERE. The port still reports `'truncated'` for it (DH-5),
 * because the engine's question is narrower: "was this history reduced without a
 * summary", and the answer is yes.
 *
 * WITHOUT IT THE CARD LIES. `detailLine` renders
 * `summarized ${before - after} messages with ${model}` for `'summarized'`, and
 * relief drops NO messages — so a compaction in which no model was called would
 * render "summarized 0 messages with claude-haiku-4-5", in the rare and alarming
 * case the user most needs to read correctly.
 *
 * ANY NEW `switch` ON THIS UNION MUST PAIR ITS BRANCHES. TypeScript finds the
 * exhaustive switches; it does not find an `else` that meant `'summarized'`.
 */
export type CompactionMode = 'summarized' | 'truncated' | 'relieved' | 'none';
/**
 * `manual` exists ONLY here, never in core.
 *
 * The engine's `CompactionTrigger` is `pressure | overflow`, because those are
 * the two the LOOP can originate. A `/compact` while running is queued and then
 * arrives at the loop as an ordinary `pressure` checkpoint, so the distinction
 * is a host-side fact about WHY the flag was set - which is exactly the kind of
 * thing a CLI-local type is for.
 */
export type CompactionUiTrigger = 'pressure' | 'overflow' | 'manual';

/** Whether a figure was measured by the provider or estimated by us. */
export type PressureSource = 'usage' | 'estimate';

export interface Pressure {
  occupied: number;
  contextWindow: number;
  /** `occupied / contextWindow`, clamped to [0, 1]. */
  ratio: number;
  /** `contextWindow - occupied`, floored at 0. */
  headroom: number;
  source: PressureSource;
  /** False when the window came from `buildRuntimeModel`'s 128k placeholder. */
  windowKnown: boolean;
  /**
   * `occupiedTokens(lastUsage) - estimateOf(the history that produced it)`,
   * clamped to `>= 0`, or `undefined` before the first `turn_end`.
   *
   * THE SYSTEMATIC PART OF THE ESTIMATOR'S ERROR (D-23 / P1-11), chiefly the
   * TOOL SCHEMAS. `estimatePromptTokens` counts the system prompt and the message
   * bodies and NOTHING ELSE, while the loop also sends `tools: toolDefs` and the
   * provider's `input_tokens` includes them - several thousand tokens for this
   * CLI's toolset. So the estimate is biased LOW, always, in the one direction
   * that hurts: the resumed 180k-token session is exactly where the estimate is
   * used, and it reads lower than the truth.
   *
   * One shared FUNCTION is not the same as one shared UNIT. Everywhere an
   * estimated figure is compared against a threshold or shown to a user it is
   * `estimate + (estimateOffset ?? 0)`.
   */
  estimateOffset?: number;
  /**
   * Tokens estimated for messages APPENDED AFTER the measurement in `lastUsage`
   * (hardening §3.2 / W1). `0` on the estimate branch, and `0` whenever the
   * recorded prefix is unusable.
   *
   * ALWAYS PRESENT, never optional, so `isApproximate` is a total function and a
   * consumer cannot forget the `?? 0`. `> 0` is what makes the measured branch
   * approximate: the base is the provider's own number for a request that really
   * happened, and this is a guess about messages no request has yet carried.
   */
  deltaTokens: number;
}

/** One compaction, in whatever state it reached. Rendered by `CompactionCard`. */
export interface CompactionRecord {
  /** 1-based within the session, so the card can name itself. */
  index: number;
  trigger: CompactionUiTrigger;
  mode: CompactionMode;
  applied: boolean;
  reason?: string;
  messagesBefore: number;
  messagesAfter: number;
  tokensBefore: number;
  tokensAfter: number;
  summary?: string;
  model: string;
  durationMs: number;
  /** What the summarization call itself spent. */
  usage?: TokenUsage;
  /** Set when an overflow attempt halved `keepRecentTurns` for itself (D-24). */
  keepRecentTurnsUsed?: number;
  /**
   * Present ONLY when tail relief fired (hardening §3.3.4 / W2).
   *
   * A bounded, ANNOUNCED data loss inside the turns the run is about to continue
   * from, so it is disclosed on the card, in `/compact status`, on the JSON
   * stream and in the archive — the honesty rule `truncated` already follows.
   */
  tailRelief?: { messages: number; charsRemoved: number };
  /**
   * The archive file this compaction was written to, for `/compact show`
   * (hardening §3.5 / W4). Absent when `compaction.archive` is off, and absent
   * when the write failed — a best-effort artefact never claims to exist.
   */
  archivePath?: string;
}

/**
 * WHAT DELIBERATELY DOES NOT LIVE ON `CompactionRecord` (hardening RV-3): the
 * dropped `Message[]`.
 *
 * This record is dispatched into the reducer (`App.tsx`'s `compaction_end` case)
 * and retained in view state for the transcript card's lifetime. Hanging a
 * megabyte-scale array off it would park the compacted history in React state
 * and drag it through every subsequent render — an archive feature that creates
 * the leak it audits. The messages travel on `Compactor.takeLastDropped()`
 * instead, which never enters the event stream.
 */

/** Everything `/compact status`, the chip and the settings row read. */
export interface CompactionSnapshot {
  /** Registered AND enabled AND a summarizer model resolves. */
  live: boolean;
  /** The summarizer's model id, or `''`. */
  model: string;
  /**
   * How many compactions ANNOUNCED themselves (quiet-noop §6.2 / D-5).
   *
   * COMPACTIONS THAT RAN, NOT CHECKPOINTS THAT FIRED. A `pressure` compaction
   * that declines before calling a model or changing the history never advances
   * this, which is what keeps the card's `#N` contiguous. `declined` below is
   * the other half of the same total.
   */
  compactions: number;
  /**
   * How many `pressure` checkpoints declined BEFORE committing to any work
   * (quiet-noop D-9 / P1-2).
   *
   * OPTIONAL SO EVERY EXISTING CONSTRUCTION SITE STAYS UNTOUCHED, and rendered
   * by `/compact status` only when non-zero — a healthy session must not read
   * `(0 checkpoints declined)`. This is the one human surface that still speaks
   * about a decline after the transcript went quiet, which is what keeps
   * `context-auto-compaction` §6.5's "guaranteed reporting surface" promise true.
   */
  declined?: number;
  /** Sum of `(tokensBefore - tokensAfter)` over applied compactions. */
  tokensReclaimed: number;
  /** What compaction itself has spent this session. */
  usage: TokenUsage;
  /**
   * CARRIED, NEVER RE-DERIVED (the C-11 / RV-4 lesson from `fast-model-tier`).
   * An unknown model priced at `$0.00` would make the feature look free while it
   * spends money - and here the DEFAULT summarizer is the session's own model.
   */
  pricingUnknown: boolean;
  inFlight: boolean;
  selfDisabled: boolean;
  selfDisabledReason?: string;
  /** How many times this history has been compacted, from the block's `generation`. */
  generation: number;
  pressure: Pressure;
}

/**
 * THE COMPACTION EVENT STREAM.
 *
 * `compaction_start` and `compaction_end` are emitted ONLY for compactions that
 * COMMITTED TO WORK (quiet-noop §3.1): a `pressure` compaction that declines
 * before calling a model or changing the history emits NEITHER, and is
 * deliberately indistinguishable from a turn at which `shouldCompact` returned
 * false. `manual` and `overflow` always emit both.
 *
 * The pair is still BALANCED: every `compaction_start` is followed by exactly
 * one `compaction_end` (a `finally` in the engine guarantees the verdict, and
 * `settlePending` synthesizes a skeleton record when the compactor's own has not
 * arrived). Consumers that count PAIRS are unaffected; consumers that counted
 * ATTEMPTS must read `/compact status` or the JSONL diagnostic log instead -
 * CORE's own `compaction_start` / `compaction_end` pair still fires for every
 * attempt, declined or not, and that is the stream the log subscribes to.
 */
export type CompactionEvent =
  | { type: 'compaction_start'; index: number; trigger: CompactionUiTrigger; model: string }
  | { type: 'compaction_end'; record: CompactionRecord }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'snapshot'; snapshot: CompactionSnapshot };

export type CompactionEventListener = (event: CompactionEvent) => void;
