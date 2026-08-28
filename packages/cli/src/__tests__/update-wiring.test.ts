/**
 * The wiring that has no other home: the import graph, and `/update`
 * (cli-auto-update AC-1 / AC-29 / §3.1).
 *
 * AC-1 IS A CLAIM ABOUT MODULE GRAPHS, AND A NAIVE VERSION OF IT IS VACUOUS. The
 * design's own note says why: `runOneShot` and `runInteractive` live in the SAME
 * `cli.tsx` module, so a test that walked the graph from the headless entry
 * point would pass while the claim was false. What actually decides it is
 * whether `cli.tsx` carries a STATIC import specifier under `update/` — because
 * the package is compiled by plain `tsc` with no bundler (C-16), so every
 * specifier in the source survives into `dist/` and is evaluated by every entry
 * point in the file.
 *
 * So this file asserts on the SOURCE (always available, and exactly equivalent
 * for this property since tsc preserves specifiers) and additionally on `dist/`
 * when a build is present.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CommandRegistry, runSlashInput, type CommandContext } from '../commands/registry.js';
import { registerBuiltinCommands } from '../commands/builtins.js';
import type { UpdateCommandPort, UpdateSnapshot } from '../update/types.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(SRC, '..', 'dist');

/** Every `import ... from '<spec>'` in a file, ignoring `import type` lines. */
function runtimeSpecifiers(source: string): string[] {
  const out: string[] = [];
  const re = /(^|\n)\s*import\s+([^;]*?)\s*from\s*'([^']+)'/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const clause = match[2] ?? '';
    // `import type { X } from '...'` is erased by tsc, so it is not an edge.
    if (/^type\s/.test(clause.trim())) continue;
    out.push(match[3] as string);
  }
  return out;
}

