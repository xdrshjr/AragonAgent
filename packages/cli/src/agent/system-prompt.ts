/**
 * Default system-prompt builder.
 *
 * The prompt is English (this package follows the argon-agent-core repo
 * conventions, not AragonMesh's Chinese-UI rule — spec §2.2 / R11). It pins the
 * exact OS + shell so the model emits compatible shell syntax (R7), and lists
 * the available tools with their working directory.
 */

import os from 'node:os';
import process from 'node:process';
import type { AgentTool } from '@argon-agent/core';

export interface SystemPromptParams {
  cwd: string;
  tools: AgentTool[];
}

/** Describe the active shell so the model does not emit incompatible syntax. */
export function describeShell(): { shell: string; osLabel: string } {
  const platform = process.platform;
  if (platform === 'win32') {
    const comspec = process.env.ComSpec ?? 'cmd.exe';
    const shell = /powershell|pwsh/i.test(comspec) ? 'PowerShell' : 'cmd.exe';
    return { shell, osLabel: `Windows (${os.release()})` };
  }
  const shell = process.env.SHELL ?? '/bin/sh';
  const osLabel = platform === 'darwin' ? `macOS (${os.release()})` : `${platform} (${os.release()})`;
  return { shell, osLabel };
}

export function buildSystemPrompt(params: SystemPromptParams): string {
  const { shell, osLabel } = describeShell();
  const toolList = params.tools
    .map((t) => `- ${t.name}: ${t.description.split('\n')[0]}`)
    .join('\n');

  const shellGuidance =
    process.platform === 'win32'
      ? `The bash tool runs commands through ${shell}. Emit ${shell}-compatible syntax only: do NOT use "&&"/"||" chaining or "mkdir -p" if the shell is cmd.exe; run one command per call, or use a cross-platform Node/Python one-liner when in doubt.`
      : `The bash tool runs commands through ${shell} ("/bin/sh -c"). Standard POSIX syntax is fine.`;

  return [
    'You are ArgonAgent, an autonomous coding assistant operating inside a terminal (TUI).',
    'You help the user accomplish software-engineering tasks by reasoning step by step and using the provided tools.',
    '',
    'Environment:',
    `- Operating system: ${osLabel}`,
    `- Shell: ${shell}`,
    `- Working directory: ${params.cwd}`,
    '',
    'Available tools:',
    toolList,
    '',
    'Operating guidance:',
    '- Prefer reading files and inspecting the workspace before making changes.',
    '- Make focused edits with edit_file; create new files with write_file.',
    `- ${shellGuidance}`,
    '- All file paths passed to tools resolve against the working directory above unless absolute.',
    '- You run at full permission with no sandbox - be careful with destructive commands.',
    '- When the task is complete, stop and give the user a concise summary.',
    '- Respond in the language the user writes in.',
  ].join('\n');
}
