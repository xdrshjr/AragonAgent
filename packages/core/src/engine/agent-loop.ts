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
  timeouts: {
    llmCallTimeout: number;
    toolTimeout: number;
    codeTimeout: number;
  };
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
  while (!ctx.signal.aborted) {
    // ----- Steering checkpoint (before LLM call) -----
    if (ctx.messageQueueManager.hasSteering()) {
      const steeringMessages = ctx.messageQueueManager.drainSteering();
      for (const text of steeringMessages) {
        const userMsg: UserMessage = { role: 'user', content: text, timestamp: Date.now() };
        ctx.messageManager.push(userMsg);
      }
      // Continue to LLM call with injected steering messages.
    }

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

    if (ctx.signal.aborted) break;

    if (!assistantMessage) {
      // Stream ended without a 'done' event — treat as an error.
      throw new Error('LLM stream ended without producing a done event');
    }

    // ----- Turn end -----
    ctx.emit({ type: 'turn_end', message: assistantMessage, usage });
    ctx.messageManager.push(assistantMessage);

    // ----- Process tool calls -----
    const toolCalls = getToolCalls(assistantMessage);
    const hasToolCalls = toolCalls.length > 0;
    let steeringInterrupted = false;

    if (hasToolCalls) {
      // Steering checkpoint: if steering arrived during the LLM call,
      // skip tool execution and inject steering messages instead.
      if (ctx.messageQueueManager.hasSteering()) {
        const steeringMessages = ctx.messageQueueManager.drainSteering();
        for (const text of steeringMessages) {
          const userMsg: UserMessage = { role: 'user', content: text, timestamp: Date.now() };
          ctx.messageManager.push(userMsg);
        }
        // Loop continues — LLM will see the steering messages.
        continue;
      }

      // Execute each tool call sequentially.
      for (const toolCall of toolCalls) {
        if (ctx.signal.aborted) break;

        // Check steering between individual tool executions.
        if (ctx.messageQueueManager.hasSteering()) {
          // Inject remaining tool results as errors so LLM knows they were skipped.
          const remainingCalls = toolCalls.slice(toolCalls.indexOf(toolCall));
          for (const skipped of remainingCalls) {
            ctx.messageManager.push({
              role: 'tool_result',
              toolCallId: skipped.toolCallId,
              content: 'Tool execution skipped due to steering interrupt.',
              isError: true,
            });
          }
          // Inject steering messages.
          const steeringMessages = ctx.messageQueueManager.drainSteering();
          for (const text of steeringMessages) {
            const userMsg: UserMessage = { role: 'user', content: text, timestamp: Date.now() };
            ctx.messageManager.push(userMsg);
          }
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
      // No tools and no code blocks — check for follow-up messages.
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
