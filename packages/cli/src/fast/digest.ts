/**
 * `buildReviewDigest` — the bounded text one review is asked about
 * (fast-model-tier §3.5.2). PURE: no I/O, no clock, no state.
 *
 * ASCII ONLY: `src/fast/**` is inside the glyph scanner's scope.
 *
 * THE REVIEWER NEVER READS `agent.state.messages`, AND THAT IS THE SINGLE MOST
 * IMPORTANT ECONOMIC DECISION IN THE FEATURE (D-6 / R-2). That history holds
 * whole file bodies: a session that has read four 60 KB files carries 240 KB of
 * them. Shipping it to the "cheap" model to ask whether the run is on track
 * would make a review cost MORE than the main-model turn it is reviewing - the
 * exact inversion this feature exists to prevent. The digest is bounded at
 * `FAST_LIMITS.digestMaxChars` BY CONSTRUCTION, so a review's input cost is flat
 * regardless of session length.
 *
 * Anyone tempted to "just pass the messages, the model has the context anyway"
 * is about to turn a 400-token call into a 60 000-token one, and nothing in the
 * UI would show it except the bill.
 */

import { FAST_LIMITS } from './limits.js';
import type { TurnFrame } from './types.js';

export interface ReviewDigestParams {
  /** The reviewer's ring buffer, oldest first. */
  frames: TurnFrame[];
  /** The user's request for this run, already clamped by the caller. */
  goal: string;
  /** `fast.reviewContextTurns` — how many SEALED frames to include. */
  contextTurns: number;
}

/** Clip to `maxChars` on a word boundary when one is close enough to matter. */
function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const space = cut.lastIndexOf(' ');
  return space > maxChars * 0.6 ? cut.slice(0, space) : cut;
}

/** One tool as the digest names it: `read_file(src/app.ts) 12ms`. */
function renderTool(tool: TurnFrame['tools'][number]): string {
  const arg = tool.arg ? `(${clip(tool.arg, FAST_LIMITS.toolArgChars)})` : '';
  const failed = tool.isError ? ' FAILED' : '';
  const ms = tool.ms === undefined ? '' : ` ${Math.round(tool.ms)}ms`;
  return `${tool.name}${arg}${failed}${ms}`;
}

function renderFrame(frame: TurnFrame): string[] {
  const lines = [`Turn ${frame.index}:`];
  if (frame.tools.length > 0) {
    lines.push(`  tools: ${frame.tools.map(renderTool).join(', ')}`);
  } else {
    lines.push('  tools: (none)');
  }
  if (frame.error) lines.push(`  error: ${clip(frame.error, 200)}`);
  const tail = frame.textTail.trim();
  if (tail.length > 0) lines.push(`  said: ${clip(tail, FAST_LIMITS.turnTailChars)}`);
  return lines;
}

/**
 * Build the digest.
 *
 * SEALED FRAMES ONLY (RV-2 / D-22). The turn being reviewed is sealed by
 * definition - sealing is what triggered the review - so the window is the
 * newest `contextTurns` sealed frames, and a frame that is still accumulating is
 * never half-rendered into a prompt.
 *
 * NEWEST FRAMES SURVIVE THE BOUND. When the assembled text exceeds
 * `digestMaxChars` the OLDEST frame is dropped and the document is rebuilt,
 * because the reviewer's question is about what just happened. Trimming from the
 * tail would hand it the beginning of a run and ask about the end of one.
 */
export function buildReviewDigest(params: ReviewDigestParams): string {
  const sealed = params.frames.filter((f) => f.sealed);
  const want = Math.max(1, Math.floor(params.contextTurns) || 1);
  let window = sealed.slice(-want);

  const goal = clip(params.goal.trim(), FAST_LIMITS.goalChars);
  const assemble = (frames: TurnFrame[]): string =>
    [
      `Goal: ${goal.length > 0 ? goal : '(not captured)'}`,
      '',
      ...frames.flatMap(renderFrame),
    ].join('\n');

  let out = assemble(window);
  while (out.length > FAST_LIMITS.digestMaxChars && window.length > 1) {
    window = window.slice(1);
    out = assemble(window);
  }
  // A single frame can still be over budget on its own (a 600-char tail plus
  // twelve tools), so the hard clamp is unconditional. It is a CEILING, not the
  // trimming strategy: the loop above is what decides WHAT is lost.
  return out.length > FAST_LIMITS.digestMaxChars
    ? out.slice(0, FAST_LIMITS.digestMaxChars)
    : out;
}
