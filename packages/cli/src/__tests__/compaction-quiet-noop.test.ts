/**
 * The quiet no-op: a compaction announces itself IF AND ONLY IF it commits to
 * doing work (context-auto-compaction-quiet-noop §7.1, AC-Q1 .. AC-Q16).
 *
 * WHAT THIS FILE PINS IS AN ABSENCE, which is the hardest kind of behaviour to
 * keep. Every assertion below that counts ZERO events is guarding against the
 * same regression from the other direction: someone moving the announce point
 * back to the top of `compact()` "because that is where the counter is", and
 * every existing suite staying green while the user's transcript fills up with
 * red `context not compacted #2: nothing_to_drop` cards again.
 *
 * THE THREE HALVES THAT MUST NOT DRIFT APART. A declined checkpoint is silent in
 * the TRANSCRIPT (AC-Q1, AC-Q2), still charged to the GUARDS (AC-Q10, AC-Q11),
 * and still counted on `/compact status` (AC-Q15, AC-Q16). Deleting any one of
 * the three turns "quiet" into either "loud" or "invisible", and only the middle
 * one fails loudly on its own.
 */

import { describe, expect, it } from 'vitest';
import type {
  AssistantMessage,
  CompactionContext,
  LLMRequest,
  Message,
  ModelInfo,
  ModelRef,
  TokenUsage,
} from '@aragon-agent/core';
import { Compactor, type CompactorDeps } from '../compaction/compactor.js';
import { COMPACTION_LIMITS } from '../compaction/limits.js';
import { formatCompactionStatus } from '../compaction/command.js';
import { offCompactionSnapshot } from '../compaction/wiring.js';
import type { CommandContext } from '../commands/registry.js';
import {
  DEFAULT_COMPACTION_CONFIG,
  DEFAULT_FAST_CONFIG,
  type CliConfig,
  type CompactionConfig,
} from '../config/schema.js';
import type { CompactionEvent, CompactionSnapshot } from '../compaction/types.js';
import type { NoticeLevel } from '../agent/reducer.js';

function modelInfo(contextWindow: number): ModelInfo {
  return {
    id: 'claude-sonnet-4-5',
    name: 'Sonnet',
    provider: 'anthropic',
    contextWindow,
    maxOutputTokens: 8_192,
    supportsThinking: true,
    supportsTools: true,
    supportsImages: true,
    cost: { input: 3, output: 15 },
  };
}

function user(text: string): Message {
  return { role: 'user', content: text, timestamp: 0 };
}

function assistantText(text: string): Message {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}

function call(id: string): Message {
  return {
    role: 'assistant',
    content: [{ type: 'tool_call', toolCallId: id, toolName: 'read_file', args: { path: 'x' } }],
  };
}

function result(id: string, chars: number): Message {
  return { role: 'tool_result', toolCallId: id, content: 'r'.repeat(chars) };
}

/** A conversation with `turns` user turns, each with a fat assistant answer. */
function conversation(turns: number): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < turns; i += 1) {
    out.push(user(`turn ${i}: ${'q'.repeat(2000)}`));
    out.push(assistantText(`answer ${i}: ${'a'.repeat(4000)}`));
  }
  return out;
}

/**
 * ONE user turn, so `planCompaction` finds no cut above the protected prefix and
 * the tail is far too small for relief to fire. This is the shape the reported
 * bug arrives in: a checkpoint that measures over the threshold, looks, and finds
 * nothing worth dropping.
 */
function nothingToDrop(): Message[] {
  return conversation(1);
}

/**
 * A tail that ALONE exceeds a 32 k window, with one user turn - so the only lever
 * left is relief, which changes the history and therefore announces.
 */
function unsplittable(): Message[] {
  return [user('the only turn'), call('a'), result('a', 120_000), call('b'), result('b', 120_000)];
}

interface HarnessOpts {
  compaction?: Partial<CompactionConfig>;
  /** What each `complete()` call does, in order. `null` means "throw". */
  answers?: Array<string | null>;
  contextWindow?: number;
  maxTokens?: number;
}

