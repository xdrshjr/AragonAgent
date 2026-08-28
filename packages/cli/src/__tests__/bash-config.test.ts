/**
 * The `bash` config section, the prompt block's byte-identity claim, headless
 * resolution and the exit hook (§7.5 / AC-31, AC-33, AC-34, AC-42b, AC-45).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  clampBashConfig,
  DEFAULT_BASH_CONFIG,
  DEFAULT_CONFIG,
} from '../config/schema.js';
import { buildSystemPrompt } from '../agent/system-prompt.js';
import { buildBackgroundServicesBlock } from '../proc/prompt.js';
import { createBuiltinTools, HOST_TOOL_NAMES } from '../tools/index.js';
import { makeBash } from '../tools/bash-tool.js';
import {
  addSignalHook,
  installLogging,
  resetProcessHooksForTest,
  setSignalTerminator,
  type ProcessHookPort,
} from '../logging/install.js';
import type { ProcSupervisorPort } from '../proc/types.js';

describe('AC-31: clampBashConfig clamps and never throws', () => {
  it('resolves garbage to the defaults', () => {
    expect(clampBashConfig(undefined)).toEqual(DEFAULT_BASH_CONFIG);
    expect(clampBashConfig('nonsense')).toEqual(DEFAULT_BASH_CONFIG);
    expect(clampBashConfig({ background: 'yes', autoBackground: 3 })).toEqual(
      DEFAULT_BASH_CONFIG,
    );
  });

  it('clamps out-of-range timings to their bounds', () => {
    expect(clampBashConfig({ startupSettleMs: 1 }).startupSettleMs).toBe(500);
    expect(clampBashConfig({ startupSettleMs: 10_000_000 }).startupSettleMs).toBe(30_000);
    expect(clampBashConfig({ readyTimeoutMs: 1 }).readyTimeoutMs).toBe(5_000);
    expect(clampBashConfig({ readyTimeoutMs: 10_000_000 }).readyTimeoutMs).toBe(600_000);
  });

  it('honours a legitimate value, and both booleans', () => {
    const cfg = clampBashConfig({
      background: false,
      autoBackground: false,
      startupSettleMs: 2500,
      readyTimeoutMs: 30_000,
    });
    expect(cfg).toEqual({
      background: false,
      autoBackground: false,
      startupSettleMs: 2500,
      readyTimeoutMs: 30_000,
    });
  });

  it('ships in DEFAULT_CONFIG, so a pre-feature config.json does not read undefined', () => {
    // `background` is `true` by default, and `undefined` is FALSY - so without
    // this line the feature would arrive OFF for every existing user, which is
    // the one direction this particular default must never fail in.
    expect(DEFAULT_CONFIG.bash).toEqual(DEFAULT_BASH_CONFIG);
  });
});

describe('AC-33 / I-2: with background services off, nothing changes', () => {
  const cwd = process.cwd();

  it('the prompt is byte-identical for a fixed tool array', () => {
    const tools = createBuiltinTools({ getCwd: () => cwd });
    const off = buildSystemPrompt({ cwd, tools, backgroundBlock: '' });
    const pre = buildSystemPrompt({ cwd, tools });
    expect(off).toBe(pre);
    expect(off).not.toContain('<background_services>');
  });

  it('the block appears only when it is spliced', () => {
    const tools = createBuiltinTools({ getCwd: () => cwd });
    const on = buildSystemPrompt({
      cwd,
      tools,
      backgroundBlock: buildBackgroundServicesBlock(),
    });
    expect(on).toContain('<background_services>');
    // The `[note]` sentence is quoted VERBATIM, because it is the whole of
    // defence 1 as the model experiences it: telling it what those words mean is
    // the difference between "re-run with background: true" and reaching for
    // `Start-Process`.
    expect(on).toContain(
      '[note] the command exited but a background child is still holding its output stream.',
    );
  });

  it('`bash` has no `background` property and neither companion tool exists', () => {
    const names = createBuiltinTools({ getCwd: () => cwd }).map((t) => t.name);
    expect(names).not.toContain('bash_output');
    expect(names).not.toContain('bash_kill');
    const bash = createBuiltinTools({ getCwd: () => cwd }).find((t) => t.name === 'bash')!;
    expect(bash.parameters.properties?.background).toBeUndefined();
  });

  it('both names are still HOST_TOOL_NAMES - the superset, by definition', () => {
    // It answers "can a skill's `allowed-tools` declaration ever take effect?",
    // not "is it registered right now" - the same relationship `skills doctor`
    // already has with `--no-skills`.
    expect(HOST_TOOL_NAMES).toContain('bash_output');
    expect(HOST_TOOL_NAMES).toContain('bash_kill');
  });
});

describe('AC-45 (P1-8): headless resolution', () => {
  const cwd = process.cwd();
  const supervisor: ProcSupervisorPort = {
    start: async (req) => ({
      ok: true,
      service: {
        id: 's1',
        toolCallId: req.toolCallId,
        command: req.command,
        cwd: req.cwd,
        pid: 1,
        status: 'ready',
        startedAt: Date.now() - 100,
        readyAt: Date.now(),
        exitCode: null,
        signal: null,
        rows: [],
        rowsSeen: 0,
        truncated: false,
      },
    }),
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
  };

  it('the classifier still says `npm run dev` is long-running', async () => {
    // The rule suppresses the RESCUE, not the classification: `background: true`
    // is still honoured, because that one the model asked for.
    const { looksLongRunning } = await import('../proc/classify.js');
    expect(looksLongRunning('npm run dev')).toBe(true);
  });

  it('an EXPLICIT background launch says the service dies with the run', async () => {
    const bash = makeBash({ getCwd: () => cwd }, { supervisor, interactive: false });
    const result = await bash.execute('1', { command: 'npm run dev', background: true }, {});
    const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    expect(text).toContain('[background] service s1');
    // Headless has no card, no `/bg` and no user who could keep it alive, so a
    // silent reap at process exit would be a surprise rather than a behaviour.
    expect(text).toContain('stopped when the run ends');
  });

  it('an INTERACTIVE background launch carries no such note', async () => {
    const bash = makeBash({ getCwd: () => cwd }, { supervisor, interactive: true });
    const result = await bash.execute('2', { command: 'npm run dev', background: true }, {});
    const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    expect(text).not.toContain('stopped when the run ends');
  });
});

describe('R-8: the new tree is real and readable', () => {
  it('every proc source file exists', () => {
    // AC-34 itself - `inScope('proc/limits.ts')` - lives in `glyphs.test.ts`,
    // next to the predicate it asserts on. Importing a test module from here
    // would re-run every glyph suite inside this file for one assertion.
    const src = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'proc');
    for (const name of [
      'limits.ts',
      'types.ts',
      'classify.ts',
      'readiness.ts',
      'log-ring.ts',
      'kill-tree.ts',
      'supervisor.ts',
      'prompt.ts',
    ]) {
      expect(readFileSync(join(src, name), 'utf8').length, name).toBeGreaterThan(0);
    }
  });
});

describe('AC-42b (P1-2): addSignalHook does not displace the terminator', () => {
  it('hooks run BEFORE the single-slot terminator, and it still runs', () => {
    // `setSignalTerminator` is a SINGLE SLOT that `cli.tsx` already claims for
    // the alternate-screen restore. Registering a second terminator from `proc/`
    // would REPLACE it - the bug that leaves the user staring at a blank
    // alternate screen. An append-only hook list is what makes both possible.
    resetProcessHooksForTest();
    const order: string[] = [];
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const port: ProcessHookPort = {
      on(event, listener) {
        handlers.set(event, listener);
        return undefined;
      },
      exit(): never {
        order.push('exit');
        throw new Error('__exit__');
      },
      stderr: { write: () => true },
    };
    installLogging({ processPort: port, argv: [] });
    setSignalTerminator(() => {
      order.push('terminator');
    });
    const release = addSignalHook(() => {
      order.push('hook');
    });

    handlers.get('SIGINT')?.();
    expect(order).toEqual(['hook', 'terminator']);

    // And releasing is honoured, so a disposed controller stops reaping.
    order.length = 0;
    release();
    handlers.get('SIGINT')?.();
    expect(order).toEqual(['terminator']);
    resetProcessHooksForTest();
  });

  it('a hook that THROWS does not stop the exit', () => {
    resetProcessHooksForTest();
    const order: string[] = [];
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const port: ProcessHookPort = {
      on(event, listener) {
        handlers.set(event, listener);
        return undefined;
      },
      exit(): never {
        order.push('exit');
        throw new Error('__exit__');
      },
      stderr: { write: () => true },
    };
    installLogging({ processPort: port, argv: [] });
    setSignalTerminator(() => {
      order.push('terminator');
    });
    addSignalHook(() => {
      throw new Error('reaper blew up');
    });
    handlers.get('SIGTERM')?.();
    expect(order).toEqual(['terminator']);
    resetProcessHooksForTest();
  });
});
