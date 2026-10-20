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
import { isTerminalStatus, type JobKind, type ProcSupervisorPort, type ServiceSnapshot } from '../proc/types.js';

export interface ProcToolDeps {
  supervisor: ProcSupervisorPort;
}

/**
 * One line of status, shared by both tools so the two can never disagree.
 *
 * IT NAMES THE KIND, because `s1` and `t3` are two different things to be holding
 * and the model has to know which one it is looking at to decide whether waiting
 * is even meaningful.
 */
function statusLine(service: ServiceSnapshot): string {
  const bits: string[] = [`${service.kind} ${service.id}  ${service.status}`];
  if (service.url) bits.push(service.url);
  if (service.exitCode !== null) bits.push(`exit code ${service.exitCode}`);
  else if (service.signal) bits.push(`signal ${service.signal}`);
  if (service.killIncomplete) bits.push('(may have left a detached child)');
  return `${bits.join('  ')}\n$ ${service.command}`;
}

/** `[progress] 47%` and `[stalled] ...` - the two lines worth adding to a tail. */
function progressLines(service: ServiceSnapshot): string[] {
  const lines: string[] = [];
  if (service.progress) lines.push(`[progress] ${service.progress.text}`);
  if (service.stalled === true) {
    lines.push(
      '[stalled] no output for a while - it has not failed. Keep waiting, stop it ' +
        `with bash_kill({ service: "${service.id}" }), or read the tail.`,
    );
  }
  return lines;
}

export function makeBashOutput(deps: ProcToolDeps): AgentTool {
  return defineTool({
    name: 'bash_output',
    label: 'Job log',
    description:
      'Read a background job log tail and its current status. Pass the ' +
      '`since` cursor returned by a previous call to read only what is new. ' +
      'Accepts both ids: "s1" for a service and "t3" for a task. Use this to ' +
      'verify a service actually started, and to read a build or test watcher ' +
      'as it runs.',
    parameters: {
      type: 'object',
      properties: {
        service: { type: 'string', description: 'The job id: "s1" or "t3".' },
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
          `No job "${params.service}". Start one with bash({ command, background: true }).`,
        );
      }
      const page = deps.supervisor.read(params.service, params.since);
      const lines = [statusLine(service), ...progressLines(service)];
      if (page?.truncated) {
        // THE PATH IS THE ESCAPE HATCH (long-task-jobs §4.8). Past 200 rows the
        // ring has forgotten the error the model needs, and the full log is on
        // disk; naming it lets `grep`/`read_file` answer a question this buffer
        // no longer can.
        lines.push(
          `[note] older rows were dropped - the tail keeps the last ` +
            `${PROC_LIMITS.serviceTailRows} rows` +
            (service.logPath ? `. Full log: ${service.logPath}` : '.'),
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
    label: 'Stop job',
    description:
      'Stop a background job (service or task) by id, or every job with "all". ' +
      'Stop the jobs you started once you are finished with them, unless the ' +
      'user asked them to stay up.',
    parameters: {
      type: 'object',
      properties: {
        service: { type: 'string', description: 'The job id ("s1" or "t3"), or "all".' },
      },
      required: ['service'],
    },
    async execute(_id, rawParams) {
      const params = rawParams as { service: string };
      if (params.service !== 'all' && !deps.supervisor.get(params.service)) {
        return errorResult(`No job "${params.service}".`);
      }
      const stopped = await deps.supervisor.stop(params.service);
      if (stopped.length === 0) return textResult('Nothing to stop.');
      const lines = stopped.map((s) => statusLine(s));
      // A JOB THAT HAD ALREADY FINISHED IS NOT A STOP (AC-37). `stop()` returns
      // the snapshot either way, so the count has to exclude terminal records or
      // `bash_kill` reports having killed something that ended ten minutes ago.
      const ended = stopped.filter((s) => isTerminalStatus(s.status)).length;
      const killed = stopped.length - ended;
      const summary =
        killed === 0
          ? `Nothing to stop - ${stopped.length === 1 ? 'it had' : 'they had'} already finished.`
          : `Stopped ${killed} job${killed === 1 ? '' : 's'}.`;
      return textResult(`${summary}\n${lines.join('\n')}`);
    },
  });
}
