/**
 * Core Agent Loop — the heart of the engine.
 *
 * Implements the LLM call -> stream consumption -> tool execution -> loop
 * cycle, with steering/follow-up checkpoints and optional CodeAct code
 * block detection and execution.
 */

import type {
  AssistantMessage,
  Message,
  StreamEvent,
  ThinkingLevel,
  TokenUsage,
  ToolCallBlock,
  UserMessage,
} from '../llm/types.js';
import type { ProviderRegistry } from '../llm/providers/index.js';
import type { ToolExecutor } from '../tools/executor.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { AgentEvent, AgentEventListener } from '../types.js';
import type { MessageManager } from './message-manager.js';
import type { MessageQueueManager } from './steering.js';
import type {
  CompactionOutcome,
  CompactionTrigger,
  ContextManager,
} from './context-manager.js';
import { validateHistory } from './compaction.js';
import { acceptSteering } from './accept-steering.js';
import { estimatePromptTokens } from '../llm/output-limits.js';

// ---------------------------------------------------------------------------
// CodeAct sandbox — re-export the full interface from sandbox/types.ts
// ---------------------------------------------------------------------------

import type { CodeActSandbox } from '../sandbox/types.js';
export type { CodeActSandbox };
export type { ExecuteResult as CodeActResult } from '../sandbox/types.js';

// ---------------------------------------------------------------------------
// ModelRef
// ---------------------------------------------------------------------------

export interface ModelRef {
  providerId: string;
  modelId: string;
  baseUrl?: string;
}

// ---------------------------------------------------------------------------
// Loop context — all dependencies injected from Agent
// ---------------------------------------------------------------------------

export interface AgentLoopContext {
  providerRegistry: ProviderRegistry;
  toolRegistry: ToolRegistry;
  toolExecutor: ToolExecutor;
  messageManager: MessageManager;
  messageQueueManager: MessageQueueManager;
  getApiKey: (providerId: string) => string | undefined;
  emit: (event: AgentEvent) => void;
  sandbox?: CodeActSandbox;
  model: ModelRef;
  systemPrompt: string;
  thinkingLevel?: ThinkingLevel;
  /** Maximum output tokens per LLM call. `undefined` = use provider default. */
  maxTokens?: number;
  signal: AbortSignal;
  /**
   * Optional context-compaction port (context-auto-compaction §3.2).
   *
   * `undefined` MEANS THE ENGINE NEVER COMPACTS, and every code path is
   * byte-identical to a pre-feature build: the checkpoint below is one `if`
   * against a field that is genuinely absent, not a live object whose predicate
   * says no (AC-1).
   */
  contextManager?: ContextManager;
  timeouts: {
    llmCallTimeout: number;
    toolTimeout: number;
    codeTimeout: number;
    /**
     * The engine's ceiling on ONE `compact()` call. Defaults to
     * `COMPACTION_HARD_TIMEOUT_MS`.
     *
     * OVERRIDABLE ONLY SO AC-10a IS TESTABLE IN UNDER TWO MINUTES. It is NOT a
     * host policy knob: the whole point of the ceiling is that it does not depend
     * on the host being correct, so raising it in production re-opens exactly the
     * hang it exists to bound (P1-3 / R-13).
     */
    compactionHardTimeout?: number;
  };
}

// ---------------------------------------------------------------------------
// Compaction checkpoint (context-auto-compaction §3.3)
// ---------------------------------------------------------------------------

/**
 * A CEILING, NOT A POLICY (P1-3). It must sit STRICTLY ABOVE the largest wall
 * clock a well-behaved host can legitimately spend, or it starts firing on
 * correct hosts and the failure ladder's rungs stop being reachable. The CLI's
 * worst legal case is two `callTimeoutMs` calls back to back (45 s + 45 s = 90 s)
 * plus the digest render, so 90 s would be exactly the boundary — this is 120 s,
 * leaving 30 s of slack.
 *
 * It is deliberately longer than `DEFAULT_IDLE_TIMEOUT` (60 s): `compaction_start`
 * PAUSES the watchdog, so across this call this is the only clock running. An
 * `await` with no ceiling here would be strictly worse than the pre-feature
 * behaviour — a host that returns a non-settling promise would hang the run AND
 * there would be nothing left to notice.
 */
