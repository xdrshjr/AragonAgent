/**
 * The dispatch supervisor (team-overseer, upgraded by subagent-overseer-v2).
 *
 * ASCII ONLY: `src/team/**` is inside the glyph scanner's scope
 * (`glyphs.test.ts`), so no literal in this tree may hold a non-ASCII byte.
 *
 * A TIME CEILING ON A CHILD IS AN INSPECTION TRIGGER, NOT A DEATH SENTENCE.
 * When a child stalls (event silence) or a cadence tick comes due, the
 * supervisor looks at it through ONE bounded fast-tier call and decides:
 * keep waiting, steer a nudge in to help it recover, rebuild it with an
 * amended brief, or abandon it with a recorded reason. Only the supervisor
 * "decides"; the RUNTIME applies (see `runtime.ts`), because every child
 * lifecycle change must funnel through the worker loop that awaits it
 * (I-OV1).
 *
 * THE SUPERVISOR IS A NO-LOOP, BOUNDED, REMEMBERED CALLEE - NOT AN AGENT
 * (subagent-overseer-v2 D-1). The requirement says "a dedicated supervising
 * subagent on the fast model"; it is satisfied by a per-dispatch, remembered,
 * cadence-woken caller on the fast tier rather than a real `Agent.prompt()`
 * loop, because a supervisor that can itself wedge needs a second supervisor.
 *
 * TWO INSPECTION SHAPES (D-3). Event silence triggers a SINGLE-child look
 * (fast reaction to a suspected stall, unchanged from round 1); the cadence
 * ladder triggers a BATCH look that carries every live child in one digest
 * and returns one JSON array of per-child decisions. The batch call carries
 * its own output budget (`overseerBatchOutputTokens`, R-P0-1): a full
 * ten-child reply does not physically fit in the single-inspection 512
 * tokens, and a truncated reply would parse to nothing - all wait, exactly
 * when help is most needed.
 *
 * THE TRANSPORT IS THE REVIEWER'S, DELIBERATELY. One `complete` call, no
 * tools, thinking off, temperature 0, output capped (512 single /
 * 2048 batch) and wall clock at `FAST_LIMITS.reviewTimeoutMs` — a
 * supervision call that could itself hang would need a second supervisor,
 * which is the regress this design refuses.
 *
 * REPAIR, NEVER REJECT (the `normalizeSubagentSpecs` rule). An unparseable
 * or out-of-budget decision becomes `wait` with the default interval: the
 * failure mode of a supervisor must be "looked and let it run", never
 * "looked and killed it" (I-OV2). In a batch, one bad ENTRY degrades only
 * that entry; a wholly unparseable reply degrades the whole batch to wait
 * with zero action side effects (R-P0-1 / AC-13).
 */

import type {
  AssistantMessage,
  LLMRequest,
  Message,
  TokenUsage,
} from '@aragon-agent/core';
import type { ModelRole } from '../config/model-profiles.js';
import type { CliConfig } from '../config/schema.js';
import { resolveFastTier } from '../fast/resolve.js';
import { accumulateUsage, assistantText, usageOf } from '../fast/review-call.js';
import { FAST_LIMITS } from '../fast/limits.js';
import { truncateBytes } from './report.js';
import { TEAM_LIMITS } from './limits.js';
import type {
  OverseerAction,
  OverseerDecision,
  SubagentRun,
  SubagentSpec,
} from './types.js';

/**
 * Bumped whenever either supervisor protocol prompt changes (D-9), so a
 * behaviour report can be tied to a prompt revision with one grep.
 * `TEAM_BLOCK_VERSION` covers only the LEAD's `<team>` block, not these.
 */
export const OVERSEER_PROMPT_VERSION = 'v2-2026-10';

// ---------------------------------------------------------------------------
// Digest
// ---------------------------------------------------------------------------

/** One remembered decision, so the second look knows the first happened. */
export interface OverseerMemoryEntry {
  /** Seconds into the dispatch. */
  atSec: number;
  action: OverseerAction;
  reason: string;
}