describe('AC-1: the updater is not in the headless graph', () => {
  it('cli.tsx has NO static runtime import under update/', () => {
    // The whole of D-25. A static import here would put `service.ts`,
    // `registry.ts`, `installer.ts`, `install-lock.ts`, `state.ts`,
    // `install-source.ts` and `semver.ts` — every module that opens a socket,
    // spawns a process or touches the filesystem — into `dist/cli.js`'s graph,
    // and `aragon -p "hi"` would evaluate all of them.
    const source = readFileSync(join(SRC, 'cli.tsx'), 'utf-8');
    const offenders = runtimeSpecifiers(source).filter((spec) => spec.includes('update/'));
    expect(offenders).toEqual([]);
  });

  it('cli.tsx reaches the service through a DYNAMIC import instead', () => {
    // The complement of the assertion above: without this, "no static import"
    // could be satisfied by a feature that was never wired up at all.
    const source = readFileSync(join(SRC, 'cli.tsx'), 'utf-8');
    expect(source).toContain("import('./update/service.js')");
  });

  it('UpdateLine.tsx imports update/ types with `import type` only', () => {
    // So tsc erases the specifier and `dist/ui/UpdateLine.js` carries no
    // runtime edge into the tree (§3.1 rule 1).
    const source = readFileSync(join(SRC, 'ui', 'UpdateLine.tsx'), 'utf-8');
    const offenders = runtimeSpecifiers(source).filter((spec) => spec.includes('update/'));
    expect(offenders).toEqual([]);
  });

  it('commands/registry.ts does the same', () => {
    const source = readFileSync(join(SRC, 'commands', 'registry.ts'), 'utf-8');
    const offenders = runtimeSpecifiers(source).filter((spec) => spec.includes('update/'));
    expect(offenders).toEqual([]);
  });

  it('the built dist/ agrees, when it was built from THIS source', () => {
    // The claim is ultimately about the shipped output; the source assertions
    // above are what make it non-vacuous in a working tree with no build.
    //
    // GATED ON `dist/update/service.js`, not merely on `dist/cli.js`. A working
    // tree routinely carries a `dist/` from before this feature, and asserting
    // against that would fail for a reason that has nothing to do with the code
    // under test — the classic way a build-output check gets deleted rather
    // than fixed.
    const built = join(DIST, 'cli.js');
    if (!existsSync(built) || !existsSync(join(DIST, 'update', 'service.js'))) return;
    const source = readFileSync(built, 'utf-8');
    expect(runtimeSpecifiers(source).filter((s) => s.includes('update/'))).toEqual([]);
    expect(source).toContain("import('./update/service.js')");

    const line = join(DIST, 'ui', 'UpdateLine.js');
    if (existsSync(line)) {
      const lineSource = readFileSync(line, 'utf-8');
      expect(runtimeSpecifiers(lineSource).filter((s) => s.includes('update/'))).toEqual([]);
    }
  });

  it('nothing under update/ imports React, Ink, ui/ or agent/ (§3.1)', () => {
    // The dependency direction, made real rather than documented. `update/` is a
    // HOST concern with no dependency on `@aragon-agent/core` either.
    const modules = [
      'types.ts',
      'limits.ts',
      'semver.ts',
      'install-source.ts',
      'registry.ts',
      'state.ts',
      'install-lock.ts',
      'installer.ts',
      'service.ts',
      // The hardening round's two, listed here in the same commit as the modules
      // themselves: this list is exhaustive by hand, so a new file that is not
      // added to it is a file nothing checks.
      'npm-view.ts',
      'classify-failure.ts',
    ];
    for (const name of modules) {
      const source = readFileSync(join(SRC, 'update', name), 'utf-8');
      for (const spec of runtimeSpecifiers(source)) {
        expect(spec, `${name} -> ${spec}`).not.toMatch(/^(react|ink)/);
        expect(spec, `${name} -> ${spec}`).not.toContain('../ui/');
        expect(spec, `${name} -> ${spec}`).not.toContain('../agent/');
        expect(spec, `${name} -> ${spec}`).not.toContain('@aragon-agent/core');
      }
    }
  });

  it('AC-4 / AC-5: the construction gate names all FOUR of its conditions', () => {
    // ASSERTED ON THE SOURCE, and that is forced rather than lazy: `cli.tsx`
    // ends in `main().catch(...)`, so importing it to test the gate would RUN
    // the CLI inside vitest. Spawning the built binary is the only alternative
    // and this suite deliberately never does (§8.1). The claim is small enough
    // to survive the medium: every one of the four conjuncts below is load-
    // bearing, and deleting any one is silent - `CI` gone means a pipeline
    // mutates its own toolchain mid-run (D-11), `mode !== 'off'` gone means the
    // documented kill switch stops killing (AC-4), and either `isTTY` gone means
    // a piped `aragon` opens a socket it promised not to (AC-5).
    const source = readFileSync(join(SRC, 'cli.tsx'), 'utf-8');
    const gate = /const updateEligible\s*=([\s\S]*?);/.exec(source)?.[1] ?? '';
    expect(gate, 'the gate itself').not.toBe('');
    expect(gate).toContain('process.stdout.isTTY');
    expect(gate).toContain('process.stdin.isTTY');
    expect(gate).toContain('process.env.CI');
    expect(gate).toContain("mode !== 'off'");
  });

  it('AC-4 / AC-5: and BOTH consumers are behind it', () => {
    // The gate is worth nothing if one of its two users forgets to ask. `App`
    // must receive NO bridge (so `BottomStatusRow` gets `update={null}` for the
    // whole session), and the dynamic import must not fire at all - the second
    // is what makes "executes zero lines of update code" true rather than
    // "renders nothing".
    const flat = readFileSync(join(SRC, 'cli.tsx'), 'utf-8').replace(/\s+/g, ' ');
    expect(flat).toContain('updateBridge={updateEligible ? updateBridge : undefined}');
    // Ordering rather than brace-matching: AC-1 above already proves the ONLY
    // specifier into `update/` is this dynamic one, so "it comes after the gate
    // opens" is the whole of "it is behind the gate".
    const gateAt = flat.indexOf('if (updateEligible) {');
    expect(gateAt, 'the gate block').toBeGreaterThan(-1);
    expect(flat.indexOf("import('./update/service.js')")).toBeGreaterThan(gateAt);
  });

  it('types.ts and limits.ts import NOTHING but each other', () => {
    // They are the two modules `ui/App.tsx` pulls in as values, so `aragon -p`
    // does evaluate them (IF-2). That is only acceptable while they stay pure:
    // no I/O, no timers, no sockets, no transitive dependencies.
    const limits = runtimeSpecifiers(readFileSync(join(SRC, 'update', 'limits.ts'), 'utf-8'));
    expect(limits).toEqual([]);
    const types = runtimeSpecifiers(readFileSync(join(SRC, 'update', 'types.ts'), 'utf-8'));
    expect(types).toEqual(['./limits.js']);
  });
});