function harness(opts: HarnessOpts = {}) {
  const info = modelInfo(opts.contextWindow ?? 200_000);
  const config = {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    maxTokens: opts.maxTokens ?? 8192,
    fast: { ...DEFAULT_FAST_CONFIG },
    compaction: { ...DEFAULT_COMPACTION_CONFIG, ...opts.compaction },
  } as unknown as CliConfig;

  const events: CompactionEvent[] = [];
  const notices: Array<{ level: NoticeLevel; text: string }> = [];
  const answers = [...(opts.answers ?? ['## Task\nthe summary'])];

  const deps: CompactorDeps = {
    getConfig: () => config,
    hasKey: () => true,
    getApiKey: () => 'k',
    getModelInfoFor: () => info,
    isPricedModel: () => true,
    getMessages: () => [],
    getSystemPrompt: () => '',
    complete: async (_providerId: string, _request: LLMRequest): Promise<AssistantMessage> => {
      const next = answers.length > 0 ? answers.shift()! : '## Task\nthe summary';
      if (next === null) throw new Error('summarizer exploded');
      return {
        role: 'assistant',
        content: [{ type: 'text', text: next }],
        usage: { inputTokens: 1000, outputTokens: 200 },
      };
    },
    emit: (e) => events.push(e),
    notify: (level, text) => notices.push({ level, text }),
  };

  const starts = (): Array<Extract<CompactionEvent, { type: 'compaction_start' }>> =>
    events.filter((e): e is Extract<CompactionEvent, { type: 'compaction_start' }> => {
      return e.type === 'compaction_start';
    });
  const ends = (): Array<Extract<CompactionEvent, { type: 'compaction_end' }>> =>
    events.filter((e): e is Extract<CompactionEvent, { type: 'compaction_end' }> => {
      return e.type === 'compaction_end';
    });

  return { compactor: new Compactor(deps), config, events, notices, starts, ends };
}

function ctx(messages: Message[], over: Partial<CompactionContext> = {}): CompactionContext {
  return {
    messageCount: messages.length,
    turnIndex: 1,
    trigger: 'pressure',
    messages,
    systemPrompt: 'sys',
    model: { providerId: 'anthropic', modelId: 'claude-sonnet-4-5' } as ModelRef,
    signal: new AbortController().signal,
    ...over,
  };
}

/** A usage that puts the session over the default 0.9 threshold of a 200k window. */
const OVER_THRESHOLD: TokenUsage = { inputTokens: 190_000, outputTokens: 0 };

describe('AC-Q1 / AC-Q2: a pressure decline says nothing at all', () => {
  it('AC-Q1: nothing_to_drop emits no start and no end, and still returns the outcome', async () => {
    const { compactor, starts, ends } = harness();
    const outcome = await compactor.compact(ctx(nothingToDrop()));

    // THE CARD THE USER REPORTED. Zero events means zero reducer dispatches,
    // which means no `Entry` and nothing to un-print - a `live: true` compaction
    // entry is never promoted into `<Static>`, so nothing reached scrollback.
    expect(starts()).toHaveLength(0);
    expect(ends()).toHaveLength(0);
    // The CONTRACT is unchanged: the engine still gets its verdict.
    expect(outcome.action).toBe('keep');
    if (outcome.action === 'keep') expect(outcome.reason).toBe('nothing_to_drop');
  });

  it('AC-Q2: a history with no user message declines as nothing_to_drop, not no_anchor', async () => {
    // THE `reason` ASSERTION IS THE LOAD-BEARING HALF (P0-1 / C-1). `no_anchor` is
    // structurally unreachable: `buildAnchor` is called only after
    // `plan !== null`, and `planCompaction` returns a plan only when some cut
    // leaves `countTurns >= keep` behind it - `countTurns` counts `user`-role
    // messages and `keep` is at least 1, so a plan PROVES a `user` message exists.
    // If that relationship ever changes this assertion fails, which is the moment
    // someone must re-read the design: a newly-live PRE-COMMIT decline is silent
    // by default and must then be shown to charge guard 4, or it can repeat
    // forever with nothing on any surface.
    const { compactor, starts, ends } = harness();
    const outcome = await compactor.compact(
      ctx([assistantText('a'.repeat(4000)), assistantText('b'.repeat(4000))]),
    );

    expect(starts()).toHaveLength(0);
    expect(ends()).toHaveLength(0);
    expect(outcome.action).toBe('keep');
    if (outcome.action === 'keep') expect(outcome.reason).toBe('nothing_to_drop');
  });
});