/** Everything one digest is built from. Structural, so tests stub it whole. */
export interface ChildDigestInput {
  run: SubagentRun;
  /** False only in the post-mortem inspection, after the child settled. */
  childAlive: boolean;
  trigger: 'silence' | 'clock' | 'postmortem';
  /** The child's LIVE history (`SubagentAgentLike.state.messages`). */
  messages: readonly Message[];
  memory: readonly OverseerMemoryEntry[];
  /** Seconds the child has been running. */
  elapsedSec: number;
}

/** How many trailing history messages the digest carries. */
const DIGEST_TAIL_MESSAGES = 8;
/** Per-message text clamp inside the digest. */
const DIGEST_MSG_CHARS = 400;

function messageText(message: Message): string {
  if (message.role === 'assistant') {
    const parts: string[] = [];
    for (const block of message.content) {
      if (block.type === 'text') parts.push(block.text);
      if (block.type === 'tool_call') parts.push(`(tool_call ${block.toolName})`);
    }
    return parts.join(' ').trim();
  }
  if (typeof message.content === 'string') return message.content;
  return message.content
    .filter((p) => p.type === 'text')
    .map((p) => (p.type === 'text' ? p.text : ''))
    .join(' ')
    .trim();
}

function clampChars(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3))}...`;
}

/**
 * Build the bounded text one inspection reads.
 *
 * FACTS FIRST, HISTORY SECOND: the byte clamp (`overseerDigestBytes`, via the
 * same `truncateBytes` the report uses so a CJK tail cannot be split mid
 * sequence) bites the tail, and the tail is the least decisive part — a
 * supervisor that cannot see the phase, the retry state and its own memory
 * is worse than one missing the fifth message back.
 */
export function buildChildDigest(input: ChildDigestInput): string {
  const { run, childAlive, trigger, messages, memory, elapsedSec } = input;
  const lines: string[] = [];
  lines.push(`child: ${run.label} "${run.description}"`);
  lines.push(
    `trigger: ${trigger === 'silence' ? 'event silence (suspected stall)' : trigger === 'clock' ? 'wall-clock check' : 'post-mortem (child already ended)'}`,
  );
  lines.push(`elapsed: ${Math.round(elapsedSec)}s, alive: ${childAlive ? 'yes' : 'no'}`);
  lines.push(
    `phase: ${run.phase}, turns: ${run.turns}, toolCalls: ${run.toolCalls}` +
      (run.lastTool ? `, lastTool: ${run.lastTool}` : ''),
  );
  if (run.retry) lines.push(`api-retry: attempt ${run.retry.attempt}/${run.retry.maxRetries} (legitimate backoff, not a stall)`);
  if (run.error) lines.push(`error: ${clampChars(run.error, DIGEST_MSG_CHARS)}`);
  if (run.filesTouched.length > 0) lines.push(`files: ${run.filesTouched.join(', ')}`);
  if (memory.length > 0) {
    lines.push('previous supervisor decisions:');
    for (const entry of memory) {
      lines.push(`  [${entry.atSec}s] ${entry.action}: ${clampChars(entry.reason, 120)}`);
    }
  }
  const tail = messages.slice(-DIGEST_TAIL_MESSAGES);
  if (tail.length > 0) {
    lines.push('history tail:');
    for (const message of tail) {
      const text = clampChars(messageText(message), DIGEST_MSG_CHARS);
      lines.push(`  ${message.role}: ${text.length > 0 ? text : '(no text)'}`);
    }
  }
  return truncateBytes(lines.join('\n'), TEAM_LIMITS.overseerDigestBytes);
}

/**
 * The per-child sections of one batch payload (D-3).
 *
 * SORTED BY LABEL so the same roster produces the byte-identical payload -
 * the batch is the one place where ordering is observable to the model and
 * to every test that asserts on it. Each child's digest is clamped to
 * `overseerPerChildDigestBytes` (facts first, history tail last - R-P2-5).
 * The whole-batch ceiling is applied by the joiner in the provider request.
 */
export function buildBatchSections(
  children: readonly ChildDigestInput[],
): Array<{ label: string; goal: string; digest: string }> {
  return [...children]
    .sort((a, b) => a.run.label.localeCompare(b.run.label, 'en'))
    .map((child) => ({
      label: child.run.label,
      goal: child.run.description,
      digest: truncateBytes(buildChildDigest(child), TEAM_LIMITS.overseerPerChildDigestBytes),
    }));
}

// ---------------------------------------------------------------------------
// Cadence ladder (D-2) - pure math, so tests assert arithmetic, not timers
// ---------------------------------------------------------------------------

/**
 * The FIRST cadence check, from the D-8 priority: `overseerIntervalMs` when
 * the user named one; otherwise a positive `subagentTimeoutMs` (compat with
 * users who already treated it as a trigger); otherwise the structural
 * default. Read-only derivation - the user's stored config is never
 * rewritten to "resolve" this.
 */
export function resolveOverseerFirstCheckMs(team: {
  overseerIntervalMs: number;
  subagentTimeoutMs: number;
}): number {
  if (team.overseerIntervalMs > 0) return team.overseerIntervalMs;
  if (team.subagentTimeoutMs > 0) return team.subagentTimeoutMs;
  return TEAM_LIMITS.overseerDefaultCheckMs;
}

/**
 * The next ladder step after one that produced no action: grow by
 * `overseerCadenceRatio`, clamped to the structural range. With the shipped
 * 300 s base the checks land at 300 / 780 / 1548 / 2448 / ... seconds - a
 * healthy slow child is looked at logarithmically in its run time (AC-11).
 */
export function nextOverseerLadderStepMs(previousMs: number): number {
  const grown = Math.round(previousMs * TEAM_LIMITS.overseerCadenceRatio);
  return Math.min(
    TEAM_LIMITS.overseerNextCheckMaxMs,
    Math.max(TEAM_LIMITS.overseerNextCheckMinMs, grown),
  );
}

// ---------------------------------------------------------------------------
// Decision normalization
// ---------------------------------------------------------------------------

const VALID_ACTIONS: ReadonlySet<string> = new Set(['wait', 'nudge', 'replace', 'abandon']);

/** Clamp a model-chosen next check into the structural range. */
export function clampNextCheckMs(ms: unknown): number | undefined {
  const n = typeof ms === 'number' ? ms : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(
    TEAM_LIMITS.overseerNextCheckMaxMs,
    Math.max(TEAM_LIMITS.overseerNextCheckMinMs, Math.round(n)),
  );
}

function waitDecision(reason: string, nextCheckMs?: number): OverseerDecision {
  return {
    action: 'wait',
    reason: clampChars(reason, TEAM_LIMITS.overseerReasonChars),
    ...(nextCheckMs !== undefined ? { nextCheckMs } : {}),
  };
}

/**
 * Normalize a raw (JSON-parsed or garbage) decision into a safe one.
 *
 * `childAlive === false` PHYSICALLY REMOVES two actions: a dead child can be
 * replaced or abandoned, never waited on or nudged, so those normalize to
 * `abandon` rather than being rejected — a post-mortem answer the protocol
 * cannot honour must still produce a decision the runtime can apply.
 *
 * The single-inspection char limits (200/1200) are the defaults here; the
 * batch path calls `normalizeWithLimits` directly with the tighter protocol
 * limits (R-P0-1).
 */
export function normalizeOverseerDecision(
  raw: unknown,
  childAlive: boolean,
): OverseerDecision {
  return normalizeWithLimits(raw, childAlive, {
    reasonChars: TEAM_LIMITS.overseerReasonChars,
    guidanceChars: TEAM_LIMITS.overseerGuidanceChars,
  });
}

/**
 * Parse the model's answer text as one JSON decision object.
 *
 * Forgiving on PURPOSE: models wrap JSON in prose and fences. The FIRST `{`
 * to the LAST `}` is the only span tried, and anything that does not parse is
 * `wait` — the caller never sees a throw from parsing.
 */
export function parseOverseerDecisionText(text: string, childAlive: boolean): OverseerDecision {
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try {
      return normalizeOverseerDecision(JSON.parse(text.slice(first, last + 1)), childAlive);
    } catch {
      // Fall through to the safe default.
    }
  }
  return waitDecision('decision unparseable; defaulting to wait');
}

/** Decision limits: the single path ships 200/1200, the batch path 80/400 (R-P0-1). */
interface DecisionCharLimits {
  reasonChars: number;
  guidanceChars: number;
}

/** Normalize with EXPLICIT limits so the two protocols stay independently tunable. */
function normalizeWithLimits(
  raw: unknown,
  childAlive: boolean,
  limits: DecisionCharLimits,
): OverseerDecision {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const action = typeof obj.action === 'string' && VALID_ACTIONS.has(obj.action)
    ? (obj.action as OverseerAction)
    : 'wait';
  const reason =
    typeof obj.reason === 'string' && obj.reason.trim().length > 0
      ? obj.reason.trim()
      : 'no reason given';
  const guidance =
    typeof obj.guidance === 'string' && obj.guidance.trim().length > 0
      ? clampChars(obj.guidance.trim(), limits.guidanceChars)
      : undefined;
  const nextCheckMs = clampNextCheckMs(obj.nextCheckMs);

  if (!childAlive && (action === 'wait' || action === 'nudge')) {
    return {
      action: 'abandon',
      reason: clampChars(
        `child already ended; supervisor answered ${action}: ${reason}`,
        TEAM_LIMITS.overseerReasonChars,
      ),
    };
  }
  return {
    action,
    reason: clampChars(reason, limits.reasonChars),
    ...(guidance !== undefined && action === 'nudge' ? { guidance } : {}),
    ...(action === 'wait' && nextCheckMs !== undefined ? { nextCheckMs } : {}),
  };
}

/**
 * Parse the model's answer text as a JSON ARRAY of per-child decisions (D-3).
 *
 * Same forgiving span rule as the single path - first `[` to last `]` - and
 * the same failure semantics: a reply that is not an array (prose, a single
 * object, or TRUNCATED output with no closing `]`) is `[]`, which the caller
 * turns into all-wait with zero action side effects (R-P0-1 / AC-13). Never
 * throws.
 */
export function parseOverseerBatchText(text: string): unknown[] {
  const first = text.indexOf('[');
  const last = text.lastIndexOf(']');
  if (first >= 0 && last > first) {
    try {
      const parsed: unknown = JSON.parse(text.slice(first, last + 1));
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Fall through to the empty batch.
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * The slice the runtime needs: "can you look?", "decide", "what did looking
 * cost?". The provider is the CALL boundary; `TeamOverseer` owns budgets,
 * memory and normalization, so a stub in a test scripts decisions by
 * returning objects or arrays and nothing else.
 */
export interface OverseerProvider {
  /** Live predicate, re-read per tick: this, not the dispatch-time value, decides assisted vs unassisted (R-P0-2). */
  active(): boolean;
  /** One bounded SINGLE-child decision call (silence path). Must not throw. */
  inspect(req: { label: string; goal: string; digest: string }): Promise<OverseerDecision>;
  /**
   * One bounded BATCH call (cadence path, D-3). Returns the RAW reply - the
   * fast provider answers the assistant TEXT - for `TeamOverseer` to parse
   * and normalize. Must not throw.
   */
  inspectBatch(req: ReadonlyArray<{ label: string; goal: string; digest: string }>): Promise<unknown>;
  /**
   * Everything this provider has spent on inspection calls (D-7, honest
   * accounting). Read once by the runtime at dispatch end; there is exactly
   * one accounting of it and no second aggregation path.
   */
  usage(): TokenUsage;
}

/** Everything the fast-tier-backed provider needs from the session. */
export interface FastOverseerDeps {
  /** Read LIVE: a mid-dispatch `/fast off` must reach the next inspection. */
  getConfig: () => CliConfig;
  hasKey: (providerId: string, role?: ModelRole) => boolean;
  getApiKey: (providerId: string, role?: ModelRole) => string | undefined;
  /** `FastWiring.completeViaFastRegistry` — the shared fail-fast transport. */
  complete: (providerId: string, request: LLMRequest) => Promise<AssistantMessage>;
  /** `FastWiring.available()`. */
  available: () => boolean;
}

const OVERSEER_SYSTEM_PROMPT = [
  'You are the supervisor of a team of subagents. You are shown ONE subagent',
  'that crossed a time trigger (event silence or a wall-clock check) and must',
  'decide what to do with it. Answer with ONE JSON object and nothing else:',
  '{"action": "wait" | "nudge" | "replace" | "abandon", "reason": "<= 200 chars",',
  ' "guidance": "<= 1200 chars, nudge only", "nextCheckMs": <ms, wait only>}.',
  'wait: the child looks healthy or is legitimately blocked (API backoff,',
  '  waiting on a teammate or a human confirmation) - keep waiting, pick the',
  '  next check delay.',
  'nudge: the child is stuck in a way a hint can fix (wrong path, retrying a',
  '  failing command, circling) - write the hint as guidance.',
  'replace: the child cannot recover - a fresh child will be built with your',
  '  reason and guidance prepended to its brief.',
  'abandon: the task is not worth more attempts - the child is stopped and',
  '  your reason is reported to the lead.',
  'A nudge is only delivered after the child finishes its current tool call;',
  'a long-running tool is not a stall. Prefer the cheapest action that works.',
].join('\n');

const OVERSEER_BATCH_SYSTEM_PROMPT = [
  'You are the supervisor of a team of subagents. You are shown EVERY live',
  'subagent of one dispatch, separated by --- lines, on a periodic check.',
  'Decide ONCE PER SUBAGENT. Answer with ONE JSON array and nothing else -',
  'one object per subagent, using exactly the label shown:',
  '[{"label": "<label>", "action": "wait" | "nudge" | "replace" | "abandon",',
  '  "reason": "<= 80 chars", "guidance": "<= 400 chars, nudge only",',
  '  "nextCheckMs": <ms, wait only>}, ...]',
  'Keep every reason and guidance SHORT: the whole array must fit a small',
  'output budget and a truncated array helps nobody.',
  'wait: the child looks healthy or is legitimately blocked (API backoff,',
  '  waiting on a teammate or a human confirmation) - keep waiting, pick the',
  '  next check delay.',
  'nudge: the child is stuck in a way a hint can fix - write the hint as',
  '  guidance.',
  'replace: the child cannot recover - a fresh child will be built with your',
  '  reason and guidance prepended to its brief.',
  'abandon: the task is not worth more attempts - the child is stopped and',
  '  your reason is reported to the lead.',
  'You may use whole-team judgement: a child far behind healthy peers on the',
  'same brief is a different signal than one slow child alone.',
  'A nudge is only delivered after the child finishes its current tool call;',
  'a long-running tool is not a stall. Prefer the cheapest action that works.',
].join('\n');

function buildInspectionRequest(params: {
  digest: string;
  modelId: string;
  baseUrl?: string;
  apiKey: string;
  signal: AbortSignal;
}): LLMRequest {
  return {
    model: params.modelId,
    ...(params.baseUrl ? { baseUrl: params.baseUrl } : {}),
    apiKey: params.apiKey,
    systemPrompt: OVERSEER_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: params.digest, timestamp: Date.now() }],
    maxTokens: FAST_LIMITS.reviewOutputTokens,
    thinkingLevel: 'off',
    temperature: 0,
    signal: params.signal,
  };
}

function buildBatchRequest(params: {
  digest: string;
  modelId: string;
  baseUrl?: string;
  apiKey: string;
  signal: AbortSignal;
}): LLMRequest {
  return {
    model: params.modelId,
    ...(params.baseUrl ? { baseUrl: params.baseUrl } : {}),
    apiKey: params.apiKey,
    systemPrompt: OVERSEER_BATCH_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: params.digest, timestamp: Date.now() }],
    // NOT FAST_LIMITS.reviewOutputTokens: a ten-child array does not fit 512
    // tokens, and a truncated reply parses to all-wait (R-P0-1 / AC-13).
    maxTokens: TEAM_LIMITS.overseerBatchOutputTokens,
    thinkingLevel: 'off',
    temperature: 0,
    signal: params.signal,
  };
}

const NO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0 };

/**
 * The fast-tier-backed provider, mirroring `createChildReviewer`'s shape so
 * the controller wires it the same way: shared transport, live predicates,
 * fail-soft (any failure resolves to `wait` — I-OV2).
 *
 * USAGE IS ACCUMULATED HERE (D-7), off every `AssistantMessage` the shared
 * transport returns, along the same `usageOf` / `accumulateUsage` path the
 * fast reviewer already proved. A reply without a usage block contributes
 * nothing rather than a fabricated zero-cost total.
 */
export function createFastOverseerProvider(deps: FastOverseerDeps): OverseerProvider {
  const tier = () => resolveFastTier(deps.getConfig(), deps.hasKey);
  let totalUsage: TokenUsage = { ...NO_USAGE };

  const call = async (
    build: (
      ref: { modelId: string; baseUrl?: string },
      apiKey: string,
      signal: AbortSignal,
    ) => LLMRequest,
  ): Promise<string | null> => {
    const resolved = tier();
    if (!deps.available() || !resolved.ok) return null;
    const apiKey = deps.getApiKey(resolved.ref.providerId, 'fast');
    if (apiKey === undefined) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FAST_LIMITS.reviewTimeoutMs);
    try {
      const message = await deps.complete(
        resolved.ref.providerId,
        build(resolved.ref, apiKey, controller.signal),
      );
      totalUsage = accumulateUsage(totalUsage, usageOf(message).usage);
      return assistantText(message);
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    active: () => deps.available() && tier().ok,
    async inspect(req) {
      try {
        const text = await call((ref, apiKey, signal) =>
          buildInspectionRequest({
            digest: req.digest,
            modelId: ref.modelId,
            ...(ref.baseUrl ? { baseUrl: ref.baseUrl } : {}),
            apiKey,
            signal,
          }),
        );
        if (text === null) return waitDecision('fast tier unavailable; defaulting to wait');
        return parseOverseerDecisionText(text, true);
      } catch {
        // INCLUDING a timeout abort: supervision failing is wait, never kill.
        return waitDecision('inspection call failed; defaulting to wait');
      }
    },
    async inspectBatch(req) {
      try {
        // The joiner owns the WHOLE-BATCH ceiling (D-3): sections arrive
        // per-child-clamped and label-sorted; `hardMaxSubagents` means the
        // clamp is a guard, not a squeeze.
        const digest = truncateBytes(
          req.map((r) => `### ${r.label}\n${r.digest}`).join('\n---\n'),
          TEAM_LIMITS.overseerBatchDigestBytes,
        );
        const text = await call((ref, apiKey, signal) =>
          buildBatchRequest({
            digest,
            modelId: ref.modelId,
            ...(ref.baseUrl ? { baseUrl: ref.baseUrl } : {}),
            apiKey,
            signal,
          }),
        );
        return text ?? '';
      } catch {
        // INCLUDING a timeout abort: supervision failing is wait, never kill.
        return '';
      }
    },
    usage: () => ({ ...totalUsage }),
  };
}

