/**
 * Pure compaction mechanics (context-auto-compaction §3.6.1 / §3.6.2 / §5.3).
 *
 * NO I/O, NO CLOCK, NO PROVIDER KNOWLEDGE, NO `node:*` IMPORT. This module is
 * the engine's whole contribution to compaction: where a history may safely be
 * cut, which cut to take, and — the one that matters — whether a history the
 * host handed back is structurally sendable at all.
 *
 * WHY THE ENGINE OWNS VALIDATION AND NOTHING ELSE (D-4). A compacted history
 * that strands a `tool_result` without its `tool_call` is an immediate HTTP 400
 * on Anthropic: `convertMessages` emits one `user` message carrying a
 * `tool_use_id` per `tool_result`, and the API rejects a `tool_use_id` with no
 * `tool_use` before it. That failure is not recoverable by the host and must not
 * be recoverable BY POLICY — so the engine refuses to adopt an invalid history
 * and continues with the original. A host bug becomes "compaction did not
 * happen" rather than "the session is now permanently un-sendable" (R-2).
 */

import type { ContentPart, Message } from '../llm/types.js';
import { estimatePromptTokens } from '../llm/output-limits.js';

export interface CompactionPlan {
  /** Head is `[0, cutIndex)`; tail is `[cutIndex, end)`. */
  cutIndex: number;
  droppedMessages: number;
  retainedTurns: number;
}

export type HistoryCheck =
  | { ok: true }
  | { ok: false; reason: 'empty' | 'orphan_tool_result' | 'unclosed_tool_call' | 'grew' };

/**
 * Every index at which the history may be split without stranding a tool call.
 *
 * `i` is SAFE iff, walking from 0, the set of open tool calls is empty at the
 * boundary before `i` AND `messages[i]` is not a `tool_result`.
 *
 * A SET-BASED WALK RATHER THAN A ROLE-PATTERN RULE, and that is deliberate: the
 * history is not always the clean `user -> assistant -> tool_result*` shape the
 * loop produces. Steering interruption pushes synthesized `tool_result`s for the
 * REMAINING calls in a batch, CodeAct injects a bare `user` message, and
 * `/resume` restores whatever a file contained. A rule that encodes the happy
 * path is a rule that produces an invalid splice on the one history that got
 * interesting.
 */
export function findSafeCutIndices(messages: readonly Message[]): number[] {
  const safe: number[] = [];
  const open = new Set<string>();
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i]!;
    if (open.size === 0 && m.role !== 'tool_result') safe.push(i);
    if (m.role === 'assistant') {
      for (const b of m.content) if (b.type === 'tool_call') open.add(b.toolCallId);
    } else if (m.role === 'tool_result') {
      open.delete(m.toolCallId);
    }
  }
  if (open.size === 0) safe.push(messages.length);
  return safe;
}

/** A "turn" is a `user`-role message; `tool_result` is a separate role here. */
function countTurns(messages: readonly Message[], from: number): number {
  let turns = 0;
  for (let i = from; i < messages.length; i += 1) {
    if (messages[i]!.role === 'user') turns += 1;
  }
  return turns;
}

export interface PlanCompactionOptions {
  keepRecentTurns: number;
  /**
   * Messages at the head that are ALREADY structurally preserved by the host
   * (the goal anchor, and a prior `<compacted_context>` block right after it).
   *
   * THIS PARAMETER IS WHAT MAKES REPEATED COMPACTION TERMINATE CLEANLY (P1-9 /
   * D-21). Without it the condition would have to be "the best cut is 0 or 1",
   * which encodes an assumption about what messages 0 and 1 ARE — and after one
   * compaction they are the anchor and the summary block, so a second pass would
   * re-summarize a summary with no new material, produce a smaller and lossier
   * record, and report success.
   *
   * The HOST counts it (it is the host that knows what an `<original_task>`
   * message is) and passes the number; core stays free of any knowledge of the
   * block format, which is the §1.2 boundary. Hard-coding `1` here, or teaching
   * this module the tag, are both ways of putting host knowledge in the engine
   * to save a parameter.
   */
  protectedPrefix?: number;
}

