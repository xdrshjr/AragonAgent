/**
 * The ORDER of a conversation reset (clear-command-context-reset T-1..T-6).
 *
 * The order is the design, so the order is what these tests assert. A fake port
 * that only records call names can prove "interrupt happened before archive" and
 * "a failed wait cleared nothing"; a real controller cannot prove either without
 * constructing half the package and racing it.
 */

import { afterAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import {
  CLEAR_STILL_RUNNING_MESSAGE,
  resetConversationWith,
  type ConversationResetPort,
} from '../agent/conversation-reset.js';
import type { CliConfig } from '../config/schema.js';

interface Harness {
  port: ConversationResetPort;
  calls: string[];
  /** The message count `clearHistory` will report. */
  messages: { count: number };
}

function harness(opts: { running?: boolean; settled?: boolean; archived?: string | null } = {}) {
  const calls: string[] = [];
  const messages = { count: 3 };
  const port: ConversationResetPort = {
    isRunning: vi.fn(() => opts.running ?? false),
    interruptRun: vi.fn(() => { calls.push('interruptRun'); }),
    awaitEngineIdle: vi.fn(async () => {
      calls.push('awaitEngineIdle');
      return opts.settled ?? true;
    }),
    archive: vi.fn((readTranscript) => {
      // Reading the transcript HERE is the point: the archive must see what the
      // engine wrote while it was unwinding, not what existed at command entry.
      calls.push(`archive:${readTranscript().length}`);
      return opts.archived ?? null;
    }),
    clearQueues: vi.fn(() => { calls.push('clearQueues'); }),
    clearHistory: vi.fn(() => {
      calls.push('clearHistory');
      return messages.count;
    }),
  };
  return { port, calls, messages } satisfies Harness;
}

describe('resetConversationWith', () => {
  it('clears history and queues when idle', async () => {
    const h = harness();
    const result = await resetConversationWith(h.port, { readTranscript: () => [] });

    // An idle clear fires no interrupt at all - not an interrupt that resolves
    // instantly, which would still bump the run generation and make the view
    // discard the next legitimate run's events.
    expect(h.calls).toEqual(['archive:0', 'clearQueues', 'clearHistory']);
    expect(result).toEqual({
      ok: true, interrupted: false, archivedPath: null, messagesCleared: 3,
    });
  });

  it('does not interrupt an idle engine', async () => {
    const h = harness();
    await resetConversationWith(h.port);
    expect(h.port.interruptRun).not.toHaveBeenCalled();
  });

  it('interrupts a running engine and waits for it to settle', async () => {
    const h = harness({ running: true });
    const result = await resetConversationWith(h.port, {
      readTranscript: () => [{ id: 'e1', kind: 'user', text: 'hi' }],
    });

    expect(h.calls).toEqual([
      'interruptRun', 'awaitEngineIdle', 'archive:1', 'clearQueues', 'clearHistory',
    ]);
    expect(result).toMatchObject({ ok: true, interrupted: true });
  });

  it('returns still-running and clears nothing when the engine does not settle', async () => {
    const h = harness({ running: true, settled: false });
    const result = await resetConversationWith(h.port);

    // HALF A RESET IS WORSE THAN NONE (I-4): emptied queues beside an intact
    // history leave the view and the engine disagreeing with no visible cause.
    expect(result).toEqual({
      ok: false, reason: 'still-running', message: CLEAR_STILL_RUNNING_MESSAGE,
    });
    expect(h.port.archive).not.toHaveBeenCalled();
    expect(h.port.clearQueues).not.toHaveBeenCalled();
    expect(h.port.clearHistory).not.toHaveBeenCalled();
  });

  it('honours interrupt:false by refusing a running engine', async () => {
    const h = harness({ running: true });
    const result = await resetConversationWith(h.port, { interrupt: false });

    expect(result).toMatchObject({ ok: false, reason: 'still-running' });
    expect(h.port.interruptRun).not.toHaveBeenCalled();
    expect(h.port.clearHistory).not.toHaveBeenCalled();
  });

  it('archives before it clears, and never after', async () => {
    const h = harness({ running: true });
    await resetConversationWith(h.port, { readTranscript: () => [] });

    const archiveAt = h.calls.findIndex((call) => call.startsWith('archive'));
    const clearAt = h.calls.indexOf('clearHistory');
    expect(archiveAt).toBeGreaterThan(-1);
    expect(archiveAt).toBeLessThan(clearAt);
  });

  it('reports the archived path it was given', async () => {
    const h = harness({ archived: 'C:/sessions/cleared/a.json' });
    const result = await resetConversationWith(h.port);
    expect(result).toMatchObject({ ok: true, archivedPath: 'C:/sessions/cleared/a.json' });
  });

  it('still clears when the conversation is empty', async () => {
    // `archive` returning null is the ordinary answer for an empty conversation,
    // not a failure: the clear must proceed and report no path.
    const h = harness({ archived: null });
    const result = await resetConversationWith(h.port);
    expect(result).toMatchObject({ ok: true, archivedPath: null });
    expect(h.port.clearHistory).toHaveBeenCalledOnce();
  });
});

describe('the controller adapter (C-1: interrupt is a FORCE stop)', () => {
  it('maps interruptRun to forceStop, not abort', () => {
    // THE ONE-LINE REGRESSION THAT WOULD UNDO P0-2, pinned as source because it
    // cannot be pinned behaviourally from here: the port above is a fake, and
    // `abort()` looks identical to `forceStop()` in every state this file can
    // observe. What differs is `runGen` - bumped only by `forceStop()` - which is
    // the fence `App` compares every engine event against. Swap this line back to
    // `this.abort()` and the abandoned run's last tool cards reappear in the new
    // conversation, with nothing else in the package noticing.
    const source = readFileSync(new URL('../agent/controller.ts', import.meta.url), 'utf8');
    const start = source.indexOf('async resetConversation(');
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf('private describeClearedConversation'));
    expect(body).toContain('interruptRun: () => this.forceStop()');
    expect(body).not.toContain('this.abort()');
  });
});