// ---------------------------------------------------------------------------
// The per-dispatch supervisor state
// ---------------------------------------------------------------------------

/** One inspection request, as the runtime builds it. */
export interface OverseerInspectRequest {
  run: SubagentRun;
  messages: readonly Message[];
  trigger: 'silence' | 'clock' | 'postmortem';
  childAlive: boolean;
}

export interface TeamOverseerOptions {
  /** The dispatch's start, so memory entries read as "N s in". */
  startedAt: number;
  now?: () => number;
}

export const OVERSEER_DEFAULT_NEXT_CHECK_MS = TEAM_LIMITS.overseerDefaultCheckMs;

/**
 * Per-dispatch supervisor state: memory, budgets and the single-flight guard.
 *
 * THE CLASS NEVER TOUCHES A CHILD (I-OV1). It looks and decides; `runtime.ts`
 * steers, flags, aborts and rebuilds, because only the worker loop can apply
 * a lifecycle change without orphaning the replacement.
 *
 * LOOKS AND ACTIONS ARE SEPARATE LEDGERS (D-5). A LOOK is cost: every
 * inspection of a child spends one, including a call that failed softly -
 * which is what closes G-6 (a flaky transport used to burn the budget the
 * same as a decision, and the supervisor went quiet exactly when the team
 * was hardest to see). An ACTION is a mutation (nudge / replace / abandon)
 * and is counted only when the runtime APPLIES it, through the `note*`
 * methods below. A label skipped because an inspection is already in flight
 * spends NOTHING (R-P1-4).
 */
