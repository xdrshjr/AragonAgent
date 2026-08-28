/**
 * The head of the history, rendered as a bounded plain-text transcript
 * (context-auto-compaction §3.6.3).
 *
 * ASCII ONLY: `src/compaction/**` is inside the glyph scanner's scope.
 *
 * PURE. Two reasons this is a digest rather than raw messages, and the second
 * one is the one that bites:
 *
 *  - Tool results are the bulk. Four 60 KB file reads are 240 KB of body that
 *    says almost nothing about what was decided.
 *  - THE SUMMARIZER MAY HAVE A SMALLER CONTEXT WINDOW THAN THE MODEL BEING
 *    COMPACTED. The whole point of using a cheap model is that it is cheap, and
 *    cheap models are exactly the ones with 32 k windows. Sending 180 k of
 *    history to summarize would fail with the same error we are recovering from
 *    (R-4).
 */

import { CHARS_PER_TOKEN, type Message } from '@aragon-agent/core';
import { BLOCK_TAG_CLOSE, BLOCK_TAG_OPEN, COMPACTION_LIMITS } from './limits.js';

/** Prepended when the budget forced entries out, so the summary can say so. */
const OMISSION_MARKER = (n: number): string =>
  `[... ${n} earlier ${n === 1 ? 'message' : 'messages'} omitted from this digest ...]`;

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

/** Flatten `string | ContentPart[]` into text, naming images rather than dropping them. */
function partsToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as Array<Record<string, unknown>>)
    .map((part) => (typeof part?.text === 'string' ? part.text : '[image]'))
    .join('\n');
}

/**
 * Is this `user` message a previous `<compacted_context>` block?
 *
 * Recognized on the OPENING TAG rather than a full parse: the block carries
 * attributes (`version`, `replaced`, `turns`, `anchor`, `generation`) that this
 * module has no business knowing about, and a stricter match would fail on the
 * first attribute anybody adds.
 */
export function isPriorSummaryBlock(message: Message): boolean {
  if (message.role !== 'user') return false;
  const text = partsToText(message.content).trimStart();
  return text.startsWith(BLOCK_TAG_OPEN);
}

/** The block's body with its framing removed, for re-rendering as PRIOR SUMMARY. */
function stripBlockTags(text: string): string {
  const trimmed = text.trim();
  const open = trimmed.indexOf('>');
  const close = trimmed.lastIndexOf(BLOCK_TAG_CLOSE);
  if (open < 0) return trimmed;
  const body = close > open ? trimmed.slice(open + 1, close) : trimmed.slice(open + 1);
  return body.trim();
}

interface Rendered {
  text: string;
  /**
   * Evicted LAST rather than first.
   *
   * A `PRIOR SUMMARY` is the densest thing in the head by construction - it is
   * already the compressed form of everything before it - so dropping it to make
   * room for raw transcript is a strictly losing trade (D-22).
   */
  pinned: boolean;
}

function renderMessage(message: Message): Rendered[] {
  if (message.role === 'user') {
    if (isPriorSummaryBlock(message)) {
      // CARRIED WHOLE, up to `summaryMaxChars` (D-22 / P1-9).
      //
      // A `<compacted_context>` block IS a `user` message (D-5, deliberately),
      // so a per-kind table that clipped it to `userChars` (2 000) would discard
      // up to two thirds of the previous summary - which §5.4 permits to be
      // 6 000 long - BEFORE summarizing it, and then report `summarized`. Every
      // compaction after the first would decay the record silently.
      const body = stripBlockTags(partsToText(message.content));
      return [{ text: `PRIOR SUMMARY: ${clip(body, COMPACTION_LIMITS.summaryMaxChars)}`, pinned: true }];
    }
    return [
      { text: `USER: ${clip(partsToText(message.content), COMPACTION_LIMITS.userChars)}`, pinned: false },
    ];
  }

  if (message.role === 'tool_result') {
    const status = message.isError ? 'error' : 'ok';
    const body = clip(partsToText(message.content), COMPACTION_LIMITS.toolResultChars);
    return [{ text: `RESULT[${status}] ${body}`, pinned: false }];
  }

  // Assistant: one entry per block, so a turn's text and its calls can be
  // evicted independently.
  const out: Rendered[] = [];
  for (const block of message.content) {
    if (block.type === 'text') {
      if (block.text.trim().length === 0) continue;
      out.push({ text: `ASSISTANT: ${clip(block.text, COMPACTION_LIMITS.assistantChars)}`, pinned: false });
    } else if (block.type === 'tool_call') {
      const args = clip(JSON.stringify(block.args ?? {}), COMPACTION_LIMITS.toolArgChars);
      out.push({ text: `CALL ${block.toolName}(${args})`, pinned: false });
    }
    // `thinking` blocks are DROPPED ENTIRELY (D-8): they are the model's private
    // scratch, they are the single largest contributor at `thinkingLevel: high`,
    // and nothing after the turn depends on them.
  }
  return out;
}

