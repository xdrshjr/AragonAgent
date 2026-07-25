/**
 * Built-in toolset assembly (spec §3.6). The core engine ships no tools, so the
 * CLI supplies the entire `tools: AgentTool[]` array: filesystem, search, and
 * shell — all at full permission.
 *
 * An optional `confirmTools` mode wraps the mutating tools (write_file /
 * edit_file / bash) in a Yes/No gate. It is off by default per the max-permission
 * requirement; when enabled, a `confirm` callback (wired by the TUI) is awaited
 * before the tool runs.
 */

import { errorResult, type AgentTool, type ToolResult } from '@argon-agent/core';
import type { ToolDeps } from './fs-tools.js';
import { makeReadFile, makeWriteFile, makeEditFile, makeListDir } from './fs-tools.js';
import { makeGlob, makeGrep } from './search-tools.js';
import { makeBash } from './bash-tool.js';

export interface ConfirmRequest {
  tool: string;
  summary: string;
}

export interface BuiltinToolsOptions {
  getCwd: () => string;
  /** When true (and `confirm` is provided), mutating tools are gated. */
  confirmTools?: boolean;
  /** Awaited before a mutating tool runs; resolve `false` to cancel. */
  confirm?: (req: ConfirmRequest) => Promise<boolean>;
}

const MUTATING_TOOLS = new Set(['write_file', 'edit_file', 'bash']);

function summarize(toolName: string, params: Record<string, unknown>): string {
  if (toolName === 'bash') return `Run: ${String(params.command ?? '')}`;
  if (toolName === 'write_file') return `Write: ${String(params.path ?? '')}`;
  if (toolName === 'edit_file') return `Edit: ${String(params.path ?? '')}`;
  return toolName;
}

/** Wrap a tool so its execution is gated behind a confirmation callback. */
function withConfirmation(
  tool: AgentTool,
  confirm: (req: ConfirmRequest) => Promise<boolean>,
): AgentTool {
  const original = tool.execute;
  return {
    ...tool,
    async execute(id, params, ctx): Promise<ToolResult> {
      const approved = await confirm({
        tool: tool.name,
        summary: summarize(tool.name, params as Record<string, unknown>),
      });
      if (!approved) return errorResult('Cancelled by user.');
      return original(id, params, ctx);
    },
  };
}

export function createBuiltinTools(options: BuiltinToolsOptions): AgentTool[] {
  const deps: ToolDeps = { getCwd: options.getCwd };

  let tools: AgentTool[] = [
    makeReadFile(deps),
    makeWriteFile(deps),
    makeEditFile(deps),
    makeListDir(deps),
    makeGlob(deps),
    makeGrep(deps),
    makeBash(deps),
  ];

  if (options.confirmTools && options.confirm) {
    const confirm = options.confirm;
    tools = tools.map((t) => (MUTATING_TOOLS.has(t.name) ? withConfirmation(t, confirm) : t));
  }

  return tools;
}