/**
 * The largest safe cut that still leaves at least `keepRecentTurns` complete
 * turns in the tail, or `null` when there is nothing worth dropping.
 *
 * `null` — rather than a zero-length head — is what lets §3.8 turn "the recent
 * turns alone exceed the threshold" into a bounded, loud outcome instead of a
 * retry loop against a paid API.
 */
export function planCompaction(
  messages: readonly Message[],
  opts: PlanCompactionOptions,
): CompactionPlan | null {
  const keep = Math.max(1, Math.floor(opts.keepRecentTurns));
  const protectedPrefix = Math.max(0, Math.floor(opts.protectedPrefix ?? 0));
  const safe = findSafeCutIndices(messages);

  for (let i = safe.length - 1; i >= 0; i -= 1) {
    const cutIndex = safe[i]!;
    // The tail must still be a conversation, not an empty suffix.
    if (cutIndex >= messages.length) continue;
    const retainedTurns = countTurns(messages, cutIndex);
    if (retainedTurns < keep) continue;
    if (cutIndex <= protectedPrefix) return null;
    return {
      cutIndex,
      droppedMessages: cutIndex - protectedPrefix,
      retainedTurns,
    };
  }
  return null;
}

export interface ValidateHistoryOptions {
  /**
   * The length of the history being REPLACED. Supplied positionally by the loop
   * so the `grew` rung is live: a compaction that returns more messages than it
   * was given is not a correctness failure, but it is always a bug, and adopting
   * it would let a broken compactor amplify the very problem it exists to solve.
   */
  previousLength?: number;
}

/**
 * THE GATE (§3.3 step 5). One walk, the same open-set as `findSafeCutIndices`.
 *
 * Also exported for the host's IDLE `/compact` path (§4.4 / D-25), which cannot
 * reach the loop's gate because there is no loop — and D-4 declares that gate
 * unbypassable.
 */