export class TeamOverseer {
  private readonly memory = new Map<string, OverseerMemoryEntry[]>();
  private readonly looks = new Map<string, number>();
  private readonly nudges = new Map<string, number>();
  private readonly replacements = new Map<string, number>();
  private readonly abandons = new Map<string, number>();
  private readonly inFlight = new Set<string>();
  private looksTotal = 0;
  private callCount = 0;

  constructor(
    private readonly provider: OverseerProvider,
    private readonly options: TeamOverseerOptions,
  ) {}

  /** Never throws: a provider bug must not take the dispatch down. */
  isActive(): boolean {
    try {
      return this.provider.active();
    } catch {
      return false;
    }
  }

  /** Whether ANY inspection of `label` is in flight (single or batch). */
  isInFlight(label: string): boolean {
    return this.inFlight.has(label);
  }

  /** Per-child look budget spent (D-5). */
  looksExhausted(label: string): boolean {
    return (
      (this.looks.get(label) ?? 0) >= TEAM_LIMITS.overseerMaxLooksPerChild ||
      this.dispatchLooksExhausted()
    );
  }

  /** The fool-proof dispatch-wide total (R-P1-6). */
  dispatchLooksExhausted(): boolean {
    return this.looksTotal >= TEAM_LIMITS.overseerMaxLooksPerDispatch;
  }

