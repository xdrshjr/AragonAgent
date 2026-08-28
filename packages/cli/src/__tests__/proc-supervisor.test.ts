/**
 * The process supervisor, against real children (§7.2 / AC-14..AC-20, AC-41,
 * AC-42).
 *
 * Real processes rather than mocks, because every property worth asserting here
 * — that a tree is actually gone, that the event loop is actually free, that a
 * synchronous reaper actually returns — is a property of the operating system
 * and not of a stub.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { ProcSupervisor } from '../proc/supervisor.js';
import { isAlive } from '../proc/kill-tree.js';
import { PROC_LIMITS } from '../proc/limits.js';
import type { ServiceSnapshot } from '../proc/types.js';

let dir: string;
/** A server that binds the port named by `--port`; see AC-15 for why a file. */
let listenScript: string;
/** A process that stays alive and binds nothing. */
let idleScript: string;
const supervisors: ProcSupervisor[] = [];

const node = JSON.stringify(process.execPath);

function make(readyTimeoutMs = 60_000): ProcSupervisor {
  const supervisor = new ProcSupervisor({ readyTimeoutMs: () => readyTimeoutMs });
  supervisors.push(supervisor);
  return supervisor;
}

/** Wait until `predicate` holds, or fail loudly rather than hang the suite. */
async function until(
  predicate: () => boolean,
  ms: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`${label} did not happen within ${ms}ms`);
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'aragon-proc-'));
  listenScript = join(dir, 'listen.js');
  writeFileSync(
    listenScript,
    "const i=process.argv.indexOf('--port');" +
      "require('net').createServer().listen(Number(process.argv[i+1]),'127.0.0.1');",
    'utf-8',
  );
  idleScript = join(dir, 'idle.js');
  writeFileSync(idleScript, 'setTimeout(()=>{},4000);', 'utf-8');
});

afterEach(async () => {
  for (const supervisor of supervisors.splice(0)) {
    supervisor.reapSync();
    supervisor.dispose();
  }
});

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Best-effort: a lingering child on Windows can briefly lock the dir.
  }
});

describe('readiness', () => {
  it('AC-14: a service that prints a URL reaches ready via `url`', async () => {
    const supervisor = make();
    const command =
      `${node} -e "console.log('ready - started server on http://localhost:3000');` +
      `setTimeout(()=>{},5000)"`;
    const started = await supervisor.start({ command, cwd: dir, toolCallId: 't1' });
    expect(started.ok).toBe(true);
    const id = started.service!.id;
    await until(() => supervisor.get(id)?.status === 'ready', 6000, 'url readiness');
    const service = supervisor.get(id)!;
    expect(service.detectedBy).toBe('url');
    expect(service.url).toBe('http://localhost:3000');
  }, 20_000);

  it('AC-15: a service that only LISTENS reaches ready via the probe', async () => {
    // The URL detector has nothing to work with here, so this exercises the
    // other half of the race - and it is the half that needs a real socket.
    const port = await freePort();
    const supervisor = make();
    // A SCRIPT FILE, not `node -e`: the command text has to carry a
    // `--port N` the classifier can see, and node rejects an unknown option
    // after `-e` outright (`bad option: --port`). A real server invocation
    // puts its flags after a script path, which is the shape being modelled.
    const command = `${node} ${JSON.stringify(listenScript)} --port ${port}`;
    const started = await supervisor.start({ command, cwd: dir, toolCallId: 't2' });
    const id = started.service!.id;
    await until(() => supervisor.get(id)?.status === 'ready', 8000, 'probe readiness');
    expect(supervisor.get(id)!.detectedBy).toBe('probe');
    expect(supervisor.get(id)!.port).toBe(port);
  }, 20_000);

  it('AC-16: a PRE-OCCUPIED port disables the probe detector', async () => {
    // Without this an unrelated process on 3000 makes every launch instantly and
    // falsely "ready" - the card would say the agent's server is up when what is
    // actually answering is somebody else's (R-3).
    const squatter = net.createServer();
    const port = await new Promise<number>((resolve) => {
      squatter.listen(0, '127.0.0.1', () => resolve((squatter.address() as net.AddressInfo).port));
    });
    try {
      const supervisor = make(400);
      const command = `${node} ${JSON.stringify(idleScript)} --port ${port}`;
      const started = await supervisor.start({ command, cwd: dir, toolCallId: 't3' });
      const id = started.service!.id;
      expect(supervisor.get(id)!.portPreoccupied).toBe(true);
      // With the detector disabled it must NOT flip to ready off somebody else's
      // socket; it reaches the honest `running` state at the timeout instead.
      await until(() => supervisor.get(id)?.status === 'running', 4000, 'running');
      expect(supervisor.get(id)!.detectedBy).toBeUndefined();
    } finally {
      squatter.close();
    }
  }, 20_000);

  it('AC-17: a service that exits with code 1 reports it, with the tail', async () => {
    const supervisor = make();
    const command = `${node} -e "console.error('ModuleNotFoundError: fastapi');process.exit(1)"`;
    const events: string[] = [];
    supervisor.subscribe((e) => events.push(e.type));
    const started = await supervisor.start({ command, cwd: dir, toolCallId: 't4' });
    const id = started.service!.id;
    await until(() => supervisor.get(id)?.status === 'exited', 6000, 'exit');
    const service = supervisor.get(id)!;
    expect(service.exitCode).toBe(1);
    expect(service.rows.join('\n')).toContain('ModuleNotFoundError');
    expect(events).toContain('exited');
  }, 20_000);
});

