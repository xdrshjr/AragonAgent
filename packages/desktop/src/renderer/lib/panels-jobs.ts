/**
 * The inspector's "Jobs" list: background commands and long tasks, one row per job id.
 *
 * The reducer rewrites a job's entry in place while it runs and appends a one-row "terminal"
 * marker when it ends, so the freshest state of a job is the LAST entry that is not such a
 * marker (falling back to the marker when that is all there is).
 */

import type { Entry } from '@aragon-agent/tui/model/agent/reducer';
import { isTerminalStatus } from '@aragon-agent/tui/model/proc/types';

export type JobEntry = Extract<Entry, { kind: 'service' }>;

export function latestJobs(entries: readonly Entry[]): JobEntry[] {
  const byId = new Map<string, JobEntry>();
  for (const entry of entries) {
    if (entry.kind !== 'service') continue;
    const held = byId.get(entry.serviceId);
    if (!held || entry.terminal !== true || held.terminal === true) byId.set(entry.serviceId, entry);
  }
  return [...byId.values()];
}

export function isJobLive(job: JobEntry): boolean {
  return !isTerminalStatus(job.status);
}
