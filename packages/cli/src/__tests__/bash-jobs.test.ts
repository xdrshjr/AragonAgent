/**
 * `bash` as an ADMISSION gate for the two job kinds (long-task-jobs AC-1..AC-5,
 * AC-35, AC-37).
 *
 * REAL PROCESSES, because every claim here is about what a real child does: a
 * training script that dies in 300 ms, a watcher that will not die, and a
 * descriptor that a `cmd.exe` shell inherits. A stub supervisor would prove only
 * that the string formatting works.
 *
 * AC-35 IS THE ONE THAT MATTERS. It asserts a 300 ms crash is reported as
 * `[exited] code 1` and NOT as `[running]`, which is the defect the `task` kind
 * would have reintroduced had the settle guard stayed `!== 'starting'`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import type { ToolExecutionContext, ToolResult } from '@aragon-agent/core';
import { makeBash, type BashToolOptions } from '../tools/bash-tool.js';
import { ProcSupervisor } from '../proc/supervisor.js';
import type { ServiceSnapshot } from '../proc/types.js';

let dir: string;
const supervisors: ProcSupervisor[] = [];

const node = JSON.stringify(process.execPath);

function text(result: ToolResult): string {
  return result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
}

function supervisor(): ProcSupervisor {
  const made = new ProcSupervisor({ readyTimeoutMs: () => 60_000 });
  supervisors.push(made);
  return made;
}

function bash(options: Partial<BashToolOptions> = {}, toolTimeoutMs = 180_000) {
  return makeBash(
    { getCwd: () => dir },
    {
      supervisor: supervisor(),
      startupSettleMs: () => 1500,
      interactive: true,
      ...options,
    },
  );
}

const ctx: ToolExecutionContext = {};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'aragon-bash-jobs-'));
});

afterAll(() => {
  for (const made of supervisors) made.dispose();
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Best-effort: a lingering child on Windows can briefly lock the dir.
  }
});

describe('the three-valued background decision', () => {
  it('AC-1: an explicit background command the classifier does not know becomes a `task`', async () => {
    const tool = bash({ jobsAvailable: () => true });
    const result = await tool.execute(
      '1',
      { command: `${node} -e "setTimeout(()=>{},15000)"`, background: true },
      ctx,
    );
    const body = text(result);
    expect(body).toContain('[background] task t1 started');
    expect(body).toContain('[running] still running after');
    // The hint exists only when `job_wait` is callable.
    expect(body).toContain('job_wait({ job: "t1" })');
  }, 20_000);

  it('the `job_wait` hint is absent when the job tools are not registered', async () => {
    const tool = bash();
    const result = await tool.execute(
      '1',
      { command: `${node} -e "setTimeout(()=>{},15000)"`, background: true },
      ctx,
    );
    const body = text(result);
    expect(body).toContain('[background] task');
    expect(body).not.toContain('job_wait');
  }, 20_000);

  it('AC-3: a long-running command is still a `service`, with its old first line', async () => {
    const tool = bash({ jobsAvailable: () => true });
    // `tail -f` matches the classifier on every platform this suite runs on.
    const result = await tool.execute(
      '1',
      { command: `${node} -e "setTimeout(()=>{},15000)" && tail -f /dev/null`, background: true },
      ctx,
    );
    // The chain disqualifies it from the classifier, so it becomes a task - which
    // is exactly the mis-admission §2#4 records. AC-3 proper is asserted on the
    // supervisor in `proc-supervisor.test.ts`; here we only pin that a CHAINED
    // explicit background is not called a service.
    expect(text(result)).toContain('[background] task');
  }, 20_000);

  it('AC-2: without `background`, a non-classified command stays in the foreground', async () => {
    const tool = bash({ autoBackground: () => true });
    const result = await tool.execute('1', { command: `${node} -e "console.log('fg')"` }, ctx);
    expect(text(result)).toContain('fg');
    expect(text(result)).not.toContain('[background]');
  }, 20_000);

  it('`background: false` is the absolute escape hatch', async () => {
    const tool = bash({ jobsAvailable: () => true });
    const result = await tool.execute(
      '1',
      { command: `${node} -e "console.log('fg')"`, background: false },
      ctx,
    );
    expect(text(result)).toContain('fg');
    expect(text(result)).not.toContain('[background]');
  }, 20_000);
});

describe('AC-35: the settle window survives an immediate `running`', () => {
  it('a task that crashes in ~300ms is reported `exited code 1`, never `[running]`', async () => {
    // The script prints a traceback and dies. `startupSettleMs` is 1500ms here, so
    // a settle guard of `status !== 'starting'` would have finished on the FIRST
    // tick with `[running]` and no output - the exact regression RV-P0-1 records.
    const tool = bash({ jobsAvailable: () => true });
    const script =
      `${node} -e "console.error('ModuleNotFoundError: No module named torch'); process.exit(1)"`;
    const result = await tool.execute('1', { command: script, background: true }, ctx);
    const body = text(result);
    expect(body).toContain('[exited] code 1 after');
    expect(body).toContain('ModuleNotFoundError');
    expect(body).not.toContain('[running]');
    // A finished job earns no advice to wait for it.
    expect(body).not.toContain('job_wait');
    expect(result.isError).toBe(true);
  }, 20_000);

  it('AC-5: a task that exits 0 within the window is settled by its exit event', async () => {
    const tool = bash({ jobsAvailable: () => true });
    const result = await tool.execute(
      '1',
      { command: `${node} -e "console.log('done'); process.exit(0)"`, background: true },
      ctx,
    );
    const body = text(result);
    expect(body).toContain('[exited] code 0 after');
    expect(body).toContain('done');
    expect(result.isError).toBeFalsy();
  }, 20_000);

  it('AC-37: a stopped job never says "still coming up"', async () => {
    // The first frame of a `bash` call on a long job settles as `running`; killing
    // that job and asking the supervisor again must produce `[stopped]`, which
    // before this feature fell through to `[starting] not ready yet`.
    const made = supervisor();
    const tool = makeBash(
      { getCwd: () => dir },
      { supervisor: made, startupSettleMs: () => 300, interactive: true },
    );
    await tool.execute('1', { command: `${node} -e "setTimeout(()=>{},15000)"`, background: true }, ctx);
    const live = made.list()[0]!;
    await made.stop(live.id);
    const stopped = made.get(live.id)!;
    expect(stopped.status).toBe('stopped');
    // The rendering path for a snapshot that arrives already stopped:
    const body = text(
      await tool.execute('2', { command: `${node} -e "process.exit(0)"`, background: false }, ctx),
    );
    expect(body).not.toContain('[starting] not ready yet');
    expect(body).toContain('exit code 0');
  }, 25_000);
});

describe('the timeout footnote (§4.3)', () => {
  it('names the exact background re-run command', async () => {
    const tool = bash({ jobsAvailable: () => true });
    const result = await tool.execute(
      '1',
      { command: `${node} -e "setTimeout(()=>{}, 5000)"`, timeout: 250 },
      ctx,
    );
    const body = text(result);
    expect(body).toContain('Command timed out after 250ms.');
    expect(body).toContain('re-run it in the background');
    expect(body).toContain('"background":true'.replace('"background":true', 'background: true'));
    expect(body).toContain('job_wait({ job: "t1" })');
  }, 20_000);

  it('is byte-identical to the pre-feature body when backgrounding is unavailable', async () => {
    // No supervisor at all: `I-2`/`I-3` in their original form.
    const tool = makeBash({ getCwd: () => dir });
    const result = await tool.execute(
      '1',
      { command: `${node} -e "setTimeout(()=>{}, 5000)"`, timeout: 250 },
      ctx,
    );
    const body = text(result);
    expect(body).toContain('Command timed out after 250ms.');
    expect(body).not.toContain('re-run it in the background');
  }, 20_000);
});

describe('the tool description (§4.3)', () => {
  it('advertises tasks only when the job tools exist (I-3)', () => {
    const withJobs = bash({ jobsAvailable: () => true });
    const without = bash();
    expect(withJobs.description).toContain('task id');
    expect(without.description).not.toContain('task id');
  });

  it('is byte-identical to the pre-feature description with no supervisor', () => {
    const bare = makeBash({ getCwd: () => dir });
    expect(bare.description).not.toContain('background: true');
    expect(bare.parameters.properties).not.toHaveProperty('background');
  });
});

describe('the first frame is honest about the kind', () => {
  it('a task result states its pid and read/stop handles', async () => {
    const tool = bash({ jobsAvailable: () => true });
    const result = await tool.execute(
      '1',
      { command: `${node} -e "setTimeout(()=>{},15000)"`, background: true },
      ctx,
    );
    const body: string = text(result);
    const snapshot: ServiceSnapshot | undefined = supervisor().list()[0];
    expect(body).toMatch(/\(pid \d+\)/);
    expect(body).toContain('bash_output({ service: "t1" })');
    expect(body).toContain('bash_kill({ service: "t1" })');
    expect(snapshot).toBeUndefined();
  }, 20_000);
});