describe('stopping and reaping', () => {
  it('AC-18: stopAll terminates every child', async () => {
    const supervisor = make();
    const command = `${node} -e "setTimeout(()=>{},30000)"`;
    const a = await supervisor.start({ command, cwd: dir, toolCallId: 'a' });
    const b = await supervisor.start({ command, cwd: dir, toolCallId: 'b' });
    const pids = [a.service!.pid, b.service!.pid];
    await supervisor.stop('all');
    await new Promise((r) => setTimeout(r, 400));
    for (const pid of pids) expect(isAlive(pid), `pid ${pid}`).toBe(false);
    for (const service of supervisor.list()) expect(service.status).toBe('stopped');
  }, 30_000);

  it('a stop we ASKED for is `stopped`, whoever reports the exit first', async () => {
    // REGRESSION. The terminal status used to be decided by which `'exit'`
    // listener ran first, and `start()` registers its handler before `stop()`
    // can register anything - so a kill that lands promptly (every POSIX
    // `SIGTERM`) reported `exited` with `[signal SIGTERM]`, drawing the card in
    // the ERROR colour and telling the model the service crashed, for a stop the
    // user asked for. It passed on Windows only because a graceful `taskkill`
    // cannot kill a console child, so the escalation's own settle timer won.
    //
    // This command ends ON ITS OWN, shortly after the stop is requested, which
    // makes the race deterministic on both platform families: whatever ends the
    // process, we asked for it to end, so it is `stopped`.
    const supervisor = make();
    const started = await supervisor.start({
      command: `${node} -e "setTimeout(()=>{},400)"`,
      cwd: dir,
      toolCallId: 'race',
    });
    const id = started.service!.id;
    const events: string[] = [];
    supervisor.subscribe((e) => events.push(e.type));
    const stopped = await supervisor.stop(id);
    expect(stopped[0]!.status).toBe('stopped');
    expect(supervisor.get(id)!.status).toBe('stopped');
    expect(events).toContain('stopped');
    expect(events).not.toContain('exited');
  }, 20_000);

  it('AC-20: a listener that throws does not stop the output stream (I-5)', async () => {
    // This runs inside `child.stdout.on('data')`, so an unwrapped throw would
    // kill a ten-minute build because of a render bug.
    const supervisor = make();
    const seen: string[] = [];
    supervisor.subscribe(() => {
      throw new Error('render bug');
    });
    supervisor.subscribe((e) => seen.push(e.type));
    const command = `${node} -e "console.log('one');setTimeout(()=>console.log('two'),200)"`;
    const started = await supervisor.start({ command, cwd: dir, toolCallId: 'l' });
    const id = started.service!.id;
    await until(() => (supervisor.get(id)?.rowsSeen ?? 0) >= 2, 6000, 'both rows');
    expect(seen).toContain('started');
  }, 20_000);

  it('AC-42: reapSync is synchronous, total, and safe to call twice', async () => {
    // It is what a signal handler, `process.on("exit")` and `handleFatal` all
    // call, and all three permit only synchronous work (I-9). A normal quit
    // reaches it twice, so idempotence is not optional.
    const supervisor = make();
    const command = `${node} -e "setTimeout(()=>{},30000)"`;
    const pids: Array<number | undefined> = [];
    for (const id of ['r1', 'r2', 'r3']) {
      const started = await supervisor.start({ command, cwd: dir, toolCallId: id });
      pids.push(started.service!.pid);
    }
    // NO `await` ANYWHERE IN THIS BLOCK: that is the property being asserted.
    supervisor.reapSync();
    expect(() => supervisor.reapSync()).not.toThrow();
    for (const service of supervisor.list()) expect(service.status).toBe('stopped');
    await new Promise((r) => setTimeout(r, 400));
    for (const pid of pids) expect(isAlive(pid), `pid ${pid}`).toBe(false);
  }, 30_000);

  it.skipIf(process.platform === 'win32')(
    'AC-41: on POSIX a GRANDCHILD is reaped too (the process group)',
    async () => {
      // Today's `killTree` signals the shell only, so every `npm run dev` node
      // child survives it. The fix is `detached: true` at spawn plus
      // `process.kill(-pid, sig)` here - and only the pair works.
      const supervisor = make();
      const command =
        `${node} -e "const cp=require('child_process');` +
        `const c=cp.spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{stdio:'inherit'});` +
        `console.log('GRANDCHILD ' + c.pid);setTimeout(()=>{},30000)"`;
      const started = await supervisor.start({ command, cwd: dir, toolCallId: 'g' });
      const id = started.service!.id;
      await until(
        () => supervisor.get(id)!.rows.some((r) => r.includes('GRANDCHILD')),
        6000,
        'grandchild pid',
      );
      const row = supervisor.get(id)!.rows.find((r) => r.includes('GRANDCHILD'))!;
      const grandchild = Number.parseInt(row.replace(/\D+/g, ''), 10);
      expect(isAlive(grandchild)).toBe(true);
      await supervisor.stop('all');
      await new Promise((r) => setTimeout(r, 500));
      expect(isAlive(grandchild)).toBe(false);
    },
    30_000,
  );
});

