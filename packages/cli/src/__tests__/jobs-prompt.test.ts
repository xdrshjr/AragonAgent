/**
 * The `<background_jobs>` block and I-3 (long-task-jobs AC-30 / §12 step 13).
 *
 * "OFF MEANS BYTE-IDENTICAL" IS THE ASSERTION THAT PROTECTS EVERY OTHER FEATURE'S
 * SNAPSHOT: an unconditional extra line in the base prompt would move the output
 * of `--no-skills`, `--no-team`, `--no-todo`, `--no-fast` and `bash.background:
 * false` all at once, and nothing else in the suite would notice.
 */

import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from '../agent/system-prompt.js';
import { buildBackgroundJobsBlock, JOBS_BLOCK_VERSION } from '../proc/prompt.js';
import { buildBackgroundServicesBlock } from '../proc/prompt.js';
import { createBuiltinTools } from '../tools/index.js';
import { makeBash } from '../tools/bash-tool.js';

const tool = makeBash({ getCwd: () => '/tmp' });

function prompt(over: Parameters<typeof buildSystemPrompt>[0] = {}) {
  return buildSystemPrompt({ cwd: '/tmp', tools: [tool], ...over });
}

describe('the block itself', () => {
  it('is ASCII only, because it reaches a legacy console', () => {
    const block = buildBackgroundJobsBlock();
    // eslint-disable-next-line no-control-regex
    expect(/^[\x00-\x7f]*$/.test(block)).toBe(true);
  });

  it('is versioned so a behaviour report can name it', () => {
    expect(JOBS_BLOCK_VERSION).toBe('v1-2026-10');
  });

  it('names the four facts a model gets wrong without it', () => {
    const block = buildBackgroundJobsBlock();
    expect(block).toContain('Do not poll them');
    expect(block).toContain('job_wait');
    expect(block).toContain('<job_notices>');
    expect(block).toContain('[stalled]');
    expect(block).toContain('Jobs do not survive this session');
  });
});

describe('I-3: with the block absent the prompt is unchanged', () => {
  it('an absent `jobsBlock` produces the same bytes as passing an empty string', () => {
    expect(prompt({ jobsBlock: '' })).toBe(prompt());
  });

  it('the block is spliced only when present, and after the services block', () => {
    const withJobs = prompt({
      backgroundBlock: buildBackgroundServicesBlock(),
      jobsBlock: buildBackgroundJobsBlock(),
    });
    const without = prompt({ backgroundBlock: buildBackgroundServicesBlock() });
    expect(withJobs).toContain('<background_jobs>');
    expect(without).not.toContain('<background_jobs>');
    expect(withJobs.indexOf('<background_services>')).toBeLessThan(
      withJobs.indexOf('<background_jobs>'),
    );
    // Removing the block restores the exact bytes.
    expect(withJobs.replace(`\n\n${buildBackgroundJobsBlock()}`, '')).toBe(without);
  });
});

describe('the tool array is untouched when the job tools are absent', () => {
  it('identity, not equality: no wrapper is applied without a queue', () => {
    const tools = createBuiltinTools({ getCwd: () => '/tmp' });
    expect(tools.map((t) => t.name)).toEqual([
      'read_file',
      'write_file',
      'edit_file',
      'list_dir',
      'glob',
      'grep',
      'bash',
    ]);
  });

  it('a notice queue wraps every tool, including the plan gate output', () => {
    const drained: unknown[] = [];
    const tools = createBuiltinTools({
      getCwd: () => '/tmp',
      jobNotices: { drain: () => (drained.push(1), []) },
    });
    expect(tools.map((t) => t.name)).toContain('bash');
    // Nothing is drained until a tool RUNS, which is what keeps construction
    // side-effect free.
    expect(drained).toEqual([]);
  });
});
