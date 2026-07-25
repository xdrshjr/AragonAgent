/**
 * bash tool — run a shell command at full permission (spec §3.6).
 *
 * Shell selection: Windows uses `process.env.ComSpec` (cmd.exe by default);
 * POSIX uses `/bin/sh -c`. The command's stdout+stderr and exit code are
 * captured. The `timeout?` param can only SHRINK within the executor ceiling
 * (the core ToolExecutor owns the real timeout + 100 KB truncation — R4), so
 * this tool does not re-implement an output cap.
 */

import { spawn } from 'node:child_process';
import process from 'node:process';
import {
  defineTool,
  errorResult,
  textResult,
  type AgentTool,
} from '@argon-agent/core';
import type { ChildProcess } from 'node:child_process';
import type { ToolDeps } from './fs-tools.js';

/**
 * Kill the whole process tree. With `shell:true` the direct child is the shell
 * wrapper, so on Windows we must `taskkill /t` to reach the grandchild; a plain
 * `child.kill()` would orphan it (leaving pipes open and cwd locked).
 */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
  } else {
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
}

export function makeBash(deps: ToolDeps): AgentTool {
  return defineTool({
    name: 'bash',
    label: 'Shell',
    description:
      'Run a shell command at full permission and return its combined ' +
      'stdout+stderr and exit code. `timeout` (ms) may only shrink within the ' +
      'agent tool-timeout ceiling; `cwd` defaults to the working directory. ' +
      'Emit shell syntax compatible with the OS/shell stated in the system prompt.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to run.' },
        timeout: { type: 'number', description: 'Optional timeout in milliseconds (shrinks within the ceiling).' },
        cwd: { type: 'string', description: 'Working directory for this command.' },
      },
      required: ['command'],
    },
    async execute(_id, rawParams, ctx) {
      const params = rawParams as { command: string; timeout?: number; cwd?: string };
      const command = params.command;
      const cwd = params.cwd ? params.cwd : deps.getCwd();

      return new Promise((resolvePromise) => {
        let child;
        try {
          // shell:true delegates to ComSpec (Windows) / /bin/sh (POSIX) and
          // handles command-line quoting far more reliably than a hand-built
          // cmd.exe arg array, which double-escapes nested quotes on Windows.
          child = spawn(command, {
            shell: true,
            cwd,
            env: process.env,
            windowsHide: true,
          });
        } catch (err) {
          resolvePromise(errorResult(err instanceof Error ? err.message : String(err)));
          return;
        }

        let output = '';
        let killedByTimeout = false;
        let settled = false;

        const finish = (fn: () => ReturnType<typeof textResult>) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolvePromise(fn());
        };

        // Self-timer for the `timeout` param (shrinks within the executor ceiling).
        let timer: NodeJS.Timeout | undefined;
        if (params.timeout && params.timeout > 0) {
          timer = setTimeout(() => {
            killedByTimeout = true;
            killTree(child);
          }, params.timeout);
        }

        // Cooperative cancellation via the executor/agent AbortSignal.
        const onAbort = () => {
          killTree(child);
        };
        ctx.signal?.addEventListener('abort', onAbort, { once: true });

        function cleanup(): void {
          if (timer) clearTimeout(timer);
          ctx.signal?.removeEventListener('abort', onAbort);
        }

        child.stdout?.on('data', (d) => {
          output += d.toString();
        });
        child.stderr?.on('data', (d) => {
          output += d.toString();
        });

        child.on('error', (err) => {
          finish(() => errorResult(`Failed to run command: ${err.message}`));
        });

        child.on('close', (code, signalName) => {
          const trimmed = output.length > 0 ? output : '(no output)';
          if (killedByTimeout) {
            finish(() =>
              errorResult(`Command timed out after ${params.timeout}ms.\n${trimmed}`),
            );
            return;
          }
          const status = code === null ? `signal ${signalName}` : `exit code ${code}`;
          const body = `$ ${command}\n${trimmed}\n[${status}]`;
          finish(() => (code === 0 ? textResult(body) : errorResult(body)));
        });
      });
    },
  });
}
