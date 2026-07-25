/**
 * One-shot / print mode (spec §3.7). No Ink: stream `text_delta` to stdout,
 * compact tool lines to stderr, then a usage footer. Exit-code correctness is
 * derived from the event stream (R2), not from the resolved promise:
 *   0 = success, 1 = agent error (incl. a silently-swallowed throw), 2 = config.
 */

import type { AgentEvent, ModelInfo, TokenUsage } from '@argon-agent/core';
import { formatCost, formatTokens, computeCost } from './usage.js';
import { formatStreamError } from './reducer.js';
import type { PreflightResult } from './controller.js';

/** The minimal controller surface headless mode needs (real or stubbed). */
export interface HeadlessController {
  preflight(): PreflightResult;
  subscribe(listener: (event: AgentEvent) => void): () => void;
  prompt(text: string): Promise<void>;
  getModelInfo(): ModelInfo;
}

export interface HeadlessOptions {
  quiet?: boolean;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

/** Run a single prompt headlessly and resolve with the process exit code. */
export async function runHeadless(
  controller: HeadlessController,
  prompt: string,
  options: HeadlessOptions = {},
): Promise<number> {
  const out = options.stdout ?? process.stdout;
  const err = options.stderr ?? process.stderr;
  const quiet = options.quiet ?? false;

  const pre = controller.preflight();
  if (!pre.ok) {
    err.write(`${pre.message ?? 'Configuration error.'}\n`);
    return 2;
  }

  let errored = false;
  let sawTurnEnd = false;
  let wroteText = false;
  const total: TokenUsage = { inputTokens: 0, outputTokens: 0 };

  const unsubscribe = controller.subscribe((event: AgentEvent) => {
    switch (event.type) {
      case 'message_update': {
        const se = event.streamEvent;
        if (se.type === 'text_delta') {
          out.write(se.delta);
          wroteText = true;
        } else if (se.type === 'error') {
          errored = true;
          err.write(`\n${formatStreamError(se.error)}\n`);
        }
        break;
      }
      case 'tool_execution_start':
        if (!quiet) err.write(`\n▸ ${event.toolName}`);
        break;
      case 'tool_execution_end':
        if (!quiet) {
          err.write(` (${event.duration}ms)${event.isError ? ' [error]' : ''}\n`);
        }
        break;
      case 'turn_end':
        sawTurnEnd = true;
        total.inputTokens += event.usage.inputTokens;
        total.outputTokens += event.usage.outputTokens;
        break;
      case 'agent_end':
        // A swallowed throw (missing key / empty stream) produces no turn_end.
        if (!sawTurnEnd && !errored) errored = true;
        break;
      default:
        break;
    }
  });

  try {
    await controller.prompt(prompt);
  } finally {
    unsubscribe();
  }

  // Ensure a trailing newline so piped output is well-formed.
  if (wroteText) out.write('\n');

  if (!quiet) {
    const cost = computeCost(total, controller.getModelInfo().cost);
    err.write(
      `\n[usage] in ${formatTokens(total.inputTokens)} · out ${formatTokens(
        total.outputTokens,
      )} · ${formatCost(cost)}\n`,
    );
  }

  return errored ? 1 : 0;
}
