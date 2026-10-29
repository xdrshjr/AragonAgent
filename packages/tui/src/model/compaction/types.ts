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

import type { ModelRef, TokenUsage } from '@aragon-agent/core';
import type { ContextWindowOrigin } from '../config/schema.js';

/** Billing belongs to the actual call, including fallback and late responses. */
export interface CompactionBilling {
  modelRef?: ModelRef;
  costUsd?: number;
  pricingUnknown?: boolean;
}

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

/**
 * Where one attempt currently is, so "compacting context" can also say WHAT it is
 * doing for the forty-five seconds it is on screen.
 *
 * IT EXISTS BECAUSE THE GATES WERE INVISIBLE (context-compaction-never-fires
 * RC-3). Planning and digesting both run BEFORE any model call, and both used to
 * be able to reject while the only surface said `Context 95%` and nothing else.
 * A phase is the CLI's answer to "is this stuck, or merely slow", and it is
 * CLI-LOCAL for the reason the whole stream is: the engine has no phases, only a
 * splice.
 *
 * THERE IS NO `settled` MEMBER, deliberately: the settle is already the
 * `compaction_end` record. A phase restating it would give the card two ways to
 * learn one fact, and the extra phase would race the record whenever the engine's
 * verdict comes back first.
 */
export type CompactionPhase =
  | 'planning'
  | 'digesting'
  | 'summarizing'
  | 'validating'
  | 'applying';

/** Whether a figure was measured by the provider or estimated by us. */
export type PressureSource = 'usage' | 'estimate';

/** The exact occupancy evidence at the compaction checkpoint. */
export interface CompactionDecision {
  occupied: number;
  contextWindow: number;
  threshold: number;
  source: PressureSource;
  deltaTokens: number;
}

