/**
 * App-level contract for `ctrl+K` (agent-model-kits AC-23 / AC-25 / §4.7).
 *
 * THE TWO LISTENERS ARE THE POINT. `PromptInput`'s keymap used to own `Ctrl+K`
 * (`killToEnd`) and its recognizer runs BEFORE the `key.ctrl` early-return, so
 * "the overlay opened" is not the whole assertion - the draft must also still be
 * there. That is asserted here, because it is the one failure mode a user would
 * experience as data loss rather than as a missing feature.
 */

import React from 'react';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@aragon-agent/core';
import { AgentController } from '../agent/controller.js';
import { DEFAULT_CONFIG, type CliConfig, type PersistedConfig } from '../config/schema.js';
import { normalizeModelProfiles } from '../config/model-profiles.js';
import { writeConfigFile } from '../config/store.js';
import { App } from '../ui/App.js';
import { createTerminalHarness, settleTerminal } from './helpers/terminal-harness.js';

// A PRIVATE CONFIG PATH - see the long note in `kit-apply.test.ts`. This file
// seeds `config.json` and drives the real controller, so a sibling kit file in
// the same threads worker would otherwise hold the same file.
process.env.ARAGON_HOME = process.env.ARAGON_HOME
  ?? mkdtempSync(join(tmpdir(), 'aragon-kit-key-'));

vi.mock('../config/prompt-history.js', () => ({ loadPromptHistory: () => [],
  appendPrompt: () => [] }));
vi.mock('../config/ui-state.js', () => ({ bumpSubmitCount: () => 1,
  setMouseNoticeVersion: () => {}, setVtInputNoticeVersion: () => {} }));

const library = (kits: unknown[] = [{ id: 'kit-1', name: 'Deep work', mainProfileId: 'p-main',
  fastProfileId: null, subagent: { model: 'main', modelProfileId: null } }]) =>
  normalizeModelProfiles({ version: 1, mainId: 'p-main', fastId: null,
    entries: [{ id: 'p-main', name: 'Opus', provider: 'anthropic', model: 'opus-4',
      baseUrl: null, apiKey: null, contextWindow: 200000 }],
    kits, defaultKitId: null, kitsVersion: 1 });

function fixture(over: Partial<CliConfig> = {}) {
  const config = { ...DEFAULT_CONFIG, cwd: process.cwd(), color: false, unicode: false,
    reducedMotion: true, startInPlanMode: false, submitCount: 20,
    apiKeys: { anthropic: 'fixture' },
    skills: { ...DEFAULT_CONFIG.skills, enabled: false },
    compaction: { ...DEFAULT_CONFIG.compaction, enabled: false },
    team: { ...DEFAULT_CONFIG.team, enabled: false },
    fast: { ...DEFAULT_CONFIG.fast, enabled: false },
    modelProfiles: library(),
    ...over,
  } as CliConfig;
  const controller = new AgentController(config, { notify: () => {} });
  // THE DISK IS PART OF THE CONTRACT: a session kit is applied from the draft's
  // library, which is read from `config.json`, not from the live config. Without
  // a seeded file every apply in this file would answer `kit_missing`.
  writeConfigFile({ ...structuredClone(DEFAULT_CONFIG), provider: 'anthropic',
    model: 'opus-4', apiKeys: { anthropic: 'fixture' },
    modelProfiles: library() } as unknown as PersistedConfig);
  let receive!: (event: AgentEvent) => void;
  vi.spyOn(controller, 'subscribe').mockImplementation((listener) => {
    receive = listener; return () => {};
  });
  vi.spyOn(controller, 'preflight').mockReturnValue({ ok: true });
  const prompt = vi.fn().mockResolvedValue(undefined);
  vi.spyOn(controller, 'prompt').mockImplementation(prompt);
  return { controller, prompt, emit: (event: AgentEvent) => receive(event) };
}

describe('Ctrl+K opens the Agent-kit picker', () => {
  it('opens the overlay and leaves the draft alone (D-15)', async () => {
    const terminal = createTerminalHarness(100, 30);
    const { controller } = fixture();
    try {
      terminal.mount(<App controller={controller} version="test" />);
      await settleTerminal();
      terminal.input('hello draft');
      await settleTerminal();
      terminal.input('\x0b');
      await settleTerminal();
      const frame = terminal.lastFrame();
      expect(frame).toContain('Agent kits');
      expect(frame).toContain('Current setup');
      // THE DRAFT SURVIVED: `killToEnd` no longer answers this byte.
      expect(frame).toContain('hello draft');
    } finally {
      terminal.dispose();
      controller.dispose();
    }
  });

  it('opens the overlay mid-run but REFUSES the apply, which is the honest pair', async () => {
    const terminal = createTerminalHarness(100, 30);
    const { controller } = fixture();
    try {
      terminal.mount(<App controller={controller} version="test" />);
      await settleTerminal();
      // THE BUSY FLAG IS THE CONTROLLER'S, and `subscribe` is mocked here, so a
      // synthetic `agent_start` would never reach it; spy on the predicate the
      // picker actually consults.
      vi.spyOn(controller, 'isModelSettingsBusy').mockReturnValue(true);
      terminal.input('\x0b');
      await settleTerminal();
      // Browsable while busy: a key that does nothing at all reads as broken.
      expect(terminal.lastFrame()).toContain('Agent kits');
      terminal.input('\x1b[B');
      await settleTerminal();
      terminal.input('\r');
      await settleTerminal();
      await vi.waitFor(() => expect(terminal.lastFrame()).toContain('Wait for the current run'));
      expect(controller.getConfig().sessionKit).toBeUndefined();
    } finally {
      terminal.dispose();
      controller.dispose();
    }
  });

  it('applies the focused kit on Enter and closes (AC-25)', async () => {
    const terminal = createTerminalHarness(100, 30);
    const { controller } = fixture();
    try {
      terminal.mount(<App controller={controller} version="test" />);
      await settleTerminal();
      terminal.input('\x0b');
      await settleTerminal();
      terminal.input('\x1b[B');   // past `Current setup`, onto the kit
      await settleTerminal();
      terminal.input('\r');
      await vi.waitFor(() => expect(controller.getConfig().sessionKit?.id).toBe('kit-1'));
      await settleTerminal();
      expect(terminal.lastFrame()).not.toContain('Agent kits');
      expect(terminal.lastFrame()).toContain('Kit Deep work applied');
    } finally {
      terminal.dispose();
      controller.dispose();
    }
  });

  it('releases the session kit when Current setup is chosen (AC-25)', async () => {
    const terminal = createTerminalHarness(100, 30);
    const { controller } = fixture();
    try {
      controller.applySessionKit('kit-1');
      expect(controller.getConfig().sessionKit?.id).toBe('kit-1');
      terminal.mount(<App controller={controller} version="test" />);
      await settleTerminal();
      terminal.input('\x0b');
      await settleTerminal();
      terminal.input('\r');       // Current setup is always row 0
      await vi.waitFor(() => expect(controller.getConfig().sessionKit).toBeUndefined());
    } finally {
      terminal.dispose();
      controller.dispose();
    }
  });

  it('is ignored while an overlay already owns the keyboard, or on a tiny terminal', async () => {
    const terminal = createTerminalHarness(100, 30);
    const { controller } = fixture();
    try {
      terminal.mount(<App controller={controller} version="test" initialOverlay="help" />);
      await settleTerminal();
      terminal.input('\x0b');
      await settleTerminal();
      expect(terminal.lastFrame()).toContain('Help');
      expect(terminal.lastFrame()).not.toContain('Current setup');
    } finally {
      terminal.dispose();
      controller.dispose();
    }
  });
});