export function validateHistory(
  messages: readonly Message[],
  opts: ValidateHistoryOptions = {},
): HistoryCheck {
  if (!Array.isArray(messages) || messages.length === 0) return { ok: false, reason: 'empty' };
  if (opts.previousLength !== undefined && messages.length > opts.previousLength) {
    return { ok: false, reason: 'grew' };
  }

  const open = new Set<string>();
  for (const m of messages) {
    if (m.role === 'assistant') {
      for (const b of m.content) if (b.type === 'tool_call') open.add(b.toolCallId);
    } else if (m.role === 'tool_result') {
      if (!open.has(m.toolCallId)) return { ok: false, reason: 'orphan_tool_result' };
      open.delete(m.toolCallId);
    }
  }
  if (open.size > 0) return { ok: false, reason: 'unclosed_tool_call' };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Tail relief (context-auto-compaction-hardening §3.3 / W2)
// ---------------------------------------------------------------------------

export interface TailReliefOptions {
  /** Index the tail starts at; nothing before it is touched. */
  from: number;
  /** Clip each oversized `tool_result` body to this many characters. */
  clipChars: number;
  /** Stop as soon as the estimate falls below this. */
  targetTokens: number;
  /** System prompt, so the estimate is measured the same way everywhere. */
  systemPrompt: string;
  /** Appended where text was removed. The host supplies it; core has no glyphs. */
  marker: (removed: number) => string;
}

export interface TailReliefResult {
  messages: Message[];
  clippedMessages: number;
  charsRemoved: number;
}

/**
 * Clip oversized `tool_result` bodies inside a retained tail until the whole
 * history is projected under `targetTokens` — the last rung of the ladder
 * (context-auto-compaction-hardening §3.3).
 *
 * WHY THIS EXISTS. Every other rung operates on the HEAD: summarize it, retry
 * the summarization, drop it without a summary. When the TAIL is what does not
 * fit — `keepRecentTurns` turns carrying several 100 KB tool results — each of
 * those rungs reports success or `nothing_to_drop` while the history stays
 * un-sendable, and the run dies with no rung left.
 *
 * FOUR RULES, EACH LOAD-BEARING:
 *
 *  1. ONLY `tool_result` BODIES ARE ELIGIBLE. Not `user` messages (the anchor
 *     and the user's own instructions are the last things to damage), not
 *     `assistant` messages (clipping the model's own reasoning mid-tail produces
 *     a history that contradicts itself). The size argument is the bound: a tool
 *     result is capped at 100 KB EACH with several per turn, while an assistant
 *     message is capped by the turn's `maxOutputTokens`. The tail is blown by
 *     results, not by calls.
 *  2. OLDEST FIRST. The newest tool result is the one the next request is most
 *     likely to be about, so the walk starts at `from` and stops the moment the
 *     projection is under budget.
 *  3. STRUCTURE IS NEVER CHANGED. No message is removed, no `toolCallId` is
 *     touched, no role changes — so `validateHistory` cannot fail on a relieved
 *     history that was valid before. That is what makes this safe to run AFTER a
 *     splice, and it is the reason relief CLIPS rather than DROPS.
 *  4. EVERY CLIP IS ANNOUNCED IN THE TEXT THE MODEL READS, at the exact place
 *     the data was removed. A model that sees the marker knows the output is
 *     partial and can re-run the tool; a model handed a silently truncated file
 *     does not.
 *
 * PURE, AND IT DOES NOT MUTATE ITS INPUT. Untouched messages keep their identity
 * in the returned array, which is what lets a caller assert "nothing before
 * `from` changed" by reference rather than by deep equality.
 */
export function relieveTail(
  messages: readonly Message[],
  opts: TailReliefOptions,
): TailReliefResult {
  const out: Message[] = [...messages];
  const from = Math.max(0, Math.floor(opts.from));
  const clipChars = Math.max(0, Math.floor(opts.clipChars));
  let clippedMessages = 0;
  let charsRemoved = 0;

  // RE-ESTIMATED AFTER EVERY CLIP rather than decremented, and the cost is not
  // the reason to worry about it: the array this walks is one retained tail, not
  // a session. `estimatePromptTokens` rounds, so a hand-rolled running total
  // would drift from the number the caller's budget check uses — and the whole
  // point of this function is to land under THAT number.
  let projected = estimatePromptTokens(out, opts.systemPrompt);

  for (let i = from; i < out.length; i += 1) {
    if (projected <= opts.targetTokens) break;
    const message = out[i]!;
    if (message.role !== 'tool_result') continue;
    const clipped = clipToolResultContent(message.content, clipChars, opts.marker);
    if (clipped === null) continue;
    out[i] = { ...message, content: clipped.content };
    clippedMessages += 1;
    charsRemoved += clipped.removed;
    projected = estimatePromptTokens(out, opts.systemPrompt);
  }

  return { messages: out, clippedMessages, charsRemoved };
}

/**
 * One `tool_result` body, clipped — or `null` when there was nothing to remove.
 *
 * A PART ARRAY IS CLIPPED LONGEST-FIRST, and only its `text` parts. `image`
 * parts are left alone: the estimator charges them a flat rate that has nothing
 * to do with their length, so clipping one removes characters without removing
 * tokens, and re-encoding an image is a different feature.
 */
function clipToolResultContent(
  content: string | ContentPart[],
  clipChars: number,
  marker: (removed: number) => string,
): { content: string | ContentPart[]; removed: number } | null {
  if (typeof content === 'string') {
    if (content.length <= clipChars) return null;
    const removed = content.length - clipChars;
    return { content: content.slice(0, clipChars) + marker(removed), removed };
  }
  if (!Array.isArray(content)) return null;

  const order = content
    .map((part, index) => ({ index, length: part.type === 'text' ? part.text.length : -1 }))
    .filter((entry) => entry.length > clipChars)
    .sort((a, b) => b.length - a.length);
  if (order.length === 0) return null;

  const parts = [...content];
  let total = parts.reduce((sum, p) => sum + (p.type === 'text' ? p.text.length : 0), 0);
  let removed = 0;
  for (const entry of order) {
    if (total <= clipChars) break;
    const part = parts[entry.index]!;
    if (part.type !== 'text') continue;
    const cut = part.text.length - clipChars;
    parts[entry.index] = { type: 'text', text: part.text.slice(0, clipChars) + marker(cut) };
    removed += cut;
    total -= cut;
  }
  if (removed === 0) return null;
  return { content: parts, removed };
}
