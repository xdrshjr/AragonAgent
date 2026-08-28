/**
 * W1 — `bash` always settles (§7.2 / AC-9..AC-13).
 *
 * THE REGRESSION SUITE FOR THE REPORTED SCREENSHOT. Every case asserts the
 * promise settles WITHIN A BOUNDED TIME, which is the property that was missing:
 * the old tool had three separate ways to leave its promise pending forever, and
 * none of them was visible to any existing test, because tests spawn commands
 * that close their own pipes.
 *
 * Real child processes, through `process.execPath`, so the cases exercise the
 * actual stdio semantics rather than a mock of them.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import type { ToolExecutionContext, ToolResult } from '@aragon-agent/core';
import { makeBash } from '../tools/bash-tool.js';
import { PROC_LIMITS } from '../proc/limits.js';

let dir: string;

function text(result: ToolResult): string {
  return result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
}

/** Reject rather than hang, so a regression FAILS instead of timing the suite out. */
async function settlesWithin<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const node = JSON.stringify(process.execPath);

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'aragon-bash-settle-'));
});

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Best-effort: a lingering child on Windows can briefly lock the dir.
  }
});

const bash = () => makeBash({ getCwd: () => dir });
const ctx: ToolExecutionContext = {};

describe('bash always settles (I-1)', () => {
  it('AC-9: an ordinary command returns the pre-change body, byte for byte', async () => {
    const result = await settlesWithin(
      bash().execute('1', { command: `${node} -e "console.log('hi')"` }, ctx),
      10_000,
      'ordinary command',
    );
    const body = text(result);
    expect(body).toContain('$ ');
    expect(body).toContain('hi');
    expect(body).toContain('[exit code 0]');
    expect(result.isError).toBeFalsy();
    // The `[note]` line belongs to the drain path ONLY. Emitting it here would
    // teach the model to background every command it runs.
    expect(body).not.toContain('[note]');
  });

  it('AC-10: a child holding the stdout pipe open after exit still settles', async () => {
    // THIS IS THE REPRODUCTION OF THE REPORTED SCREENSHOT, and it FAILS on the
    // pre-change build: `'close'` fires only when every stdio stream is closed,
    // and a detached grandchild that inherited the pipe keeps it open after the
    // parent is long gone. The shell exited; the promise did not.
    // THE GRANDCHILD MUST BE DETACHED AND `unref`d, and that is not incidental
    // to the repro. Without it the PARENT node process keeps its event loop
    // alive for the child it spawned, so the parent does not exit early either
    // and `exit` / `close` fire together - which is what the pre-change build
    // relied on being true. Detaching is exactly what `Start-Process`, `&` and
    // `nohup` do, and it is what the prompt block tells the model never to do.
    const script =
      `${node} -e "const cp=require('child_process');` +
      `const c=cp.spawn(process.execPath,['-e','setTimeout(()=>{},3000)'],` +
      `{stdio:'inherit',detached:true});c.unref();` +
      `console.log('parent done')"`;
    const started = Date.now();
    const result = await settlesWithin(
      bash().execute('2', { command: script }, ctx),
      PROC_LIMITS.drainMs + 8000,
      'exit-without-close',
    );
    const body = text(result);
    expect(body).toContain('parent done');
    expect(body).toContain(
      '[note] the command exited but a background child is still holding its output stream.',
    );
    // The diagnosis is worth nothing if it arrives three minutes late.
    expect(Date.now() - started).toBeLessThan(8000);
  }, 20_000);

  it('AC-11: a command that reads stdin settles instead of blocking', async () => {
    // `spawn` defaults every descriptor to a pipe, so the old build handed the
    // command a stdin nobody would ever write or end - and a command that
    // prompts (`npm init`, `sudo`, a git credential prompt) blocked forever on
    // a read that could not be satisfied.
    const script = `${node} -e "process.stdin.on('data',()=>{});process.stdin.on('end',()=>process.exit(0))"`;
    const result = await settlesWithin(
      bash().execute('3', { command: script }, ctx),
      10_000,
      'stdin reader',
    );
    expect(text(result)).toContain('[exit code 0]');
  }, 20_000);

  it('AC-12: abort settles within the grace AND keeps the captured output', async () => {
    // A BARE `Command aborted.` FAILS THIS (P1-5). Today an abort kills the
    // tree, `'close'` fires, and the model receives everything the command
    // printed plus `[signal SIGTERM]`. The executor's own 180 s ceiling aborts
    // through this same signal - so dropping the output would hand the model
    // three words and no evidence at exactly the moment it needs to learn the
    // command does not terminate.
    const controller = new AbortController();
    const script = `${node} -e "console.log('before abort');setTimeout(()=>{},10000)"`;
    const promise = bash().execute('4', { command: script }, { signal: controller.signal });
    await new Promise((r) => setTimeout(r, 600));
    controller.abort();
    const result = await settlesWithin(
      promise,
      PROC_LIMITS.killGraceMs + 5000,
      'abort',
    );
    const body = text(result);
    expect(result.isError).toBe(true);
    expect(body).toContain('before abort');
    expect(body).toContain('[aborted]');
  }, 20_000);

  it('AC-13a: the `timeout` param still produces the existing message', async () => {
    const result = await settlesWithin(
      bash().execute('5', { command: `${node} -e "setTimeout(()=>{},4000)"`, timeout: 300 }, ctx),
      PROC_LIMITS.killGraceMs + 8000,
      'timeout param',
    );
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('timed out');
  }, 20_000);

  it('AC-13b: a CEILING abort names the ceiling and suggests background', async () => {
    // The whole point of W3 is that the model can tell "the user stopped me"
    // from "this command does not terminate". `ctx.abortCause` is what carries
    // that, and a footer that ignored it would give a user's Esc a workaround
    // they never asked for.
    const controller = new AbortController();
    const script = `${node} -e "console.log('serving');setTimeout(()=>{},10000)"`;
    const context: ToolExecutionContext = { signal: controller.signal };
    const promise = bash().execute('6', { command: script }, context);
    await new Promise((r) => setTimeout(r, 500));
    context.abortCause = 'timeout';
    controller.abort();
    const result = await settlesWithin(promise, PROC_LIMITS.killGraceMs + 5000, 'ceiling abort');
    const body = text(result);
    expect(body).toContain('serving');
    expect(body).toContain('the command was still running');
    expect(body).toContain('background: true');
  }, 20_000);
});

describe('I-2: with no supervisor the tool is the pre-feature one', () => {
  it('has no `background` property and no background sentences', () => {
    const tool = makeBash({ getCwd: () => dir });
    expect(tool.parameters.properties?.background).toBeUndefined();
    expect(tool.description).not.toContain('background: true');
  });

  it('gains both the moment a supervisor is supplied', () => {
    const tool = makeBash({ getCwd: () => dir }, {
      supervisor: {
        start: async () => ({ ok: true }),
        get: () => undefined,
        list: () => [],
        stop: async () => [],
        read: () => undefined,
        subscribe: () => () => {},
        trackForeground: () => () => {},
        killForeground: () => 0,
        liveCount: () => 0,
        reapSync: () => {},
        dispose: () => {},
      },
    });
    expect(tool.parameters.properties?.background).toBeDefined();
    expect(tool.description).toContain('background: true');
    expect(tool.description).toContain('Start-Process');
  });
});
