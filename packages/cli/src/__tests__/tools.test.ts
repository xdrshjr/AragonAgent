import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentTool, ToolExecutionContext, ToolResult } from '@argon-agent/core';
import { createBuiltinTools } from '../tools/index.js';

let dir: string;
let tools: Record<string, AgentTool>;
const ctx: ToolExecutionContext = {};

function text(result: ToolResult): string {
  return result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'argon-tools-'));
  const list = createBuiltinTools({ getCwd: () => dir });
  tools = Object.fromEntries(list.map((t) => [t.name, t]));
});

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Best-effort cleanup — a lingering child on Windows can briefly lock the dir.
  }
});

describe('write_file + read_file', () => {
  it('round-trips content', async () => {
    const w = await tools.write_file!.execute('1', { path: 'a.txt', content: 'hello\nworld' }, ctx);
    expect(w.isError).toBeFalsy();
    const r = await tools.read_file!.execute('2', { path: 'a.txt' }, ctx);
    expect(text(r)).toContain('hello');
    expect(text(r)).toContain('world');
  });

  it('read_file errors on a missing file', async () => {
    const r = await tools.read_file!.execute('3', { path: 'nope.txt' }, ctx);
    expect(r.isError).toBe(true);
  });
});

describe('edit_file', () => {
  it('replaces a unique string and returns a diff preview', async () => {
    await tools.write_file!.execute('4', { path: 'edit.txt', content: 'alpha beta gamma' }, ctx);
    const e = await tools.edit_file!.execute(
      '5',
      { path: 'edit.txt', old_string: 'beta', new_string: 'BETA' },
      ctx,
    );
    expect(e.isError).toBeFalsy();
    const preview = text(e);
    expect(preview).toContain('- alpha beta gamma');
    expect(preview).toContain('+ alpha BETA gamma');
  });

  it('errors when old_string is not found', async () => {
    const e = await tools.edit_file!.execute(
      '6',
      { path: 'edit.txt', old_string: 'missing', new_string: 'x' },
      ctx,
    );
    expect(e.isError).toBe(true);
  });

  it('replace_all replaces every occurrence', async () => {
    await tools.write_file!.execute('7', { path: 'multi.txt', content: 'a a a' }, ctx);
    const e = await tools.edit_file!.execute(
      '8',
      { path: 'multi.txt', old_string: 'a', new_string: 'b', replace_all: true },
      ctx,
    );
    expect(e.isError).toBeFalsy();
    const r = await tools.read_file!.execute('9', { path: 'multi.txt' }, ctx);
    expect(text(r)).toContain('b b b');
  });

  it('inserts $-patterns in new_string literally (no String.replace substitution)', async () => {
    await tools.write_file!.execute('20', { path: 'dollar.txt', content: 'PLACEHOLDER end' }, ctx);
    const e = await tools.edit_file!.execute(
      '21',
      { path: 'dollar.txt', old_string: 'PLACEHOLDER', new_string: 'cost is $$5 and $& $1' },
      ctx,
    );
    expect(e.isError).toBeFalsy();
    const r = await tools.read_file!.execute('22', { path: 'dollar.txt' }, ctx);
    expect(text(r)).toContain('cost is $$5 and $& $1');
  });
});

describe('list_dir + glob + grep', () => {
  it('lists directory entries', async () => {
    const r = await tools.list_dir!.execute('10', {}, ctx);
    expect(text(r)).toContain('a.txt');
  });

  it('glob finds seeded files', async () => {
    const r = await tools.glob!.execute('11', { pattern: '*.txt' }, ctx);
    expect(text(r)).toContain('a.txt');
  });

  it('grep finds a seeded pattern', async () => {
    writeFileSync(join(dir, 'search.txt'), 'find the needle here\nnot this line', 'utf-8');
    const r = await tools.grep!.execute('12', { pattern: 'needle' }, ctx);
    expect(text(r)).toContain('needle');
  });

  it('grep searches a single-file path (not just a directory)', async () => {
    writeFileSync(join(dir, 'single.txt'), 'unique_token_zzz on this line\nother', 'utf-8');
    const r = await tools.grep!.execute('23', { pattern: 'unique_token_zzz', path: 'single.txt' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain('unique_token_zzz');
  });
});

describe('bash', () => {
  it('captures stdout and a zero exit code', async () => {
    const r = await tools.bash!.execute('13', { command: 'node -e "console.log(\'ping\')"' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain('ping');
    expect(text(r)).toContain('exit code 0');
  });

  it('reports a non-zero exit code as an error', async () => {
    const r = await tools.bash!.execute('14', { command: 'node -e "process.exit(3)"' }, ctx);
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('exit code 3');
  });

  it('honors the timeout param', async () => {
    const r = await tools.bash!.execute(
      '15',
      { command: 'node -e "setTimeout(()=>{},4000)"', timeout: 500 },
      ctx,
    );
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('timed out');
  }, 8000);
});