describe('AC-Q3 / AC-Q4: a compaction that commits announces, and the numbers stay contiguous', () => {
  it('AC-Q3: a compactable pressure history emits exactly one start and one end', async () => {
    const { compactor, starts, ends } = harness();
    await compactor.compact(ctx(conversation(10)));

    expect(starts()).toHaveLength(1);
    expect(ends()).toHaveLength(1);
    expect(starts()[0]!.index).toBe(1);
    expect(starts()[0]!.trigger).toBe('pressure');
  });

  it('AC-Q4: a decline does not burn a card number', async () => {
    // NO GUARD SETUP IS NEEDED. `compact()` CHARGES guards 1 and 2 but never
    // CONSULTS them - only `shouldCompact()` does - so two direct calls are legal
    // here and are what the loop would produce two turns apart.
    const { compactor, starts } = harness();
    await compactor.compact(ctx(nothingToDrop()));
    await compactor.compact(ctx(conversation(10), { turnIndex: 3 }));

    expect(starts()).toHaveLength(1);
    // `#1`, not `#2`: the user never saw a `#1` to be missing.
    expect(starts()[0]!.index).toBe(1);
  });
});

describe('AC-Q5 / AC-Q6: manual and overflow are byte-identical to the round before', () => {
  it('AC-Q5: a queued /compact that finds nothing to drop still reports', async () => {
    // THE QUEUED FORM HAS NO OTHER SURFACE. `/compact` typed while the agent runs
    // arrives at the loop as an ordinary checkpoint; a silent decline there is a
    // command that did nothing and said nothing.
    const { compactor, starts, ends } = harness();
    compactor.queueManual();
    await compactor.compact(ctx(nothingToDrop()));

    expect(starts()).toHaveLength(1);
    expect(starts()[0]!.trigger).toBe('manual');
    expect(ends()).toHaveLength(1);
    expect(ends()[0]!.record.applied).toBe(false);
    expect(ends()[0]!.record.reason).toBe('nothing_to_drop');
  });

  it('AC-Q6: an overflow attempt that finds nothing to drop still reports', async () => {
    // THE PROVIDER HAS ALREADY REFUSED THE REQUEST. If this compaction cannot
    // recover, the card is the only place that says why the run is about to die.
    const { compactor, starts, ends } = harness();
    await compactor.compact(ctx(nothingToDrop(), { trigger: 'overflow' }));

    expect(starts()).toHaveLength(1);
    expect(starts()[0]!.trigger).toBe('overflow');
    expect(ends()).toHaveLength(1);
    expect(ends()[0]!.record.applied).toBe(false);
    expect(ends()[0]!.record.reason).toBe('nothing_to_drop');
  });
});

describe('AC-Q7 / AC-Q8: every post-commit outcome still speaks', () => {
  it('AC-Q7: relief-only announces at commit point A, naming no model', async () => {
    // RELIEF CHANGES THE HISTORY THE RUN CONTINUES FROM - a bounded, announced
    // data loss - so it is announced even though no model was called. Naming a
    // model on the start event would claim a call that never ran.
    const { compactor, starts, ends } = harness({ contextWindow: 32_000, maxTokens: 4_096 });
    await compactor.compact(ctx(unsplittable()));

    expect(starts()).toHaveLength(1);
    expect(starts()[0]!.model).toBe('');
    expect(ends()).toHaveLength(1);
    expect(ends()[0]!.record.mode).toBe('relieved');
    expect(ends()[0]!.record.applied).toBe(true);
  });

  it('AC-Q8: a post-commit summarize failure announces AND notifies', async () => {
    // THE ONE ROW A REVIEWER MIGHT READ THE DESIGN AS LICENCE TO SUPPRESS. It is
    // decided AFTER the commit point, the call was attempted, and the user asked
    // to be told by setting `onFailure: 'stop'`.
    const { compactor, starts, ends, notices } = harness({
      answers: [null, null],
      compaction: { onFailure: 'stop' },
    });
    await compactor.compact(ctx(conversation(10)));

    expect(starts()).toHaveLength(1);
    expect(ends()).toHaveLength(1);
    expect(ends()[0]!.record.applied).toBe(false);
    expect(ends()[0]!.record.reason).toMatch(/^summarize_failed:/);
    expect(notices.filter((n) => n.level === 'error')).toHaveLength(1);
  });
});

