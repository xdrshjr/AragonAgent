/**
 * App-level contract for the Ctrl+I project-index trigger.
 *
 * The unit tests in `index-build.test.ts` cover the words; THIS file covers
 * the flow the user actually meets: the INDEX frame opens the shared confirm
 * dialog (never a silent start), `y` dispatches `/skill:project-indexer` the
 * same way a typed command would - so the invocation reaches the agent as a
 * normal submitted turn - and both refusal paths (reject, busy) leave the
 * agent untouched. The skill service is faked so the test does not depend on
 * what happens to be installed in the user scope of the machine running it.
 */

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent, SkillRecord } from '@aragon-agent/core';
import { normalizeFrontmatter } from '@aragon-agent/core/skills';
import type { CompactionEvent } from '../compaction/types.js';
import { AgentController } from '../agent/controller.js';
import { DEFAULT_CONFIG, DEFAULT_SKILLS_RUNTIME, type CliConfig } from '../config/schema.js';
import { App } from '../ui/App.js';
import { INDEX_KEY_FRAME } from '../input/limits.js';
import { INDEX_SKILL_NAME } from '../commands/index-build.js';
import type { SkillService } from '../skills/service.js';
import { createTerminalHarness, settleTerminal } from './helpers/terminal-harness.js';

vi.mock('../config/prompt-history.js', () => ({ loadPromptHistory: () => [],
  appendPrompt: () => [] }));
vi.mock('../config/ui-state.js', () => ({ bumpSubmitCount: () => 1,
  setMouseNoticeVersion: () => {}, setVtInputNoticeVersion: () => {} }));

function indexerRecord(): SkillRecord {
  const description = `Generate and use a project index. Use when the user says "regenerate index" or presses Ctrl+I.`;
  return {
    name: INDEX_SKILL_NAME,
    description,
    scope: 'bundled',
    dir: '/skills/project-indexer',
    entryPath: '/skills/project-indexer/SKILL.md',
    frontmatter: normalizeFrontmatter(
      { name: INDEX_SKILL_NAME, description, version: '1.1.0' },
      INDEX_SKILL_NAME,
    ),
    body: null,
    files: null,
    bytes: 10,
    disabled: false,
    issues: [],
    invalid: false,
    shadowed: [],
    manifest: null,
    writable: false,
    integrity: 'unverified',
  };
}

/** The SkillService surface App and the skill command actually touch. */
function fakeService(records: SkillRecord[]): SkillService {
  const activeNames: string[] = [];
  return {
    list: () => records,
    get: (name: string) => records.find((r) => r.name === name),
    untrustedDirs: () => [],
    errors: () => [],
    loadBody: (name: string) => ({ body: `# ${name}\n\nCurrent request: $ARGUMENTS`, files: [] }),
    getRegistry: () => ({
      activeNames,
      activate: (n: string) => {
        activeNames.push(n);
        return false;
      },
      isActive: (n: string) => activeNames.includes(n),
    }),
    queueFrame: () => undefined,
    frameNames: () => [],
    clearFrames: () => undefined,
    bodyMaxBytes: () => 30_000,
    effectiveToolPolicy: () => ({ mode: 'enforce' as const, from: 'config' as const }),
    setSessionToolPolicy: () => undefined,
    persistToolPolicy: () => undefined,
    pendingToolPolicyView: () => undefined,
    getApproval: () => ({ canPrompt: () => false, request: async () => false }),
  } as unknown as SkillService;
}

function fixture(records: SkillRecord[]) {
  const config = { ...DEFAULT_CONFIG, cwd: process.cwd(), color: false, unicode: false,
    reducedMotion: true, showThinking: true, startInPlanMode: false, submitCount: 20,
    skillsRuntime: DEFAULT_SKILLS_RUNTIME, apiKeys: { anthropic: 'fixture' },
    skills: { ...DEFAULT_CONFIG.skills, enabled: true },
    compaction: { ...DEFAULT_CONFIG.compaction, enabled: false },
    team: { ...DEFAULT_CONFIG.team, enabled: false },
    fast: { ...DEFAULT_CONFIG.fast, enabled: false },
  } as CliConfig;
  const controller = new AgentController(config, { notify: () => {} });
  let receive!: (event: AgentEvent) => void;
  vi.spyOn(controller, 'subscribe').mockImplementation((listener) => {
    receive = listener; return () => {};
  });
  let receiveCompaction!: (event: CompactionEvent) => void;
  vi.spyOn(controller, 'subscribeCompaction').mockImplementation((listener) => {
    receiveCompaction = listener; return () => {};
  });
  vi.spyOn(controller, 'getSkillService').mockReturnValue(fakeService(records));
  vi.spyOn(controller, 'preflight').mockReturnValue({ ok: true });
  const prompt = vi.fn().mockResolvedValue(undefined);
  vi.spyOn(controller, 'prompt').mockImplementation(prompt);
  return { controller, prompt, emit: (event: AgentEvent) => receive(event) };
}

