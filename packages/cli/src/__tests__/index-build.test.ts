/**
 * Unit tests for the Ctrl+I project-index trigger helpers.
 *
 * These are pure-string modules by design (see the module header in
 * `commands/index-build.ts`): the App-level behaviour lives in
 * `index-key.test.tsx`, and what remains testable HERE is that the words the
 * dialog and the invocation carry stay honest - the dialog names what will be
 * written, and the args tell the model the turn came from a confirmed
 * keypress, in both the first-build and the rebuild shape.
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  INDEX_SKILL_NAME,
  buildIndexConfirmSummary,
  hasProjectIndex,
  indexBuildInvocationArgs,
} from '../commands/index-build.js';

describe('INDEX_SKILL_NAME', () => {
  it('names the bundled skill the slash command dispatches to', () => {
    expect(INDEX_SKILL_NAME).toBe('project-indexer');
  });
});

describe('buildIndexConfirmSummary', () => {
  it('first build: names the skill, every write target, and asks a question', () => {
    const text = buildIndexConfirmSummary({ cwd: 'M:\\work\\demo', hasExistingIndex: false });
    expect(text).toContain('Build the project index');
    expect(text).toContain('"project-indexer"');
    expect(text).toContain('.claude-index/index.md');
    expect(text).toContain('CLAUDE.md');
    // The Ctrl+I gate must disclose the configuration questions, not imply
    // the run is silent - a silent run is how "what did I agree to?" starts.
    expect(text).toContain('configuration questions');
    expect(text).toContain('M:\\work\\demo');
    expect(text).not.toContain('Rebuild');
  });

  it('rebuild: says Rebuild and names the reused preferences', () => {
    const text = buildIndexConfirmSummary({ cwd: '/work/demo', hasExistingIndex: true });
    expect(text).toContain('Rebuild the project index');
    expect(text).toContain('config.md preferences are reused');
    expect(text).not.toContain('configuration questions');
  });

  it('is pure ASCII - commands/ is inside the glyphs scan scope', () => {
    for (const existing of [true, false]) {
      const text = buildIndexConfirmSummary({ cwd: '/work', hasExistingIndex: existing });
      expect(text.match(/[^\x00-\x7f]/g)).toBeNull();
    }
  });
});

describe('indexBuildInvocationArgs', () => {
  it('first build asks the configuration questions first', () => {
    const text = indexBuildInvocationArgs(false);
    expect(text).toContain('Ctrl+I');
    expect(text).toContain('confirmed');
    expect(text).toContain('configuration questions first');
  });

  it('rebuild reuses the existing config', () => {
    const text = indexBuildInvocationArgs(true);
    expect(text).toContain('Ctrl+I');
    expect(text).toContain('reusing the existing .claude-index/config.md preferences');
  });
});

describe('hasProjectIndex', () => {
  const root = mkdtempSync(join(tmpdir(), 'aragon-index-build-'));
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('is false for a workspace without .claude-index', () => {
    expect(hasProjectIndex(root)).toBe(false);
  });

  it('is true once .claude-index/index.md exists', () => {
    mkdirSync(join(root, '.claude-index'), { recursive: true });
    writeFileSync(join(root, '.claude-index', 'index.md'), '# Project Index\n', 'utf8');
    expect(hasProjectIndex(root)).toBe(true);
  });

  it('never throws for an unprobeable path', () => {
    expect(hasProjectIndex(join(root, 'no', 'such', 'dir'))).toBe(false);
  });
});