  nudgesLeft(label: string): boolean {
    return (this.nudges.get(label) ?? 0) < TEAM_LIMITS.overseerMaxNudgesPerChild;
  }

  replacementsLeft(label: string): boolean {
    return (this.replacements.get(label) ?? 0) < TEAM_LIMITS.overseerMaxReplacementsPerChild;
  }

  abandonsLeft(label: string): boolean {
    return (this.abandons.get(label) ?? 0) < TEAM_LIMITS.overseerMaxAbandonsPerChild;
  }

  /** Called by the runtime when it APPLIES a nudge, not when it merely reads one. */
  noteNudge(label: string): void {
    this.nudges.set(label, (this.nudges.get(label) ?? 0) + 1);
  }

  /** Called by the runtime when it APPLIES a replace, not when it merely reads one. */
  noteReplacement(label: string): void {
    this.replacements.set(label, (this.replacements.get(label) ?? 0) + 1);
  }

  /** Called by the runtime when it APPLIES an abandon, not when it merely reads one. */
  noteAbandon(label: string): void {
    this.abandons.set(label, (this.abandons.get(label) ?? 0) + 1);
  }

  /** The provider's own accumulated inspection spend (D-7), zero when unreadable. */
  usage(): TokenUsage {
    try {
      return this.provider.usage();
    } catch {
      return { ...NO_USAGE };
    }
  }