describe('Ctrl+I project-index trigger', () => {
  it('opens the confirm dialog; y submits the skill invocation as a normal turn', async () => {
    const terminal = createTerminalHarness();
    const { controller, prompt } = fixture([indexerRecord()]);
    try {
      terminal.mount(<App controller={controller} version="test" />);
      await settleTerminal();
      terminal.input(INDEX_KEY_FRAME);
      await settleTerminal();
      const dialog = terminal.lastFrame();
      expect(dialog).toContain('Build the project index');
      expect(dialog).toContain(INDEX_SKILL_NAME);
      expect(dialog).toContain('.claude-index/index.md');
      expect(prompt).not.toHaveBeenCalled();

      terminal.input('y');
      await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
      const [message] = prompt.mock.calls[0] as [string];
      expect(message).toContain(`<skill name="${INDEX_SKILL_NAME}"`);
      // The args must tell the model the turn came from a confirmed keypress.
      expect(message).toContain('Ctrl+I');
      expect(message).toContain('confirmed');
    } finally {
      terminal.dispose();
      controller.dispose();
    }
  });

  it('rejecting the dialog leaves the agent untouched', async () => {
    const terminal = createTerminalHarness();
    const { controller, prompt } = fixture([indexerRecord()]);
    try {
      terminal.mount(<App controller={controller} version="test" />);
      await settleTerminal();
      terminal.input(INDEX_KEY_FRAME);
      await settleTerminal();
      expect(terminal.lastFrame()).toContain('Build the project index');
      terminal.input('n');
      await settleTerminal();
      expect(prompt).not.toHaveBeenCalled();
      expect(terminal.lastFrame()).not.toContain('Build the project index');
    } finally {
      terminal.dispose();
      controller.dispose();
    }
  });

  it('warns instead of queueing while a run is in flight', async () => {
    const terminal = createTerminalHarness();
    const { controller, prompt, emit } = fixture([indexerRecord()]);
    try {
      terminal.mount(<App controller={controller} version="test" />);
      await settleTerminal();
      emit({ type: 'agent_start' } as AgentEvent);
      await settleTerminal();
      terminal.input(INDEX_KEY_FRAME);
      await settleTerminal();
      const frame = terminal.lastFrame();
      expect(frame).toContain('busy');
      expect(frame).not.toContain('Build the project index');
      expect(prompt).not.toHaveBeenCalled();
    } finally {
      terminal.dispose();
      controller.dispose();
    }
  });

  it('explains when the bundled skill is missing or disabled', async () => {
    const terminal = createTerminalHarness();
    const missing = indexerRecord();
    missing.disabled = true;
    const { controller, prompt } = fixture([missing]);
    try {
      terminal.mount(<App controller={controller} version="test" />);
      await settleTerminal();
      terminal.input(INDEX_KEY_FRAME);
      await settleTerminal();
      expect(terminal.lastFrame()).toContain('not available');
      expect(prompt).not.toHaveBeenCalled();
    } finally {
      terminal.dispose();
      controller.dispose();
    }
  });

  it('ignores the frame while an overlay is open (same guard as Ctrl+G)', async () => {
    const terminal = createTerminalHarness();
    const { controller, prompt } = fixture([indexerRecord()]);
    try {
      terminal.mount(<App controller={controller} version="test" />);
      await settleTerminal();
      terminal.input('?');
      await settleTerminal();
      expect(terminal.lastFrame()).toContain('Keybindings');
      terminal.input(INDEX_KEY_FRAME);
      await settleTerminal();
      expect(terminal.lastFrame()).toContain('Keybindings');
      expect(prompt).not.toHaveBeenCalled();
    } finally {
      terminal.dispose();
      controller.dispose();
    }
  });
});