export const COMPACTION_HARD_TIMEOUT_MS = 120_000;

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Coerce whatever the host resolved with into a `CompactionOutcome`.
 *
 * THE TYPE IS NOT THE GUARANTEE (implementation finding IF-2). `ContextManager`
 * is an interface a host implements in its own package, so at this boundary the
 * value is untyped at runtime: a stub, a mock, a host that forgot a `return`, or
 * a `Promise<void>` all arrive here as `undefined`. Reading `.action` off that
 * throws OUTSIDE the inner `catch` — after `compaction_end` has been emitted from
 * the `finally`, so the watchdog is correctly resumed, but the throw still
 * escapes `runCompaction` and kills the run.
 *
 * That is exactly the failure §3.3 step 4 says must not happen: "a host that
 * breaks its own contract must degrade to 'compaction did not happen', never to
 * 'the run died'". The inner `catch` covers a REJECTED promise; this covers a
 * promise that resolves with the wrong thing, which is the commoner mistake.
 */
function normalizeOutcome(value: unknown): CompactionOutcome {
  const outcome = value as CompactionOutcome | null | undefined;
  if (!outcome || typeof outcome !== 'object') {
    return { action: 'keep', reason: 'manager_bad_outcome' };
  }
  if (outcome.action === 'replace') {
    if (!Array.isArray(outcome.messages)) {
      return { action: 'keep', reason: 'manager_bad_outcome' };
    }
    return outcome;
  }
  if (outcome.action === 'keep') return outcome;
  return { action: 'keep', reason: 'manager_bad_outcome' };
}

/**
 * Race the host's promise against the run's signal and a hard ceiling.
 *
 * RESOLVES rather than rejects on both loss conditions, so the two ladder rungs
 * stay distinguishable in the event and in the log. The losing promise is left
 * to settle on its own; its result is dropped, and it cannot reach `restore`
 * because `applied` is decided by the caller.
 */