export interface DigestInput {
  /** The head — `messages[protectedPrefix..cutIndex)`. */
  head: readonly Message[];
  /**
   * The summarizer's own context window, or `undefined` when it is unknown.
   *
   * NOT the lead model's. This is the whole reason a digest exists rather than
   * raw messages (R-4).
   */
  summarizerWindow?: number;
}

export interface DigestResult {
  text: string;
  /** Entries the budget forced out. `> 0` means the marker is present. */
  omitted: number;
  /** The budget actually used, after the window derivation. */
  budgetChars: number;
}

/**
 * The character budget for one digest.
 *
 * `min(digestMaxChars, (summarizerWindow - summarizerReserveTokens) * CHARS_PER_TOKEN)`.
 * `CHARS_PER_TOKEN` comes from core (P2-3) rather than being re-spelled here: two
 * chars-per-token constants that must agree and nothing checking that they do is
 * how a digest budget and an occupancy estimate drift apart.
 */
export function digestBudgetChars(summarizerWindow?: number): number {
  const ceiling = COMPACTION_LIMITS.digestMaxChars;
  if (!summarizerWindow || summarizerWindow <= 0) return ceiling;
  const usableTokens = summarizerWindow - COMPACTION_LIMITS.summarizerReserveTokens;
  if (usableTokens <= 0) return ceiling;
  return Math.min(ceiling, usableTokens * CHARS_PER_TOKEN);
}

/**
 * Render the head into a bounded transcript.
 *
 * OLDEST ENTRIES ARE DROPPED FIRST, except the pinned `PRIOR SUMMARY`, which is
 * evicted last of all. A single omission marker is prepended so the summary can
 * say that it is incomplete instead of pretending.
 */
export function buildDigest(input: DigestInput): DigestResult {
  const budgetChars = digestBudgetChars(input.summarizerWindow);
  const entries = input.head.flatMap(renderMessage);

  const sep = '\n';
  let total = entries.reduce((acc, e) => acc + e.text.length + sep.length, 0);
  if (total <= budgetChars) {
    return { text: entries.map((e) => e.text).join(sep), omitted: 0, budgetChars };
  }

  // Evict oldest-first among the unpinned. The marker itself costs characters,
  // so it is charged up front against a worst-case width.
  const kept = [...entries];
  let omitted = 0;
  let reserve = OMISSION_MARKER(entries.length).length + sep.length;
  for (let i = 0; i < kept.length && total + reserve > budgetChars; i += 1) {
    const entry = kept[i]!;
    if (entry.pinned) continue;
    total -= entry.text.length + sep.length;
    kept[i] = { text: '', pinned: false };
    omitted += 1;
  }

  // Still over budget with only pinned entries left: clip the pinned text rather
  // than dropping it, so the densest record survives in some form.
  if (total + reserve > budgetChars) {
    const room = Math.max(0, budgetChars - reserve);
    const joined = kept.filter((e) => e.text.length > 0).map((e) => e.text).join(sep);
    return {
      text: `${OMISSION_MARKER(omitted)}${sep}${joined.slice(0, room)}`,
      omitted,
      budgetChars,
    };
  }

  const body = kept.filter((e) => e.text.length > 0).map((e) => e.text).join(sep);
  return {
    text: omitted > 0 ? `${OMISSION_MARKER(omitted)}${sep}${body}` : body,
    omitted,
    budgetChars,
  };
}