  /** Provider invocations, including ones that failed softly (D-7). */
  calls(): number {
    return this.callCount;
  }

  /**
   * ONE single-child inspection (the silence-triggered path, round-1
   * behaviour preserved). `null` means QUIET — not active, no budget left, or
   * one already in flight for this child — and the caller then does nothing,
   * which is exactly what quiet should do.
   */
  async inspect(req: OverseerInspectRequest): Promise<OverseerDecision | null> {
    const label = req.run.label;
    if (!this.isActive() || this.looksExhausted(label) || this.inFlight.has(label)) {
      return null;
    }
    this.inFlight.add(label);
    const now = this.options.now?.() ?? Date.now();
    const digest = buildChildDigest({
      run: req.run,
      childAlive: req.childAlive,
      trigger: req.trigger,
      messages: req.messages,
      memory: this.memory.get(label) ?? [],
      elapsedSec: Math.max(0, (now - (req.run.startedAt ?? now)) / 1000),
    });
    let decision: OverseerDecision;
    this.callCount += 1;
    try {
      decision = await this.provider.inspect({
        label,
        goal: req.run.description,
        digest,
      });
    } catch {
      decision = waitDecision('inspection threw; defaulting to wait');
    } finally {
      this.inFlight.delete(label);
    }
    this.spendLook(label);
    this.remember(label, now, decision);
    return decision;
  }