describe('AC-Q9 / AC-Q15: the session counters split cleanly', () => {
  it('AC-Q9: sessionTotals().compactions counts compactions that RAN', async () => {
    const { compactor } = harness();
    await compactor.compact(ctx(nothingToDrop()));
    expect(compactor.sessionTotals().compactions).toBe(0);

    await compactor.compact(ctx(conversation(10), { turnIndex: 3 }));
    expect(compactor.sessionTotals().compactions).toBe(1);
  });

  it('AC-Q15: `declined` counts the checkpoints that chose to do nothing', async () => {
    const { compactor } = harness();
    await compactor.compact(ctx(nothingToDrop()));
    await compactor.compact(ctx(nothingToDrop(), { turnIndex: 3 }));
    await compactor.compact(ctx(conversation(10), { turnIndex: 5 }));

    expect(compactor.sessionTotals()).toMatchObject({ compactions: 1, declined: 2 });

    // NEITHER OF THESE REWRITES HISTORY. `onRunStart()` resets the PER-RUN cap,
    // and `/compact on` overrides a guard - both are session totals, like
    // `compactions`, and both would under-report a session that had declines in
    // an earlier run if they were cleared here.
    compactor.onRunStart();
    expect(compactor.sessionTotals().declined).toBe(2);
    compactor.clearSelfDisable();
    expect(compactor.sessionTotals().declined).toBe(2);
  });
});

describe('AC-Q10: guard 4 still speaks, and it is the surviving signal', () => {
  it('stuckLimit consecutive pressure declines self-disable and warn exactly once', async () => {
    // WITHOUT THIS THE FEATURE REALLY WOULD BE SILENT. After at most two declines
    // this notice is the only thing that says the safety net has given up, and it
    // is far more useful than the two red cards it replaces because it names the
    // cause and the remedies.
    const { compactor, notices, starts, ends } = harness();
    for (let i = 0; i < COMPACTION_LIMITS.stuckLimit; i += 1) {
      await compactor.compact(ctx(nothingToDrop(), { turnIndex: 1 + i * 2 }));
    }

    expect(compactor.isSelfDisabled()).toBe(true);
    const warns = notices.filter((n) => n.level === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0]!.text).toContain('keepRecentTurns');
    // And it said so without ever opening a card.
    expect(starts()).toHaveLength(0);
    expect(ends()).toHaveLength(0);
  });
});

describe('AC-Q11: the guards still count ATTEMPTS, not announcements', () => {
  it('guard 1 charges a declined checkpoint to the cooldown', async () => {
    // ASSERTED THROUGH `shouldCompact`, WHICH IS WHERE GUARD 1 LIVES. `compact()`
    // charges it and never reads it, so a test that called `compact()` twice
    // would be asserting nothing.
    const { compactor } = harness();
    await compactor.compact(ctx(nothingToDrop(), { turnIndex: 5 }));

    const probe = { messageCount: 2, trigger: 'pressure' as const, lastUsage: OVER_THRESHOLD };
    expect(compactor.shouldCompact({ ...probe, turnIndex: 6 })).toBe(false);
    // NON-VACUOUS: the same probe one turn later, once the cooldown is served.
    expect(compactor.shouldCompact({ ...probe, turnIndex: 7 })).toBe(true);
  });

  it('guard 2 charges declined checkpoints to the per-run cap', async () => {
    // GUARD 4 WOULD FIRE FIRST ON THE PRESSURE PATH, so the cap is filled with
    // MANUAL declines - they are charged to guard 2 identically and are exempt
    // from the self-disable, which is what isolates the property under test.
    const { compactor } = harness();
    for (let i = 0; i < COMPACTION_LIMITS.maxPerRun; i += 1) {
      compactor.queueManual();
      await compactor.compact(ctx(nothingToDrop(), { turnIndex: 1 + i * 2 }));
    }

    expect(compactor.isSelfDisabled()).toBe(false);
    const probe = { messageCount: 2, trigger: 'pressure' as const, lastUsage: OVER_THRESHOLD };
    expect(compactor.shouldCompact({ ...probe, turnIndex: 999 })).toBe(false);
  });
});