/**
 * THE REAL BOUNDARY, DRIVEN END TO END (AC-1).
 *
 * Everything above proves the ORDER against a fake port, and the command-level
 * files prove the command asks for a reset. Neither would notice if the
 * controller's `clearHistory` adapter stopped calling `clearMessages()` - the fake
 * port returns a number either way - and "the messages are still there" is the
 * exact defect this feature exists to fix. So the history gets one assertion on
 * the real object.
 *
 * `ARAGON_HOME` IS REDIRECTED BEFORE THE CONTROLLER MODULE GRAPH LOADS: a reset
 * archives the conversation it is about to drop, and a test must not write into
 * the developer's own sessions directory.
 */
const HOME = mkdtempSync(join(tmpdir(), 'aragon-cli-reset-'));
process.env.ARAGON_HOME = HOME;

const { AgentController } = await import('../agent/controller.js');
const { DEFAULT_CONFIG, DEFAULT_SKILLS_RUNTIME } = await import('../config/schema.js');

describe('AgentController.resetConversation (the real six-part boundary)', () => {
  const controllers: { dispose: () => void }[] = [];

  afterAll(() => {
    controllers.splice(0).forEach((controller) => controller.dispose());
    rmSync(HOME, { recursive: true, force: true });
  });

  it('empties the messages the next request would send, and counts them first', async () => {
    const config = {
      ...DEFAULT_CONFIG,
      cwd: process.cwd(),
      color: false,
      unicode: true,
      submitCount: 0,
      startInPlanMode: false,
      skillsRuntime: DEFAULT_SKILLS_RUNTIME,
      compaction: { ...DEFAULT_CONFIG.compaction, enabled: false },
      team: { ...DEFAULT_CONFIG.team, enabled: false },
      fast: { ...DEFAULT_CONFIG.fast, enabled: false },
      skills: { ...DEFAULT_CONFIG.skills, enabled: false },
      apiKeys: { anthropic: 'test' },
    } as CliConfig;
    const controller = new AgentController(config, { notify: () => {} });
    controllers.push(controller);
    controller.replaceMessages([{ role: 'user', content: 'the old question', timestamp: 1 }]);
    controller.restoreTodos([{ content: 'old plan', status: 'pending' }]);
    expect(controller.getMessages()).toHaveLength(1);

    const result = await controller.resetConversation({ readTranscript: () => [] });

    if (!result.ok) throw new Error('an idle conversation must never refuse a reset');
    // AC-1: the history is GONE, on the real object, not just "clearHistory was
    // called". `messagesCleared` is read before the clear (I-9); taken afterwards
    // it would report 0 and the log would state a falsehood.
    expect(controller.getMessages()).toEqual([]);
    expect(result.messagesCleared).toBe(1);
    // The rest of the same call: the plan goes with the conversation, and the
    // archive is a real file at the path the user is told to `/resume`.
    expect(controller.getTodoSnapshot()).toBeNull();
    expect(result.archivedPath).toBeTruthy();
    expect(existsSync(result.archivedPath!)).toBe(true);
  });
});