  /**
   * ONE batch inspection over every requested child (the cadence path, D-3):
   * a single fast-tier call, a JSON array back, one decision per child.
   *
   * SKIPS FIRST, CALLS SECOND (R-P1-4): a label whose single inspection is
   * still in flight, or whose look budget is spent, simply gets NO entry -
   * no decision, no look charged, ladder untouched by the caller. A label
   * that IS carried but whose reply entry is missing or garbage gets `wait`
   * (repair, never reject). A wholly unparseable or truncated reply is ALL
   * wait with zero action side effects (R-P0-1 / AC-13).
   */
  async inspectBatch(reqs: readonly OverseerInspectRequest[]): Promise<Map<string, OverseerDecision>> {
    const eligible = reqs.filter(
      (req) => !this.inFlight.has(req.run.label) && !this.looksExhausted(req.run.label),
    );
    if (eligible.length === 0 || !this.isActive()) return new Map();

    const now = this.options.now?.() ?? Date.now();
    const inputs = eligible.map((req) => ({
      run: req.run,
      childAlive: req.childAlive,
      trigger: 'clock' as const,
      messages: req.messages,
      memory: this.memory.get(req.run.label) ?? [],
      elapsedSec: Math.max(0, (now - (req.run.startedAt ?? now)) / 1000),
    }));
    const sections = buildBatchSections(inputs);
    for (const req of eligible) this.inFlight.add(req.run.label);
    this.callCount += 1;
    let raw: unknown;
    try {
      raw = await this.provider.inspectBatch(sections);
    } catch {
      raw = [];
    } finally {
      for (const req of eligible) this.inFlight.delete(req.run.label);
    }

    const entries = typeof raw === 'string' ? parseOverseerBatchText(raw) : Array.isArray(raw) ? raw : [];
    const byLabel = new Map<string, unknown>();
    for (const entry of entries) {
      const label = (entry as { label?: unknown } | null)?.label;
      if (typeof label === 'string' && label.length > 0 && !byLabel.has(label)) {
        byLabel.set(label, entry);
      }
    }

    const decisions = new Map<string, OverseerDecision>();
    for (const input of inputs) {
      const label = input.run.label;
      const decision = normalizeWithLimits(byLabel.get(label), input.childAlive, {
        reasonChars: TEAM_LIMITS.overseerBatchReasonChars,
        guidanceChars: TEAM_LIMITS.overseerBatchGuidanceChars,
      });
      this.spendLook(label);
      this.remember(label, now, decision);
      decisions.set(label, decision);
    }
    return decisions;
  }