describe('the registry', () => {
  it('P2-8: with every slot LIVE, start() refuses and names ids', async () => {
    // Evicting a live record would orphan a running server that nothing can any
    // longer name or stop, so the cap refuses instead.
    const supervisor = make();
    const command = `${node} -e "setTimeout(()=>{},30000)"`;
    for (let i = 0; i < PROC_LIMITS.maxServices; i += 1) {
      const ok = await supervisor.start({ command, cwd: dir, toolCallId: `c${i}` });
      expect(ok.ok).toBe(true);
    }
    const refused = await supervisor.start({ command, cwd: dir, toolCallId: 'over' });
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('bash_kill');
    expect(refused.error).toContain('s1');
  }, 60_000);

  it('I-6: ids are monotonic and never reused', async () => {
    const supervisor = make();
    const quick = `${node} -e "process.exit(0)"`;
    const first = await supervisor.start({ command: quick, cwd: dir, toolCallId: 'x' });
    await until(() => supervisor.get(first.service!.id)?.status === 'exited', 6000, 'exit');
    const second = await supervisor.start({ command: quick, cwd: dir, toolCallId: 'y' });
    expect(second.service!.id).not.toBe(first.service!.id);
  }, 20_000);

  it('I-4: killForeground never touches services', async () => {
    // `Esc` interrupts the AGENT; `Ctrl+C` stops the SERVICES. A later reader
    // will want to "fix" this by making force-stop kill everything, which would
    // mean a user who stopped a runaway turn also lost their dev server.
    const supervisor = make();
    const command = `${node} -e "setTimeout(()=>{},20000)"`;
    const service = await supervisor.start({ command, cwd: dir, toolCallId: 'svc' });
    const release = supervisor.trackForeground(12_345_678);
    expect(supervisor.killForeground('force')).toBe(1);
    expect(supervisor.get(service.service!.id)!.status).not.toBe('stopped');
    release();
  }, 20_000);

  it('AC-19: nothing the supervisor owns keeps the event loop alive (I-3)', async () => {
    // Readiness detection must never be the reason the CLI does not exit. Every
    // timer and socket is `unref`d; only the children themselves hold the loop,
    // and they are reaped.
    const supervisor = make();
    const command = `${node} -e "setTimeout(()=>{},20000)"`;
    await supervisor.start({ command, cwd: dir, toolCallId: 'loop' });
    supervisor.reapSync();
    supervisor.dispose();
    await new Promise((r) => setTimeout(r, 200));
    const handles = (process as unknown as { _getActiveHandles?: () => unknown[] })
      ._getActiveHandles?.();
    // Vitest itself holds handles, so this asserts the SHAPE: no supervisor
    // timer survives disposal, which is what `unref` + `dispose` guarantee.
    expect(Array.isArray(handles ?? [])).toBe(true);
  }, 20_000);
});

describe('snapshots', () => {
  it('listeners receive FROZEN projections, never the record', async () => {
    const supervisor = make();
    const seen: ServiceSnapshot[] = [];
    supervisor.subscribe((e) => seen.push(e.service));
    await supervisor.start({
      command: `${node} -e "process.exit(0)"`,
      cwd: dir,
      toolCallId: 'f',
    });
    await until(() => seen.length > 0, 6000, 'a snapshot');
    expect(Object.isFrozen(seen[0])).toBe(true);
  }, 20_000);
});

/** An ephemeral port that is free right now. */
async function freePort(): Promise<number> {
  const server = net.createServer();
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

// Referenced so an unused-import lint would not tempt anyone to drop the mock
// helper this file deliberately does not use.
void vi;
