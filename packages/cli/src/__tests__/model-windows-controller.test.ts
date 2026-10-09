/**
 * `model-windows.json` as the controller resolves it.
 *
 * The gauge's `?` is the visible half of a diagnosis: an id no table knows
 * resolves to the untrusted 128k fallback, so `windowKnown` stays false on
 * every turn. These cases pin the whole precedence ladder the fix rests on:
 *
 *   config.json `contextWindow` > model-windows.json > builtin/CATALOG > fallback
 *
 * The table is INJECTED through `ControllerDeps.modelWindows` rather than
 * written into the vitest home root: that root is shared per process
 * (`app-paths.ts` TEST-ISOLATION CONTRACT), and a stray file there could flip
 * `windowKnown` in some other suite's controller.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentController } from '../agent/controller.js';
import { ModelWindows } from '../config/model-windows.js';
import { DEFAULT_CONFIG, DEFAULT_SKILLS_RUNTIME, type CliConfig } from '../config/schema.js';

const controllers: AgentController[] = [];
const dirs: string[] = [];

afterEach(() => {
  controllers.splice(0).forEach((controller) => controller.dispose());
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

interface SetupOpts {
  model?: string;
  fileBody?: string;
  configWindow?: number | null;
}

function setup(opts: SetupOpts = {}): AgentController {
  const dir = mkdtempSync(join(tmpdir(), 'model-windows-ctl-'));
  dirs.push(dir);
  const windowsPath = join(dir, 'model-windows.json');
  if (opts.fileBody !== undefined) writeFileSync(windowsPath, opts.fileBody, 'utf8');

  const config = {
    ...DEFAULT_CONFIG, cwd: process.cwd(), color: true, unicode: true, submitCount: 0,
    startInPlanMode: false, skillsRuntime: DEFAULT_SKILLS_RUNTIME,
    provider: 'anthropic', model: opts.model ?? 'kimi-k3', baseUrl: 'https://gw.test/coding',
    contextWindow: opts.configWindow ?? null,
    skills: { ...DEFAULT_CONFIG.skills, enabled: false },
    compaction: { ...DEFAULT_CONFIG.compaction, enabled: false },
    team: { ...DEFAULT_CONFIG.team, enabled: false },
    fast: { ...DEFAULT_CONFIG.fast, enabled: false },
    apiKeys: { anthropic: 'k' },
  } as CliConfig;
  const controller = new AgentController(config, { modelWindows: new ModelWindows(windowsPath) });
  controllers.push(controller);
  return controller;
}

describe('model-windows.json through the controller', () => {
  it('an id no table knows stays unknown without a file entry', () => {
    const usage = setup().getContextUsage();
    expect(usage.windowKnown).toBe(false);
    expect(usage.window).toBe(128_000);
  });

  it('a declared window makes the denominator known and names its source', () => {
    const usage = setup({ fileBody: '{"windows":{"kimi-k3":1048576}}' }).getContextUsage();
    expect(usage.windowKnown).toBe(true);
    expect(usage.window).toBe(1_048_576);
    expect(usage.windowSource).toBe('user');
    expect(usage.windowOverridden).toBe(false);
  });

  it('the user file outranks the builtin model table', () => {
    // `gpt-4o` IS in the builtin lists at 128k; a user declaration wins.
    const usage = setup({ model: 'gpt-4o', fileBody: '{"windows":{"gpt-4o":999000}}' })
      .getContextUsage();
    expect(usage.window).toBe(999_000);
    expect(usage.windowSource).toBe('user');
  });

  it("config.json's contextWindow still outranks the user file", () => {
    const usage = setup({
      fileBody: '{"windows":{"kimi-k3":1048576}}',
      configWindow: 555_000,
    }).getContextUsage();
    expect(usage.window).toBe(555_000);
    expect(usage.windowOverridden).toBe(true);
  });

  it('a broken file degrades to the honest unknown, never a crash', () => {
    const usage = setup({ fileBody: '{broken' }).getContextUsage();
    expect(usage.windowKnown).toBe(false);
    expect(usage.window).toBe(128_000);
  });
});