  private spendLook(label: string): void {
    this.looks.set(label, (this.looks.get(label) ?? 0) + 1);
    this.looksTotal += 1;
  }

  private remember(label: string, now: number, decision: OverseerDecision): void {
    const entries = this.memory.get(label) ?? [];
    entries.push({
      atSec: Math.max(0, Math.round((now - this.options.startedAt) / 1000)),
      action: decision.action,
      reason: decision.reason,
    });
    this.memory.set(label, entries);
  }
}

// ---------------------------------------------------------------------------
// Replacement brief
// ---------------------------------------------------------------------------

/** Headroom the amended brief keeps over the original prompt's clamp. */
const REPLACEMENT_NOTE_CHARS = 800;

/**
 * Prepend the supervisor's note to a spec's prompt, bounding the TOTAL to
 * `TEAM_LIMITS.promptChars` so the replacement fits exactly what a
 * model-supplied spec would have been allowed to carry.
 *
 * THE NOTE TELLS THE FRESH CHILD WHAT THE DEAD ONE DID (`filesTouched` is
 * best-effort, the same caveat the report's conflict warning carries): a
 * replacement that rewrites a half-written file blind is not a recovery.
 */
export function buildReplacementPrompt(
  spec: SubagentSpec,
  decision: OverseerDecision,
  previousRun: SubagentRun,
): string {
  const files =
    previousRun.filesTouched.length > 0
      ? ` It already wrote to: ${previousRun.filesTouched.join(', ')}.`
      : '';
  const guidance =
    decision.action === 'replace' && decision.guidance !== undefined
      ? ` Guidance: ${decision.guidance}`
      : '';
  const note = clampChars(
    `[supervisor note] A previous attempt at this task ran ${previousRun.turns} turns ` +
      `and was replaced. Reason: ${decision.reason}.${files}${guidance} ` +
      `Verify rather than assume prior work is complete.\n\n`,
    REPLACEMENT_NOTE_CHARS,
  );
  const originalBudget = Math.max(0, TEAM_LIMITS.promptChars - note.length);
  return `${note}${spec.prompt.slice(0, originalBudget)}`;
}
