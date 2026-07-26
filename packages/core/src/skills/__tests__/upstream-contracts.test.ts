/**
 * RT-4 and RT-5 — the two assumptions this feature rests on that live in
 * SOMEBODY ELSE'S code (spec §14.3).
 *
 * Both are true today and nothing else in the repository is watching them. Each
 * one, if it changed, would degrade a skills feature silently and in a place
 * nobody would think to look:
 *
 *   RT-4  The digest tells the model "an earlier copy is above in this
 *         transcript". That is only true while the engine never prunes history.
 *   RT-5  A refusal is delivered as an `errorResult`, which works only because
 *         `ToolExecutor` never throws and the loop keeps going after an error.
 *         If the loop ever treated a tool error as fatal, one mis-declared
 *         `allowed-tools` would go from "the model routes around it" to "the
 *         turn dies", and W1's entire interaction model would be gone.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MessageManager } from '../../engine/message-manager.js';
import { ToolExecutor } from '../../tools/executor.js';
import { ToolRegistry } from '../../tools/registry.js';
import { errorResult, textResult } from '../../tools/helpers.js';
import type { AgentTool } from '../../tools/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const CORE_SRC = join(here, '..', '..');

/**
 * Anything that would drop, compact or window the conversation history.
 *
 * Matches an identifier that BEGINS with one of these words (`pruneOldMessages`
 * counts) but never a method call on a receiver — `code.trim()` is a string
 * operation and has nothing to do with history.
 */
const HISTORY_TRIMMING = /(?<![.\w])(prune|compact|evict|trim|truncateHistory)\w*/i;

const SCANNED = [
  join(CORE_SRC, 'engine', 'message-manager.ts'),
  // Widened past `message-manager.ts` on purpose: a windowing change is at least
  // as likely to be built on the existing `getLast(n)` helper from the loop side,
  // where a scan of the manager alone would never see it.
  join(CORE_SRC, 'engine', 'agent-loop.ts'),
  join(CORE_SRC, 'engine', 'agent.ts'),
];

const RT4_REMEDY =
  'The skill digest (W3) tells the model an earlier copy of the skill body is still in this ' +
  'conversation. If you are introducing history trimming or compaction, that claim stops being ' +
  'true — clear SkillRegistry.active when history is dropped, or make the digest unconditional-full.';

describe('RT-4 — the engine does not trim message history (FG10)', () => {
  it('no history-trimming API exists in the engine', () => {
    const offenders: string[] = [];
    for (const file of SCANNED) {
      const lines = readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        // Comments are scanned too: a doc comment describing a pruning helper is
        // as good a signal as the helper itself.
        if (HISTORY_TRIMMING.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders, RT4_REMEDY).toEqual([]);
  });

  it("MessageManager's public methods are exactly the six the digest assumes", () => {
    // A NEW method is the failure this asserts. Adding one forces whoever adds
    // it to read this test and decide about the digest deliberately.
    const own = Object.getOwnPropertyNames(MessageManager.prototype)
      .filter((n) => n !== 'constructor')
      .sort();
    expect(own, RT4_REMEDY).toEqual(['clear', 'getAll', 'getLast', 'length', 'push', 'restore']);
  });

  it('the scan would actually catch a trimming helper (self-check)', () => {
    // Without this, an over-narrow regex would make the assertion above pass
    // vacuously — the same trap the no-host-coupling guard documents.
    expect(HISTORY_TRIMMING.test('  private pruneOldMessages(): void {')).toBe(true);
    expect(HISTORY_TRIMMING.test('  compact(): void {')).toBe(true);
    expect(HISTORY_TRIMMING.test('  trimHistory(max: number): void {')).toBe(true);
    expect(HISTORY_TRIMMING.test('  getLast(n: number): Message[] {')).toBe(false);
    // A string operation is not a history operation.
    expect(HISTORY_TRIMMING.test('    if (code && code.trim().length > 0) {')).toBe(false);
  });
});

describe('RT-5 — an errorResult does not end the turn (FG13)', () => {
  function makeExecutor(): { executor: ToolExecutor; calls: string[] } {
    const calls: string[] = [];
    const denied: AgentTool = {
      name: 'bash',
      label: 'Bash',
      description: 'denied by policy',
      parameters: { type: 'object', properties: {} },
      async execute() {
        calls.push('bash');
        // Exactly what `withToolPolicy` returns on a refusal.
        return errorResult('Tool "bash" is not permitted while skill "x" is in effect.');
      },
    };
    const allowed: AgentTool = {
      name: 'read_file',
      label: 'Read',
      description: 'permitted',
      parameters: { type: 'object', properties: {} },
      async execute() {
        calls.push('read_file');
        return textResult('file contents');
      },
    };
    const registry = new ToolRegistry();
    registry.register(denied);
    registry.register(allowed);
    return { executor: new ToolExecutor(registry), calls };
  }

  it('the executor captures the refusal instead of throwing, and the next call still runs', async () => {
    const { executor, calls } = makeExecutor();

    const refused = await executor.execute('1', 'bash', {});
    expect(refused.isError).toBe(true);
    expect(refused.result.content[0]).toMatchObject({ type: 'text' });

    // The whole point: the model reads the refusal, picks a permitted tool, and
    // carries on. If this ever needed a try/catch around the first call, W1's
    // "give it an actionable message and let it route around" would be dead.
    const second = await executor.execute('2', 'read_file', {});
    expect(second.isError).toBeFalsy();
    expect(calls).toEqual(['bash', 'read_file']);
  });

  it('the loop pushes an isError tool_result and keeps iterating, rather than bailing', () => {
    // Asserted on the source because constructing a full agent run here would
    // need a live provider. The two properties that matter are that the error
    // becomes a message and that nothing breaks out of the loop because of it.
    const loop = readFileSync(join(CORE_SRC, 'engine', 'agent-loop.ts'), 'utf8');
    expect(loop).toContain("role: 'tool_result'");
    expect(loop).toContain('isError: execResult.isError');
    // The loop must not BRANCH on the error at all. The moment it does, that
    // branch is where "one wrong allowed-tools kills the turn" gets introduced.
    expect(
      /if\s*\([^)]*execResult\.isError/.test(loop),
      'agent-loop now branches on execResult.isError; W1 assumes a tool error is pushed and the ' +
        'loop continues (FG13). Re-read spec §14.3 RT-5 before changing this.',
    ).toBe(false);
  });

  it('the executor still documents its never-throws contract', () => {
    const executor = readFileSync(join(CORE_SRC, 'tools', 'executor.ts'), 'utf8');
    expect(executor).toContain('Never throws');
  });
});
