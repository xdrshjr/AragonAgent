import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Message } from '@aragon-agent/core';
import { saveSession, loadSession } from '../session/persist.js';
import { buildCompactedBlock } from '../compaction/summary-prompt.js';
import { createCompactionIdentity } from '../compaction/memory-identity.js';
import { AgentController } from '../agent/controller.js';
import { DEFAULT_CONFIG, DEFAULT_SKILLS_RUNTIME, type CliConfig } from '../config/schema.js';
import { registerBuiltinCommands } from '../commands/builtins.js';
import { CommandRegistry, type CommandContext } from '../commands/registry.js';
import { initialViewState } from '../agent/reducer.js';

const directory = resolve('.agentmesh/compaction-session-roundtrip-tests');
mkdirSync(directory, { recursive: true });
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function fixture() {
  const messages: Message[] = [
    { role: 'user', content: 'Original task <compacted_context> stays literal', timestamp: 10 },
    buildCompactedBlock({ memory: {
      schemaVersion: 2, generation: 3,
      originalTask: { sourceId: 'g1:m0', location: 'anchor' },
      userMessages: [], items: [],
      coverage: { summarizedMessages: 5, clippedToolResults: [], legacyIncomplete: false },
    }, generation: 3, replaced: 5, turns: 2, anchor: 'verbatim', timestamp: 20 }),
  ];
  return { messages, compactionIdentity: createCompactionIdentity(messages) };
}

function controller(enabled = true) {
  return new AgentController({
    ...DEFAULT_CONFIG, cwd: process.cwd(), skillsRuntime: DEFAULT_SKILLS_RUNTIME,
    startInPlanMode: false, submitCount: 0, color: true,
    skills: { ...DEFAULT_CONFIG.skills, enabled: false },
    compaction: { ...DEFAULT_CONFIG.compaction, enabled },
    fast: { ...DEFAULT_CONFIG.fast, enabled: false },
    team: { ...DEFAULT_CONFIG.team, enabled: false },
  } as CliConfig, {});
}

describe('compaction session provenance', () => {
  it('writes and reloads the optional credential without changing outer version', () => {
    const data = fixture();
    const path = resolve(directory, 'memory.json');
    saveSession(path, { ...data, model: { providerId: 'anthropic', modelId: 'test' },
      entries: [], todos: [] });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      version: 1, compactionIdentity: data.compactionIdentity,
    });
    expect(loadSession(path)).toMatchObject(data);
  });

  it.each([true, false])('restores provenance with compaction enabled=%s and clears it on reset', (enabled) => {
    const agent = controller(enabled);
    try {
      const data = fixture();
      agent.replaceMessages(data.messages, data.compactionIdentity);
      expect(agent.getSessionSnapshot()).toEqual(data);
      agent.clearMessages();
      expect(agent.getSessionSnapshot()).toEqual({ messages: [] });
    } finally { agent.dispose(); }
  });

  it('keeps invalid identity evidence rather than silently granting or dropping authority', () => {
    const agent = controller();
    try {
      const data = fixture();
      const invalid = { ...data.compactionIdentity, prefixSha256: '0'.repeat(64) };
      agent.replaceMessages(data.messages, invalid);
      expect(agent.getSessionSnapshot()).toEqual({ messages: data.messages, compactionIdentity: invalid });
      agent.replaceMessages(data.messages);
      expect(agent.getSessionSnapshot()).toEqual({ messages: data.messages });
    } finally { agent.dispose(); }
  });

  it('TUI save and resume pass history and identity together', async () => {
    const agent = controller();
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const ctx = { controller: agent, args: resolve(directory, 'commands.json'),
      state: initialViewState(), notify: vi.fn(), toast: vi.fn(), dispatch: vi.fn(),
    } as unknown as CommandContext;
    try {
      const data = fixture();
      agent.replaceMessages(data.messages, data.compactionIdentity);
      await registry.get('save')!.run(ctx);
      agent.clearMessages();
      await registry.get('resume')!.run(ctx);
      expect(agent.getSessionSnapshot()).toEqual(data);
    } finally { agent.dispose(); }
  });
});