async function raceCompaction(
  work: Promise<CompactionOutcome>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<CompactionOutcome> {
  if (signal.aborted) return { action: 'keep', reason: 'aborted' };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race<CompactionOutcome>([
      work,
      new Promise<CompactionOutcome>((resolve) => {
        timer = setTimeout(() => resolve({ action: 'keep', reason: 'manager_timeout' }), timeoutMs);
      }),
      new Promise<CompactionOutcome>((resolve) => {
        onAbort = (): void => resolve({ action: 'keep', reason: 'aborted' });
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

interface CompactionParams {
  trigger: CompactionTrigger;
  lastUsage: TokenUsage | undefined;
  turnIndex: number;
  hardTimeoutMs?: number;
}

/**
 * One compaction checkpoint. Returns whether a new history was ADOPTED.
 *
 * Five steps, and step 5 is the whole reason the engine is involved at all
 * (D-4): the host proposes, the engine validates, and an invalid history is
 * refused rather than adopted.
 */
async function runCompaction(ctx: AgentLoopContext, params: CompactionParams): Promise<boolean> {
  const cm = ctx.contextManager;
  if (!cm) return false; // 1. off: zero cost, zero allocation

  const probe = {
    messageCount: ctx.messageManager.length,
    trigger: params.trigger,
    turnIndex: params.turnIndex,
    ...(params.lastUsage ? { lastUsage: params.lastUsage } : {}),
  };

  let wanted = false;
  try {
    wanted = cm.shouldCompact(probe); // 2. sync gate
  } catch (err) {
    // A throwing predicate is a host bug, and it must not take the run down.
    ctx.emit({ type: 'compaction_start', trigger: params.trigger, messageCount: probe.messageCount });
    ctx.emit({
      type: 'compaction_end',
      applied: false,
      mode: 'none',
      reason: `manager_threw: ${errText(err)}`,
      messagesBefore: probe.messageCount,
      messagesAfter: probe.messageCount,
      droppedMessages: 0,
      estimatedTokensBefore: 0,
      estimatedTokensAfter: 0,
      durationMs: 0,
    });
    return false;
  }
  if (!wanted) return false;

  // A SHALLOW COPY, NOT THE LIVE ARRAY (P1-2). `getAll()` hands back the internal
  // array; `as Message[]` would launder away the only thing stopping a host from
  // mutating engine state in place, before step 5 can see it.
  const before = [...ctx.messageManager.getAll()];
  const estimatedTokensBefore = estimatePromptTokens(before, ctx.systemPrompt);

  // 3. Pauses the watchdog (`Agent.applyWatchdogPolicy`), applied BEFORE the
  //    listeners so a subscriber that throws cannot leave the run armed.
  ctx.emit({ type: 'compaction_start', trigger: params.trigger, messageCount: before.length });

  const started = Date.now();
  let applied = false;
  let mode: 'summarized' | 'truncated' | 'none' = 'none';
  let reason: string | undefined;
  let summary: string | undefined;
  let after: Message[] = before;

  try {
    let outcome: CompactionOutcome;
    try {
      // 4. BOUNDED AND RACED, because step 3 just switched the idle detector off.
      //    NORMALIZED, because the interface is not enforced at this boundary.
      outcome = normalizeOutcome(
        await raceCompaction(
          cm.compact({
            ...probe,
            messages: before,
            systemPrompt: ctx.systemPrompt,
            model: ctx.model,
            signal: ctx.signal,
          }),
          ctx.signal,
          params.hardTimeoutMs ?? ctx.timeouts.compactionHardTimeout ?? COMPACTION_HARD_TIMEOUT_MS,
        ),
      );
    } catch (err) {
      outcome = { action: 'keep', reason: `manager_threw: ${errText(err)}` };
    }

    if (outcome.action === 'keep') {
      reason = outcome.reason;
    } else {
      // 5. THE STRUCTURAL GATE. Positional `previousLength` keeps the `grew`
      //    rung live.
      const check = validateHistory(outcome.messages, { previousLength: before.length });
      if (check.ok) {
        ctx.messageManager.restore(outcome.messages);
        after = outcome.messages;
        applied = true;
        mode = outcome.mode;
        summary = outcome.summary;
        reason = outcome.reason;
      } else {
        reason = `invalid_history: ${check.reason}`;
      }
    }
  } finally {
    // IN A `finally`. `compaction_end` is what RESUMES the watchdog, so it must
    // be emitted on every exit from this function — including a `throw` that
    // escapes the two guards above. A compaction that failed to emit its `end`
    // leaves the run permanently deaf.
    ctx.emit({
      type: 'compaction_end',
      applied,
      mode,
      ...(reason !== undefined ? { reason } : {}),
      messagesBefore: before.length,
      messagesAfter: after.length,
      droppedMessages: Math.max(0, before.length - after.length),
      estimatedTokensBefore,
      estimatedTokensAfter: applied
        ? estimatePromptTokens(after, ctx.systemPrompt)
        : estimatedTokensBefore,
      ...(summary !== undefined ? { summary } : {}),
      durationMs: Date.now() - started,
    });
  }

  return applied;
}

// ---------------------------------------------------------------------------
// CodeAct regex for extracting ```execute-js blocks
// ---------------------------------------------------------------------------

const CODEACT_REGEX = /```execute-js\n([\s\S]*?)```/g;

/**
 * Extract all execute-js code blocks from assistant text.
 */
function extractCodeBlocks(text: string): string[] {
  const blocks: string[] = [];
  let match: RegExpExecArray | null;
  // Reset lastIndex for safety when reusing the regex.
  CODEACT_REGEX.lastIndex = 0;
  while ((match = CODEACT_REGEX.exec(text)) !== null) {
    const code = match[1];
    if (code && code.trim().length > 0) {
      blocks.push(code);
    }
  }
  return blocks;
}

/**
 * Collect all text content from an AssistantMessage's content blocks.
 */
function getAssistantText(message: AssistantMessage): string {
  return message.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { text: string }).text)
    .join('\n');
}

/**
 * Collect tool call blocks from an AssistantMessage.
 */
function getToolCalls(message: AssistantMessage): ToolCallBlock[] {
  return message.content.filter(
    (b): b is ToolCallBlock => b.type === 'tool_call',
  );
}

/** Close the outstanding tool batch before steering creates the next user turn. */
function acceptToolSteering(ctx: AgentLoopContext, remainingCalls: ToolCallBlock[]): boolean {
  if (ctx.signal.aborted || !ctx.messageQueueManager.hasSteering()) return false;
  for (const skipped of remainingCalls) {
    ctx.messageManager.push({
      role: 'tool_result',
      toolCallId: skipped.toolCallId,
      content: 'Tool execution skipped due to steering interrupt.',
      isError: true,
    });
  }
  acceptSteering(ctx);
  return true;
}

// ---------------------------------------------------------------------------
// runAgentLoop
// ---------------------------------------------------------------------------

/**
 * Run the Agent loop until completion, steering exhaustion, or abort.
 *
 * This function is invoked by `Agent.prompt()` and `Agent.continue()`.
 * It mutates the messageManager and emits events through the provided
 * context.  All errors are caught — the caller (Agent) is responsible
 * for emitting `agent_end` in its own finally block.
 */
export async function runAgentLoop(ctx: AgentLoopContext): Promise<void> {
  // ----- Compaction bookkeeping (context-auto-compaction §3.3) --------------
  //
  // ALL THREE ARE HOISTED ABOVE THE `while`, and only two of them are ever reset
  // inside it — after a stream COMPLETES, never at the top of the loop.
  /** Authoritative usage of the most recently completed turn (P1-1). */
  let lastUsage: TokenUsage | undefined;
  /** 1-based, ONE PER ITERATION — guard 1's cooldown unit (P2-1). */
  let turnIndex = 0;
  /** NOT RESET AT THE TOP OF THE LOOP (P0-1). See the note at `turn_end`. */
  let overflowRecovered = false;

  while (!ctx.signal.aborted) {
    // ----- Steering checkpoint (before LLM call) -----
    acceptSteering(ctx);

    turnIndex += 1;

    // ----- Context pressure checkpoint (context-auto-compaction §3.3) -----
    //
    // PLACEMENT IS LOAD-BEARING IN THREE WAYS.
    //   1. AFTER the steering drain, so a message the user just steered in is
    //      part of the history being measured and is inside the retained tail by
    //      construction (it is the newest message).
    //   2. BEFORE `turn_start`, so the UI reads compaction as a phase of its own
    //      rather than as a stall inside a turn.
    //   3. INSIDE the `while`, not before it. A run that starts under the
    //      threshold and crosses it at turn 12 is the normal case, and it is the
    //      case an `agent_end`-based design cannot serve at all (D-1).
    if (await runCompaction(ctx, { trigger: 'pressure', lastUsage, turnIndex })) {
      lastUsage = undefined;
    }
    if (ctx.signal.aborted) break;

    // ----- Turn start -----
    ctx.emit({ type: 'turn_start' });

    // ----- Build LLM request -----
    const apiKey = ctx.getApiKey(ctx.model.providerId);
    if (!apiKey) {
      throw new Error(
        `No API key available for provider "${ctx.model.providerId}". ` +
        'Please configure the API key in Settings.',
      );
    }

    const toolDefs = ctx.toolRegistry.toToolDefinitions();
    const messages = ctx.messageManager.getAll() as Message[];

    // ----- Stream LLM response -----
    let assistantMessage: AssistantMessage | undefined;
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

    const stream = ctx.providerRegistry.stream(ctx.model.providerId, {
      model: ctx.model.modelId,
      messages,
      systemPrompt: ctx.systemPrompt,
      tools: toolDefs.length > 0 ? toolDefs : undefined,
      apiKey,
      baseUrl: ctx.model.baseUrl,
      signal: ctx.signal,
      thinkingLevel: ctx.thinkingLevel,
      maxTokens: ctx.maxTokens,
    });

    try {
      for await (const event of stream) {
        if (ctx.signal.aborted) break;

        // Forward every stream event to subscribers.
        ctx.emit({ type: 'message_update', streamEvent: event });

        if (event.type === 'done') {
          assistantMessage = event.message;
          usage = event.usage;
        } else if (event.type === 'error') {
          throw event.error;
        }
      }
    } catch (err) {
      // ----- Reactive compaction (context-auto-compaction §3.5) -----
      //
      // The static context window is a GUESS for anything the table has not seen
      // (`buildRuntimeModel` returns 128 000 for every unknown model), so a proxy
      // in front of a 32 k model refuses the request before the proactive trigger
      // could ever fire. One recovery turns that from a dead run into a re-send.
      //
      // STRUCTURAL CHECK, NOT `instanceof LLMError`: the error may have crossed a
      // module boundary or been rebuilt, and an identity check on the class is the
      // version of this test that fails in production and passes in the unit test
      // (`retry.ts::isRetryableError` records the same reasoning).
      const errorType = (err as { errorType?: unknown } | null)?.errorType;
      if (errorType !== 'context_overflow' || overflowRecovered || !ctx.contextManager) throw err;
      overflowRecovered = true;
      const recovered = await runCompaction(ctx, { trigger: 'overflow', lastUsage, turnIndex });
      if (recovered) lastUsage = undefined;
      if (!recovered) throw err;
      if (ctx.signal.aborted) break;
      continue; // re-send this turn against the compacted history
    }

    if (ctx.signal.aborted) break;

    if (!assistantMessage) {
      // Stream ended without a 'done' event — treat as an error.
      throw new Error('LLM stream ended without producing a done event');
    }

    // ----- Turn end -----
    ctx.emit({ type: 'turn_end', message: assistantMessage, usage });
    // THE TWO LINES THE COMPACTION PROBE DEPENDS ON, and both are cleared HERE
    // rather than at the top of the loop.
    //
    // Without the first, `lastUsage` is forever `undefined`, every trigger runs
    // on the crude estimate, and the status bar and the trigger diverge — the
    // exact defect the shared `occupiedTokens` exists to close, reintroduced
    // silently (P1-1).
    //
    // Without the second — or with it moved to the top of the `while` — the
    // one-shot overflow guard would not exist at all: §3.5's recovery ends in
    // `continue`, which re-enters the loop, so a top-of-loop reset would clear
    // the flag on the way back in and a session whose tail alone cannot fit
    // would compact on every pass (P0-1). Clearing it after a stream COMPLETES
    // is the correct expression of the intent: the flag means "this turn has
    // already spent its one overflow recovery", and a turn that never produced a
    // `done` event has not finished.
    lastUsage = usage;
    overflowRecovered = false;
    ctx.messageManager.push(assistantMessage);
    if (ctx.signal.aborted) break;

    // ----- Process tool calls -----
    const toolCalls = getToolCalls(assistantMessage);
    const hasToolCalls = toolCalls.length > 0;
    let steeringInterrupted = false;

    if (hasToolCalls) {
      // Steering checkpoint: if steering arrived during the LLM call,
      // skip tool execution and inject steering messages instead.
      if (acceptToolSteering(ctx, toolCalls)) {
        // Loop continues — LLM will see the steering messages.
        continue;
      }

      // Execute each tool call sequentially.
      for (const toolCall of toolCalls) {
        if (ctx.signal.aborted) break;

        // Check steering between individual tool executions.
        if (acceptToolSteering(ctx, toolCalls.slice(toolCalls.indexOf(toolCall)))) {
          steeringInterrupted = true;
          break;
        }

        ctx.emit({
          type: 'tool_execution_start',
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          args: toolCall.args,
        });

        const execResult = await ctx.toolExecutor.execute(
          toolCall.toolCallId,
          toolCall.toolName,
          toolCall.args,
          ctx.signal,
        );

        ctx.emit({
          type: 'tool_execution_end',
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          result: execResult.result,
          isError: execResult.isError,
          duration: execResult.duration,
        });

        // Build and push tool result message.
        const resultText = execResult.result.content
          .map((c) => (c.type === 'text' ? c.text : `[image: ${c.mediaType}]`))
          .join('\n');

        ctx.messageManager.push({
          role: 'tool_result',
          toolCallId: toolCall.toolCallId,
          content: resultText,
          isError: execResult.isError,
        });
      }

      if (ctx.signal.aborted) break;

      // If steering interrupted tool execution, skip CodeAct and continue
      // to the next loop iteration where the LLM sees the steering messages.
      if (steeringInterrupted) continue;
    }

    // ----- CodeAct code block detection -----
    const assistantText = getAssistantText(assistantMessage);
    const codeBlocks = extractCodeBlocks(assistantText);
    let hasCodeBlocks = codeBlocks.length > 0 && ctx.sandbox != null;

    if (hasCodeBlocks && ctx.sandbox) {
      for (const code of codeBlocks) {
        if (ctx.signal.aborted) break;

        ctx.emit({ type: 'code_execution_start', code, language: 'javascript' });

        const startTime = Date.now();
        let output = '';
        let error: string | undefined;

        try {
          const result = await ctx.sandbox.execute(code, {
            timeout: ctx.timeouts.codeTimeout,
            signal: ctx.signal,
          });

          // Build output from console entries and return value.
          const parts: string[] = [];
          for (const entry of result.consoleOutput) {
            const prefix = entry.level === 'log' ? '' : `[${entry.level}] `;
            parts.push(`${prefix}${entry.args.join(' ')}`);
          }
          if (result.returnValue !== undefined) {
            parts.push(`=> ${result.returnValue}`);
          }
          output = parts.join('\n');
          error = result.error?.message;
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
        }

        const duration = Date.now() - startTime;
        ctx.emit({ type: 'code_execution_end', output, error, duration });

        // Inject code execution result as a user message.
        let resultContent = '[Code Execution Result]\n';
        if (output) {
          resultContent += `Output: ${output}\n`;
        }
        if (error) {
          resultContent += `---\nError: ${error}\n`;
        }
        if (!output && !error) {
          resultContent += 'Output: (no output)\n';
        }

        const codeResultMsg: UserMessage = {
          role: 'user',
          content: resultContent,
          timestamp: Date.now(),
        };
        ctx.messageManager.push(codeResultMsg);
      }

      if (ctx.signal.aborted) break;

      // After code execution, continue the loop so LLM can react to results.
      continue;
    }

    // ----- Exit or follow-up checkpoint -----
    if (!hasToolCalls && !hasCodeBlocks) {
      // Give streaming and turn_end steering priority over follow-up and normal exit.
      if (ctx.messageQueueManager.hasSteering()) continue;
      if (ctx.messageQueueManager.hasFollowUp()) {
        const followUpMessages = ctx.messageQueueManager.drainFollowUp();
        for (const text of followUpMessages) {
          const userMsg: UserMessage = { role: 'user', content: text, timestamp: Date.now() };
          ctx.messageManager.push(userMsg);
        }
        // Continue loop with follow-up messages.
        continue;
      }

      // No more work — exit the loop.
      break;
    }

    // If we had tool calls (and they were executed), continue the loop
    // so the LLM can process tool results.
  }
}