describe('AC-Q12: the announcement is still emitted synchronously', () => {
  it('compaction_start is present before compact() yields', async () => {
    // R-4's TRIPWIRE. `compact()` runs synchronously into `runCompaction` and on
    // through the plan, the relief attempt and the anchor - none of which awaits -
    // so commit point B is reached before the first yield. An `await` inserted
    // above it would let the engine's verdict land while no card is open, and the
    // wiring would settle nothing: a `live: true` entry forever, pinning
    // `Transcript`'s monotonic boundary and re-rendering the tail every frame.
    const { compactor, starts } = harness();
    const inFlight = compactor.compact(ctx(conversation(10)));

    expect(starts()).toHaveLength(1);
    await inFlight;
  });
});

/**
 * AC-Q16 - the count reaches the SCREEN, not just the snapshot.
 *
 * `formatCompactionStatus` is already exported, so this needs a stub
 * `CommandContext` and no new production seam. `getCompactionRunId` answers
 * `null` and the entry list is empty, so neither the archive listing nor the
 * tail-relief line touches anything outside this file.
 */
function sessionLine(over: Partial<CompactionSnapshot>): string {
  const snapshot: CompactionSnapshot = { ...offCompactionSnapshot(), ...over };
  const ctxStub = {
    args: '',
    state: { entries: [] },
    controller: {
      getCompactionSnapshot: () => snapshot,
      getCompactionConfig: () => ({ ...DEFAULT_COMPACTION_CONFIG }),
      isCompactionRegistered: () => true,
      isCompactionEnabled: () => true,
      getCompactionSummarizerRef: () => null,
      getCompactionRunId: () => null,
      getModelInfoFor: () => modelInfo(200_000),
    },
  } as unknown as CommandContext;

  const line = formatCompactionStatus(ctxStub)
    .split('\n')
    .find((l) => l.includes('This session:'));
  if (line === undefined) throw new Error('no session line');
  return line;
}

describe('AC-Q16: /compact status renders `declined`, and only when it applies', () => {
  const BASE = { compactions: 1, tokensReclaimed: 94_200 } as const;

  it('says so when checkpoints declined', () => {
    expect(sessionLine({ ...BASE, declined: 2 })).toBe(
      '  This session: 1 compaction (2 checkpoints declined), 94.2k tokens reclaimed',
    );
  });

  it('says it in the singular for one', () => {
    expect(sessionLine({ ...BASE, declined: 1 })).toContain('1 checkpoint declined');
  });

  it('shares the existing parenthetical rather than opening a second one', () => {
    expect(sessionLine({ ...BASE, declined: 2, generation: 3 })).toBe(
      '  This session: 1 compaction (generation 3, 2 checkpoints declined), ' +
        '94.2k tokens reclaimed',
    );
  });

  it('THE NEGATIVE HALF: a healthy session reads exactly as it did before', () => {
    // A COUNTER THAT RENDERS `(0 checkpoints declined)` IN EVERY HEALTHY SESSION
    // has replaced one piece of noise with another. Both the zero and the ABSENT
    // field - which is what `offCompactionSnapshot()` produces - must be
    // byte-identical to the round before this feature: no empty parenthetical, no
    // trailing space.
    const expected = '  This session: 1 compaction, 94.2k tokens reclaimed';
    expect(sessionLine({ ...BASE, declined: 0 })).toBe(expected);
    expect(sessionLine({ ...BASE })).toBe(expected);
  });
});