export interface Pressure {
  /**
   * `user` means the CLI's model-windows.json supplied the denominator - a
   * hand-typed window for a model no table knows. It outranks `api` and
   * `catalog` in `getModelInfoFor` precisely because the user asserted it.
   */
  windowSource?: 'api' | 'catalog' | 'fallback' | 'user';
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
   * Whether the denominator came from the user's `contextWindow` override
   * (context-usage-gauge-accuracy I-6).
   *
   * SEPARATE FROM `windowKnown` RATHER THAN FOLDED INTO IT. An override makes
   * the window KNOWN - the user asserted it, so the `~` has no business staying
   * on the percentage - but `/context` still has to be able to say WHO supplied
   * the number. Collapsing the two into one boolean makes "found in the model
   * table" and "typed by hand" indistinguishable in the report, and the second
   * one being wrong is exactly the case that most needs to be visible.
   */
  windowOverridden: boolean;
  /**
   * WHICH override surface supplied the denominator (profile-context-window
   * §5.2): env / legacy top-level key / the profile bound as Main. Optional
   * and PURE PASS-THROUGH - present only when `windowOverridden` is true, and
   * `undefined` there means "config", the pre-feature answer. The arithmetic
   * never reads it; only `/context`'s window line does.
   */
  windowOverrideOrigin?: ContextWindowOrigin;
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

/**
 * The ONE occupancy projection the status bar and `/context` read
 * (context-usage-gauge-accuracy §4.1).
 *
 * DELIBERATELY CARRIES NO TIMESTAMP. Its only consumer is the reducer's identity
 * short-circuit (§5.2), and a field that changes on every tick would make that
 * short-circuit never hold - turning a permanently visible row into a 2.5 Hz
 * re-render source and pushing the render governor up its ladder for nothing.
 *
 * `Pressure` is the compaction subsystem's shape and carries a headroom and a
 * ratio the UI does not want; this is the projection of it that crosses into
 * view state, and `toContextUsage` in `meter.ts` is the ONLY converter.
 */
export interface ContextUsageSnapshot {
  windowSource?: Pressure['windowSource'];
  /** Occupied tokens (measured, plus an estimate of anything appended since). */
  occupied: number;
  /** The denominator actually used. */
  window: number;
  /** `occupied / window` as a percentage, clamped to [0, 100] and rounded. */
  pct: number;
  /** Where the BASE came from. */
  source: PressureSource;
  /** How much of `occupied` is an estimate of appended messages; `> 0` means approximate. */
  deltaTokens: number;
  /** Whether the denominator is trustworthy (in the model table, or overridden). */
  windowKnown: boolean;
  /** Whether the denominator came from the user's `contextWindow` (I-6). */
  windowOverridden: boolean;
  /** Which override surface named the denominator; see `Pressure` (pass-through). */
  windowOverrideOrigin?: ContextWindowOrigin;
}

/** One compaction, in whatever state it reached. Rendered by `CompactionCard`. */
export interface CompactionRecord {
  decision?: CompactionDecision;
  memoryVersion?: 2;
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
   * Set when `planCompaction` had to relax `keepRecentTurns` to find a cut
   * (context-compaction-never-fires B).
   *
   * DISCLOSED ON THE CARD, never silent: the relaxation trades "the last N turns
   * are verbatim" for "compaction happens at all", and a user who is not told
   * which side they got cannot tell a lossless compaction from a lossy one.
   * `retainedTurns` and `retainedMessages` are what actually survived, so the card
   * can state all three numbers instead of implying one.
   */
  keepRelaxed?: boolean;
  retainedTurns?: number;
  /**
   * How many MESSAGES the relaxed cut left verbatim.
   *
   * `retainedTurns` COUNTS USER TURNS, and in the sessions this fix exists for - one
   * prompt followed by a hundred tool calls - that number is zero even though forty
   * messages survived word for word. A card reading "kept 0 recent turns" at that
   * moment says the opposite of what happened, so both numbers are recorded.
   */
  retainedMessages?: number;
  /**
   * Messages left OUT of the digest text and therefore not quotable by the
   * summarizer (context-compaction-never-fires A1).
   *
   * The elision is LOUD in three places: the digest text itself carries an
   * `[elided ...]` marker, this field puts the count on the card, and the elided
   * ids never enter the source map, so a delta citing one is rejected.
   */
  elidedMessages?: number;
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
  /** Sum of known per-call costs; never reprice accumulated usage with a new model. */
  costUsd?: number;
  /** Registered AND enabled AND a summarizer model resolves. */
  live: boolean;
  /** The summarizer's model id, or `''`. */
  model: string;
  /**
   * How many compactions ANNOUNCED themselves, i.e. how many cards the user saw.
   *
   * IT COUNTS ATTEMPTS, NOT SPLICES (context-compaction-never-fires C). Before
   * this change only attempts that committed to work announced, so this was
   * "compactions that ran"; now every attempt opens a card - including the ones
   * that decline at the planner or the digest - because a silent decline is
   * indistinguishable from a dead feature, which is the bug this feature shipped
   * with. `applied` below is the other half, and `/compact status` prints both.
   */
  compactions: number;
  /**
   * How many of those attempts actually replaced the history.
   *
   * OPTIONAL SO EVERY EXISTING CONSTRUCTION SITE STAYS UNTOUCHED. Absent means
   * "not reported", which `/compact status` renders exactly as the pre-change
   * wording did.
   */
  applied?: number;
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
 * EVERY ATTEMPT ANNOUNCES ITSELF (context-compaction-never-fires C, which
 * REVERSES quiet-noop §3.1). A `pressure` compaction used to reach
 * `compaction_start` only after it committed to paid work, so an attempt that
 * declined at the planner (`nothing_to_drop`) or at the digest budget produced
 * no card at all - and a user sitting at 95 % with a dead auto-compaction had no
 * way to learn that the feature was trying and failing 96 times. The card is now
 * opened at the entry of `compact()` and ALWAYS settled, so `#N` counts attempts
 * and the transcript carries one line per attempt, applied or not.
 *
 * WHY THE OLD DESIGN WAS DEFENSIBLE AND IS STILL WRONG. Its stated worry was a
 * red `context not compacted` card every two turns flooding the transcript. The
 * guards bound that to `stuckLimit` declines per run (`limits.ts`), and after
 * them the auto path self-disables and says so once - so the flood never
 * happens, while the silence happened every time.
 *
 * The pair is still BALANCED: every `compaction_start` is followed by exactly
 * one `compaction_end` (a `finally` in the engine guarantees the verdict, and
 * `settlePending` synthesizes a skeleton record when the compactor's own has not
 * arrived). `phase` events land BETWEEN them, in order, and only for the live
 * card.
 */
export type CompactionEvent =
  | { type: 'compaction_start'; index: number; trigger: CompactionUiTrigger; model: string }
  | { type: 'compaction_end'; record: CompactionRecord }
  | { type: 'phase'; index: number; phase: CompactionPhase }
  | ({ type: 'usage'; usage: TokenUsage } & CompactionBilling)
  | { type: 'snapshot'; snapshot: CompactionSnapshot };

export type CompactionEventListener = (event: CompactionEvent) => void;