// ---------------------------------------------------------------------------
// The launcher's module graph (cli-auto-update-hardening AC-51 / AC-53 / P2-7)
// ---------------------------------------------------------------------------

/** Every `await import('<spec>')` / `import('<spec>')` in a file. */
function dynamicSpecifiers(source: string): string[] {
  return [...source.matchAll(/\bimport\(\s*'([^']+)'\s*\)/g)].map((m) => m[1] as string);
}

/** `'./boot/guard.js'` from `src/launcher.ts` -> `boot/guard.ts`, or `null`. */
function resolveLocal(fromRel: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const dir = fromRel.includes('/') ? fromRel.slice(0, fromRel.lastIndexOf('/')) : '';
  const parts = (dir ? `${dir}/${spec}` : spec.replace(/^\.\//, '')).split('/');
  const stack: string[] = [];
  for (const part of parts) {
    if (part === '.' || part === '') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  const joined = stack.join('/').replace(/\.js$/, '');
  for (const ext of ['.ts', '.tsx']) {
    if (existsSync(join(SRC, `${joined}${ext}`))) return `${joined}${ext}`;
  }
  return null;
}

describe('AC-51 / AC-53: the launcher loads as little as possible', () => {
  it('AC-51: `launcher.ts` has exactly ONE static import, and it is node:process', () => {
    // P1-2 / R-22, and the reason is the case H1 exists for. A STATIC import of
    // the guard would put `boot/guard -> update/state -> config/app-paths ->
    // env-paths` in the bin entry's OWN module graph, and a resolution failure
    // anywhere in that chain throws during the launcher's evaluation - OUTSIDE
    // the try, before any line of it runs. "An undeclared dependency" is the
    // first way a release bricks itself, and in that case the shipped behaviour
    // would be a raw ERR_MODULE_NOT_FOUND from the bin entry with the guard
    // never running at all.
    //
    // ASSERTED ON THE SOURCE, and that is forced rather than lazy: this module
    // ends in an import of `cli.js`, so importing it in vitest would run the
    // CLI. Same medium and the same reason as AC-4 / AC-5 above.
    const source = readFileSync(join(SRC, 'launcher.ts'), 'utf-8');
    expect(runtimeSpecifiers(source)).toEqual(['node:process']);
  });

  it('AC-51: and reaches BOTH the guard and the CLI through dynamic import()', () => {
    // The complement: "no static import" could otherwise be satisfied by a
    // launcher that was never wired to anything.
    const source = readFileSync(join(SRC, 'launcher.ts'), 'utf-8');
    expect(dynamicSpecifiers(source)).toEqual(['./boot/guard.js', './cli.js']);
    // The guard call is inside a try whose catch swallows: a guard that throws
    // must degrade to "no guard", never to "no CLI".
    expect(source.replace(/\s+/g, ' ')).toContain('} catch {');
  });

  it('AC-53: the guard chain is a SUBSET of the allow-list, walked transitively', () => {
    // P2-7. v1's AC-1 filters `cli.tsx`'s DIRECT specifiers for the literal
    // `update/`, which a `./boot/guard.js` import passes textually while quietly
    // widening the graph AC-1 exists to bound - and `cli.tsx` now carries
    // exactly that import. So this walks instead of matching.
    //
    // THE WALK STARTS AT THE GUARD, NOT AT `launcher.ts` ITSELF, and that is a
    // correction to the criterion as written (see the spec's IF section).
    // `launcher.ts` has no static local import at all, so a literal "transitive
    // static graph reachable from launcher.ts" is the empty set and the
    // assertion would be VACUOUS - the exact failure mode this package's glyph
    // scanner has a self-test for. `./boot/guard.js` is what the launcher
    // actually loads before the CLI, and its graph is the one that has to stay
    // small; `./cli.js` is the application and is deliberately out of scope.
    const allowed = new Set([
      'boot/guard.ts',
      'boot/rollback.ts',
      'config/app-paths.ts',
      'update/state.ts',
    ]);
    const seen = new Set<string>();
    const bare = new Set<string>();
    const queue = ['boot/guard.ts'];
    while (queue.length > 0) {
      const rel = queue.pop() as string;
      if (seen.has(rel)) continue;
      seen.add(rel);
      for (const spec of runtimeSpecifiers(readFileSync(join(SRC, rel), 'utf-8'))) {
        const local = resolveLocal(rel, spec);
        if (local === null) {
          bare.add(spec);
          continue;
        }
        expect(allowed.has(local), `${rel} -> ${local}`).toBe(true);
        queue.push(local);
      }
    }
    // Non-vacuous: the walk really did reach the chain, rather than stopping at
    // the first file because a specifier failed to resolve.
    expect([...seen].sort()).toEqual([
      'boot/guard.ts',
      'boot/rollback.ts',
      'config/app-paths.ts',
      'update/state.ts',
    ]);
    // And the third-party half is pinned too. `env-paths` is the RESIDUAL GAP
    // §5.1.5 states rather than argues away: a release whose `node_modules` lost
    // it takes the guard down with it, contained by the launcher's dynamic
    // import. One more entry here is one more way H1 can fail in the case it
    // exists for, so it must be a deliberate edit and not a drift.
    expect([...bare].filter((s) => !s.startsWith('node:')).sort()).toEqual(['env-paths']);
  });

  it('AC-53: and the guard imports NO logger, which is what keeps the chain small', () => {
    // D-42 / P1-6. `getLogger()` resolves config on its way to a sink, so
    // importing it here would drag the config graph into the one module that has
    // to survive a broken build - the tempting one-line "fix" that would undo
    // P1-2. The guard is silent by construction; `rollback.ts` and the service
    // record the two facts worth having, and both already have a logger.
    const guard = readFileSync(join(SRC, 'boot', 'guard.ts'), 'utf-8');
    expect(runtimeSpecifiers(guard).some((s) => s.includes('logging/'))).toBe(false);
    // `rollback.ts` may log, but only through a DYNAMIC import - it runs inside
    // a build we have concrete evidence is broken.
    const rollback = readFileSync(join(SRC, 'boot', 'rollback.ts'), 'utf-8');
    expect(runtimeSpecifiers(rollback).some((s) => s.includes('logging/'))).toBe(false);
    expect(dynamicSpecifiers(rollback)).toContain('../logging/logger.js');
  });

  it('AC-50: BOTH entry points carry the shebang in a built dist/', () => {
    // GATED ON THE BUILD, on the same terms as the `dist/` assertion above: a
    // working tree routinely carries no `dist/` at all, and failing there would
    // be failing for a reason that has nothing to do with the code under test.
    //
    // `dist/cli.js` KEEPING ITS SHEBANG IS THE HALF THAT IS EASY TO DROP (R-17).
    // Only the `bin` MAPPING moved; `npm start` runs `node dist/cli.js` and user
    // scripts may invoke it directly, so a `prepend-shebang.mjs` that switched
    // targets instead of adding one would break them silently — the script
    // succeeds, the package installs, and only the people with a wrapper find
    // out.
    // THE `\n` IS PART OF THE ASSERTION, not incidental. A shebang terminated by
    // CRLF makes `\r` the last character of the interpreter path, so `env` on
    // Linux looks for a program called `node\r` and the bin fails with a message
    // naming a binary the user has never heard of. `prepend-shebang.mjs` writes
    // the byte explicitly for that reason.
    const launcher = join(DIST, 'launcher.js');
    if (!existsSync(launcher)) return;
    expect(readFileSync(launcher, 'utf-8').startsWith('#!/usr/bin/env node\n')).toBe(true);
    expect(readFileSync(join(DIST, 'cli.js'), 'utf-8').startsWith('#!/usr/bin/env node\n')).toBe(
      true,
    );
    // And the guard really shipped beside it, rather than the launcher pointing
    // at a module that is not in the tarball.
    expect(existsSync(join(DIST, 'boot', 'guard.js'))).toBe(true);
    expect(existsSync(join(DIST, 'boot', 'rollback.js'))).toBe(true);
  });

  it('cli.tsx still has no static import under update/, guard or no guard', () => {
    // The hardening round adds `./boot/guard.js` to this file as a VALUE import.
    // AC-1's own assertion passes textually; the walk above is what makes the
    // claim behind it true, and this line is here so the pair is read together.
    const source = readFileSync(join(SRC, 'cli.tsx'), 'utf-8');
    const specs = runtimeSpecifiers(source);
    expect(specs.filter((s) => s.includes('update/'))).toEqual([]);
    expect(specs).toContain('./boot/guard.js');
  });
});

describe('AC-22: `aragon update --check --json` reports without installing', () => {
  // Same medium and the same reason as the gate above: `cli.tsx` self-invokes
  // `main()`, so `runUpdateCommand` cannot be imported, and the three properties
  // AC-22 names are each a single expression that either exists or does not.
  const flat = readFileSync(join(SRC, 'cli.tsx'), 'utf-8').replace(/\s+/g, ' ');

  it('declares the three documented options on a real subcommand', () => {
    expect(flat).toContain(".command('update')");
    for (const option of ['--check', '--to <version>', '--json']) {
      expect(flat, option).toContain(`'${option}'`);
    }
  });

  it('`--check` is expressed AS `mode: notify`, so one path decides installing', () => {
    // Not a second flag threaded through the service: the mode already means
    // "report, never install", and two ways to say that is how they end up
    // disagreeing. This is the whole of "exits 0 WITHOUT installing".
    expect(flat).toContain("opts.check ? { ...config.update, mode: 'notify' } : config.update");
  });

  it('`--json` prints ONE snapshot object and nothing else', () => {
    expect(flat).toMatch(/opts\.json \? `\$\{JSON\.stringify\(snapshot\)\}/);
    // And the install path is reached only by `--to`, never by a bare check.
    expect(flat).toContain(
      'target ? await service.installNow(target) : await service.checkNow({ force: true })',
    );
  });
});

// ---------------------------------------------------------------------------
// /update (AC-29)
// ---------------------------------------------------------------------------

const registry = new CommandRegistry();
registerBuiltinCommands(registry);

function snapshot(over: Partial<UpdateSnapshot> = {}): UpdateSnapshot {
  return {
    phase: 'available',
    currentVersion: '0.5.9',
    latestVersion: '0.6.0',
    source: 'npm-global',
    nextCheckAt: null,
    consecutiveFailures: 0,
    ...over,
  };
}

interface Harness {
  ctx: (args: string) => CommandContext;
  notices: string[];
  toasts: string[];
  persisted: Record<string, unknown>[];
  skipped: string[];
  checks: { force?: boolean }[];
}

function harness(port?: UpdateCommandPort | undefined): Harness {
  const notices: string[] = [];
  const toasts: string[] = [];
  const persisted: Record<string, unknown>[] = [];
  return {
    notices,
    toasts,
    persisted,
    skipped: (port as { _skipped?: string[] })?._skipped ?? [],
    checks: (port as { _checks?: { force?: boolean }[] })?._checks ?? [],
    ctx: (args: string) =>
      ({
        args,
        notify: (_level: string, text: string) => notices.push(text),
        toast: (_level: string, text: string) => toasts.push(text),
        persistConfig: (patch: Record<string, unknown>) => persisted.push(patch),
        update: port,
      }) as unknown as CommandContext,
  };
}

function fakePort(over: Partial<UpdateSnapshot> = {}): UpdateCommandPort {
  const skipped: string[] = [];
  const checks: { force?: boolean }[] = [];
  const snap = snapshot(over);
  return Object.assign(
    {
      snapshot: () => snap,
      checkNow: async (opts: { force?: boolean } = {}) => {
        checks.push(opts);
        return snap;
      },
      skip: (version: string) => skipped.push(version),
      nextCheckAt: () => null,
    },
    { _skipped: skipped, _checks: checks },
  );
}

describe('AC-29: /update degrades cleanly without a port', () => {
  it('reports that updates are disabled and touches nothing', async () => {
    // `undefined` is a LEGITIMATE state — `update.mode: off`, a non-TTY, or CI
    // (§3.8) — so the command has to have something honest to say rather than
    // looking like a failure.
    const h = harness(undefined);
    await runSlashInput(registry, '/update', h.ctx);
    expect(h.notices.join('\n')).toContain('disabled for this session');
    expect(h.persisted).toEqual([]);
  });

  it('`/update off` STILL WORKS without a port', () => {
    // Turning something off must not require it to be running, or a user who
    // launched with `--no-update` could never make that stick.
    const h = harness(undefined);
    return runSlashInput(registry, '/update off', h.ctx).then(() => {
      expect(h.persisted).toEqual([{ update: { mode: 'off' } }]);
      expect(h.toasts.join('\n')).toContain('Auto-update off');
    });
  });
});

describe('AC-29: /update with a port', () => {
  it('status names the version, the source and the phase', async () => {
    const h = harness(fakePort());
    await runSlashInput(registry, '/update', h.ctx);
    const text = h.notices.join('\n');
    expect(text).toContain('0.5.9');
    expect(text).toContain('0.6.0');
    expect(text).toContain('npm-global');
  });

  it('`/update skip` calls port.skip with the offered version EXACTLY ONCE', async () => {
    const port = fakePort();
    const h = harness(port);
    await runSlashInput(registry, '/update skip', h.ctx);
    expect((port as unknown as { _skipped: string[] })._skipped).toEqual(['0.6.0']);
  });

  it('`/update skip` with nothing on offer says so instead of skipping ""', async () => {
    const port = fakePort({ latestVersion: null });
    const h = harness(port);
    await runSlashInput(registry, '/update skip', h.ctx);
    expect((port as unknown as { _skipped: string[] })._skipped).toEqual([]);
    expect(h.notices.join('\n')).toContain('nothing to skip');
  });

  it('`/update now` forces past the machine-wide throttle', async () => {
    // A human typing this is the one caller entitled to ignore `lastCheckAt`.
    const port = fakePort();
    const h = harness(port);
    await runSlashInput(registry, '/update now', h.ctx);
    expect((port as unknown as { _checks: { force?: boolean }[] })._checks).toEqual([
      { force: true },
    ]);
  });

  it('an unknown argument lists the real ones', async () => {
    const h = harness(fakePort());
    await runSlashInput(registry, '/update sideways', h.ctx);
    expect(h.notices.join('\n')).toContain('/update [status|now|skip|off]');
  });
});

// ---------------------------------------------------------------------------
// `/update status` - the hardening round's three lines (§6.3)
// ---------------------------------------------------------------------------

describe('§6.3: the three hardening lines, and the readout stays aligned', () => {
  /** A snapshot that lights up every optional line at once. */
  function loud(): UpdateCommandPort {
    return fakePort({
      phase: 'failed',
      reason: 'blocked-by-os',
      advice: 'npm i -g @aragon-agent/cli',
      rolledBackFrom: '0.6.0',
      rolledBackTo: '0.5.9',
      lastGoodVersion: '0.5.9',
      probe: 'npm',
      consecutiveFailures: 2,
    });
  }

  it('prints the rollback, the rollback TARGET and the probe', async () => {
    const h = harness(loud());
    await runSlashInput(registry, '/update', h.ctx);
    const text = h.notices.join('\n');
    // Each answers a question nothing else in the product answers: what the
    // guard did, what `--rollback` would reinstall, and whether this machine
    // reaches the registry directly.
    expect(text).toContain('0.6.0 -> 0.5.9');
    expect(text).toContain('lastgood');
    expect(text).toContain('npm (proxy fallback)');
  });

  it('names the direct probe too, rather than only the interesting one', async () => {
    const h = harness(fakePort({ probe: 'http' }));
    await runSlashInput(registry, '/update', h.ctx);
    expect(h.notices.join('\n')).toContain('http');
  });

  it('EVERY value starts in the same column, new lines included', async () => {
    // THE ONLY REASON THIS READOUT PADS ITS KEYS AT ALL. `rolledback` is ten
    // characters, which is the full width of the key column, so it cannot take a
    // separating space without pushing its value one past the six lines §6.3
    // says it matches - and a single misaligned row in a nine-row block is the
    // kind of thing every reader sees and no test catches. Asserted as a SET of
    // columns rather than against a constant, so it stays true if the column is
    // ever deliberately widened for all of them.
    const h = harness(loud());
    await runSlashInput(registry, '/update', h.ctx);
    const rows = h.notices
      .join('\n')
      .split('\n')
      .filter((l) => l.startsWith('  '));
    // Non-vacuous: the alignment claim is worthless if the optional rows are
    // absent, which is exactly how it would fail.
    expect(rows.length).toBeGreaterThanOrEqual(9);
    const valueColumns = new Set(rows.map((l) => (/^ {2}\S+\s+/.exec(l) as RegExpExecArray)[0].length));
    expect([...valueColumns]).toHaveLength(1);
  });
});

describe('§6.2: `aragon update --rollback` does not leave a crash notice behind', () => {
  it('clears `rolledBackFrom` AFTER the rollback it just ran', () => {
    // SOURCE-ASSERTED for the AC-4 / AC-5 / AC-22 reason: `cli.tsx` ends in
    // `main()`, so importing it here would run the CLI inside vitest.
    //
    // `performRollback` sets the field because it cannot tell which caller it
    // has, and the field has exactly ONE rendering - `rolled back to <to> after
    // <bad> FAILED TO START`. On the manual path that sentence is false: the
    // version started fine and the user simply did not want it. D-38's purpose
    // is that a downgrade the user did NOT ask for cannot be silent, and this
    // one was typed.
    // NEWLINES NORMALISED FIRST, and that is not tidying: this file is CRLF in
    // the working tree, so `'\n}\n'` never matches and the slice silently
    // becomes "the rest of cli.tsx". The assertions below would then pass on a
    // `rolledBackFrom: ''` written anywhere else in the file - a guard that
    // looks specific and checks nothing, which is the failure mode this suite
    // has a self-test for one level up.
    const source = readFileSync(join(SRC, 'cli.tsx'), 'utf-8').replace(/\r\n/g, '\n');
    const fn = source.slice(source.indexOf('async function runRollbackCommand'));
    const end = fn.indexOf('\n}\n');
    expect(end, 'the function body must actually be delimited').toBeGreaterThan(0);
    const body = fn.slice(0, end);
    expect(body).toContain("updateUpdateState({ rolledBackFrom: '' })");
    // AFTER the install, and the order is the assertion: clearing it before
    // `performRollback` runs would be erased by the write inside it, and
    // clearing it on the FAILURE path would suppress a notice the guard's own
    // path may still owe the user.
    expect(body.indexOf('await performRollback(VERSION, good)')).toBeLessThan(
      body.indexOf("rolledBackFrom: ''"),
    );
    expect(body.indexOf("rolledBackFrom: ''")).toBeGreaterThan(body.indexOf('if (!result.ok)'));
  });
});
