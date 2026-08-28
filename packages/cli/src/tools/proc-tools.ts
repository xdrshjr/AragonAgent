/**
 * `bash_output` and `bash_kill` — the model's two handles on a supervised
 * service (background-service-supervision §5.1).
 *
 * REGISTERED THROUGH A FACTORY OPTION, NEVER APPENDED AFTER THE FACT
 * (`tools/index.ts::procTools`). `tools.test.ts::C7` asserts `HOST_TOOL_NAMES`
 * equals what `createBuiltinTools` PRODUCES, so appending these in
 * `AgentController` after the factory returned would turn that test red with a
 * message about two lists of names that says nothing about background services —
 * the trap `teamTools` and `todoTools` each record in capitals.
 *
 * NEITHER JOINS `MUTATING_TOOLS` (P2-5). `bash_output` is a read. `bash_kill`
 * stops something THIS SESSION STARTED and is showing on screen, and the plan
 * gate already refuses it in plan mode; putting a `--confirm` modal between the
 * user and stopping their own runaway server is the wrong trade. `bash` itself
 * stays in `MUTATING_TOOLS` unchanged, including when `background: true` — the
 * command is still arbitrary.
 */

import { defineTool, errorResult, textResult, type AgentTool } from '@aragon-agent/core';
import { PROC_LIMITS } from '../proc/limits.js';
import type { ProcSupervisorPort, ServiceSnapshot } from '../proc/types.js';

export interface ProcToolDeps {
  supervisor: ProcSupervisorPort;
}

/** One line of status, shared by both tools so the two can never disagree. */
function statusLine(service: ServiceSnapshot): string {
  const bits: string[] = [`service ${service.id}  ${service.status}`];
  if (service.url) bits.push(service.url);
  if (service.exitCode !== null) bits.push(`exit code ${service.exitCode}`);
  else if (service.signal) bits.push(`signal ${service.signal}`);
  if (service.killIncomplete) bits.push('(may have left a detached child)');
  return `${bits.join('  ')}\n$ ${service.command}`;
}

export function makeBashOutput(deps: ProcToolDeps): AgentTool {
  return defineTool({
    name: 'bash_output',
    label: 'Service log',
    description:
      'Read a background service log tail and its current status. Pass the ' +
      '`since` cursor returned by a previous call to read only what is new. ' +
      'Use this to verify a service actually started, and to read a build or ' +
      'test watcher as it runs.',
    parameters: {
      type: 'object',
      properties: {
        service: { type: 'string', description: 'The service id, e.g. "s1".' },
        since: {
          type: 'number',
          description: 'Cursor from a previous call; omit to read the whole tail.',
        },
      },
      required: ['service'],
    },
    async execute(_id, rawParams) {
      const params = rawParams as { service: string; since?: number };
      const service = deps.supervisor.get(params.service);
      if (!service) {
        return errorResult(
          `No service "${params.service}". Start one with bash({ command, background: true }).`,
        );
      }
      const page = deps.supervisor.read(params.service, params.since);
      const lines = [statusLine(service)];
      if (page?.truncated) {
        lines.push(
          `[note] older rows were dropped - the tail keeps the last ` +
            `${PROC_LIMITS.serviceTailRows} rows.`,
        );
      }
      if (!page || page.rows.length === 0) {
        lines.push('(no new output)');
      } else {
        lines.push(...page.rows);
      }
      lines.push(`[cursor ${page?.cursor ?? service.rowsSeen}]`);
      return textResult(lines.join('\n'));
    },
  });
}

export function makeBashKill(deps: ProcToolDeps): AgentTool {
  return defineTool({
    name: 'bash_kill',
    label: 'Stop service',
    description:
      'Stop a background service by id, or every service with "all". Stop the ' +
      'services you started once you are finished with them, unless the user ' +
      'asked for them to stay up.',
    parameters: {
      type: 'object',
      properties: {
        service: { type: 'string', description: 'The service id, or "all".' },
      },
      required: ['service'],
    },
    async execute(_id, rawParams) {
      const params = rawParams as { service: string };
      if (params.service !== 'all' && !deps.supervisor.get(params.service)) {
        return errorResult(`No service "${params.service}".`);
      }
      const stopped = await deps.supervisor.stop(params.service);
      if (stopped.length === 0) return textResult('Nothing to stop.');
      const lines = stopped.map((s) => statusLine(s));
      return textResult(
        `Stopped ${stopped.length} service${stopped.length === 1 ? '' : 's'}.\n${lines.join('\n')}`,
      );
    },
  });
}
