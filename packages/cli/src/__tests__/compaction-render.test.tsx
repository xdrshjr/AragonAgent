/**
 * The three UI surfaces and the reducer that feeds them
 * (context-auto-compaction §8.1, CLI half — render / reducer).
 *
 * Three of these guard invariants that FAIL QUIETLY: the false `/reset` banner a
 * successful reactive recovery would otherwise leave behind (P1-4), the Ctrl+O
 * hint that would render and do nothing (P1-8), and the double dispatch that
 * would produce two cards and a doubled reclaim total (P1-6).
 */

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { CompactionCard } from '../ui/entries/CompactionCard.js';
import { ActivityLine } from '../ui/ActivityLine.js';
import { StatusBar } from '../ui/StatusBar.js';
import { buildGauge } from '../ui/gauge.js';
import { getTheme } from '../ui/theme.js';
import { pickGlyphs } from '../ui/glyphs.js';
import type { TermCapabilities } from '../ui/capabilities.js';
import {
  CONTEXT_OVERFLOW_NOTICE_PREFIX,
  formatStreamError,
  initialViewState,
  reduceEvent,
  viewReducer,
  type Entry,
  type ViewAction,
  type ViewState,
} from '../agent/reducer.js';
import { computeSettledCount } from '../ui/Transcript.js';
import { entryRevision, estimateEntryRows } from '../ui/layout/virtual-window.js';
import { renderTranscriptText } from '../ui/transcript-text.js';
import { normalizeLoadedEntries } from '../session/persist.js';
import { COMPACTION_LIMITS } from '../compaction/limits.js';
import type { CompactionRecord, CompactionSnapshot } from '../compaction/types.js';

const UNICODE: TermCapabilities = { colorLevel: 3, unicode: true };
const ASCII: TermCapabilities = { colorLevel: 0, unicode: false };
const theme = getTheme('cool', UNICODE);

function record(over: Partial<CompactionRecord> = {}): CompactionRecord {
  return {
    index: 1,
    trigger: 'pressure',
    mode: 'summarized',
    applied: true,
    messagesBefore: 112,
    messagesAfter: 9,
    tokensBefore: 118_400,
    tokensAfter: 23_100,
    summary: '## Task\nAdd auto-compaction\n## Open\n- wire the exec event',
    model: 'claude-haiku-4-5',
    durationMs: 3400,
    ...over,
  };
}

function snapshot(over: Partial<CompactionSnapshot> = {}): CompactionSnapshot {
  return {
    live: true,
    model: 'claude-haiku-4-5',
    compactions: 1,
    tokensReclaimed: 95_300,
    usage: { inputTokens: 1000, outputTokens: 200 },
    pricingUnknown: false,
    inFlight: false,
    selfDisabled: false,
    generation: 1,
    pressure: {
      occupied: 23_100,
      contextWindow: 200_000,
      ratio: 0.1155,
      headroom: 176_900,
      deltaTokens: 0,
      source: 'estimate',
      windowKnown: true,
    },
    ...over,
  };
}

function run(actions: ViewAction[], seed = initialViewState()): ViewState {
  return actions.reduce(viewReducer, seed);
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

describe('CompactionCard (§6.3)', () => {
  it('renders the before/after counts, the model and the duration', () => {
    const { lastFrame } = render(
      <CompactionCard {...record()} live={false} theme={theme} caps={UNICODE} />,
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('context compacted');
    expect(out).toContain('112');
    expect(out).toContain('9 messages');
    expect(out).toContain('claude-haiku-4-5');
    expect(out).toContain('3.4s');
  });

  it('says so on a TRUNCATED compaction (§6.4)', () => {
    const { lastFrame } = render(
      <CompactionCard
        {...record({ mode: 'truncated', summary: undefined })}
        live={false}
        theme={theme}
        caps={UNICODE}
      />,
    );
    expect(lastFrame()).toContain('WITHOUT a summary');
  });

  it('says WHY on a failed one — "it did nothing" is never the outcome (R-8)', () => {
    const { lastFrame } = render(
      <CompactionCard
        {...record({ applied: false, mode: 'none', reason: 'invalid_history: orphan_tool_result' })}
        live={false}
        theme={theme}
        caps={UNICODE}
      />,
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('context not compacted');
    expect(out).toContain('orphan_tool_result');
  });

  it('clamps the collapsed body and offers Ctrl+O when there is more', () => {
    const long = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    const { lastFrame } = render(
      <CompactionCard {...record({ summary: long })} live={false} theme={theme} caps={UNICODE} />,
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('line 0');
    expect(out).toContain(`line ${COMPACTION_LIMITS.cardTextRows - 1}`);
    expect(out).not.toContain(`line ${COMPACTION_LIMITS.cardTextRows}`);
    expect(out).toContain('ctrl+o to expand');
  });

  it('reveals the rest when expanded', () => {
    const long = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    const { lastFrame } = render(
      <CompactionCard
        {...record({ summary: long })}
        live={false}
        expanded
        theme={theme}
        caps={UNICODE}
      />,
    );
    expect(lastFrame()).toContain('line 19');
  });

  // -------------------------------------------------------------------------
  // W5 / W2 — the long moment, and the relief disclosure
  // (context-auto-compaction-hardening §8.1, tests 29-31)
  // -------------------------------------------------------------------------

  it('test 29: a live card with elapsedMs shows the duration and the escape', () => {
    // BETWEEN SECOND 0 AND SECOND 45 THE CARD CARRIED NO CHANGING INFORMATION,
    // and `AgentController.abort()` has always cancelled an in-flight
    // summarization without any surface saying so.
    const { lastFrame } = render(
      <CompactionCard {...record()} live elapsedMs={12_000} theme={theme} caps={UNICODE} />,
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('compacting context #1');
    expect(out).toContain('12.0s');
    expect(out).toContain('esc to cancel');
  });

  it('test 30: model === "" omits BOTH the separator and the cancel hint', () => {
    // CR-7's rule, extended: with no summarizer resolved there is no call to
    // cancel, and a headline ending in a dangling separator reads as a rendering
    // fault rather than as the missing model it is.
    const { lastFrame } = render(
      <CompactionCard {...record({ model: '' })} live elapsedMs={3_000} theme={theme} caps={UNICODE} />,
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('compacting context #1');
    expect(out).not.toContain('esc to cancel');
    expect(out).toContain('3.0s');
  });

  it('test 31: a settled card with tailRelief renders the third line', () => {
    const { lastFrame } = render(
      <CompactionCard
        {...record({ tailRelief: { messages: 3, charsRemoved: 214_003 } })}
        live={false}
        theme={theme}
        caps={UNICODE}
      />,
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('summarized 103 messages');
    expect(out).toContain('clipped 3 tool results in the retained turns');
    // WRAPPED BY INK at the test terminal's width, so the tail of the sentence is
    // asserted on the un-wrapped text rather than on the frame.
    expect(out.replace(/\s+/g, ' ')).toContain('the recent turns alone exceeded the window');
  });

  it('and a relief-ONLY card says it once, not twice', () => {
    const { lastFrame } = render(
      <CompactionCard
        {...record({
          mode: 'relieved',
          model: '',
          summary: undefined,
          messagesAfter: 112,
          tailRelief: { messages: 3, charsRemoved: 214_003 },
        })}
        live={false}
        theme={theme}
        caps={UNICODE}
      />,
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('nothing could be dropped');
    expect(out.replace(/\s+/g, ' ')).not.toContain('the recent turns alone exceeded the window');
    expect(out).not.toContain('summarized');
  });

  it('renders on an ASCII terminal without a single non-ASCII byte (§4.1 tier A)', () => {
    const { lastFrame } = render(
      <CompactionCard {...record()} live={false} theme={theme} caps={ASCII} />,
    );
    const out = lastFrame() ?? '';
    // eslint-disable-next-line no-control-regex
    expect(out.replace(/\[[0-9;]*m/g, '')).toMatch(/^[\x00-\x7F]*$/);
    // And the arrow degraded through `glyphs.arrowRight`, not a literal.
    expect(out).toContain(pickGlyphs(ASCII).arrowRight);
  });
});

// ---------------------------------------------------------------------------
// The activity row
// ---------------------------------------------------------------------------

describe('ActivityLine precedence (§6.1)', () => {
  const base = { startedAt: 0, elapsedMs: 1000, theme, caps: UNICODE };

  it('says "Compacting context" even when a tool is running', () => {
    const { lastFrame } = render(
      <ActivityLine {...base} reducedMotion runningTool="bash" compacting />,
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('Compacting context');
    expect(out).not.toContain('Running bash');
  });

  it('falls back to the tool name, then to the phrase', () => {
    const withTool = render(<ActivityLine {...base} reducedMotion runningTool="bash" />);
    expect(withTool.lastFrame()).toContain('Running bash');

    const bare = render(<ActivityLine {...base} reducedMotion />);
    const out = bare.lastFrame() ?? '';
    expect(out).not.toContain('Compacting context');
    expect(out).not.toContain('Running');
  });
});

// ---------------------------------------------------------------------------
// The gauge and the chip
// ---------------------------------------------------------------------------

describe('buildGauge marks (§6.2)', () => {
  it('with NO marks is byte-identical to the pre-feature build', () => {
    for (const pct of [0, 59, 60, 85, 86, 100]) {
      const before = buildGauge(pct, 12, theme, UNICODE);
      // The defaults, spelled out, are what the old hardcoded pair was.
      const after = buildGauge(pct, 12, theme, UNICODE, { warn: 60, high: 85 });
      expect(after).toEqual(before);
    }
  });

  it('preserves the `> high` / `>= warn` operators with custom marks', () => {
    // EXCLUSIVE at the top, INCLUSIVE at the bottom. Changing either would move
    // the default 85 / 60 boundary and break the byte-identity above.
    const marks = { warn: 75, high: 90 };
    expect(buildGauge(90, 12, theme, UNICODE, marks).fillColor).toBe(theme.gauge.mid);
    expect(buildGauge(91, 12, theme, UNICODE, marks).fillColor).toBe(theme.gauge.high);
    expect(buildGauge(75, 12, theme, UNICODE, marks).fillColor).toBe(theme.gauge.mid);
    expect(buildGauge(74, 12, theme, UNICODE, marks).fillColor).toBe(theme.gauge.low);
  });
});

describe('the status chip (§6.2)', () => {
  const base = {
    model: 'claude-sonnet-4-5',
    provider: 'anthropic',
    usageTotal: { inputTokens: 100, outputTokens: 50, costUsd: 0.01 },
    contextTokens: 50_000,
    contextWindow: 200_000,
    contextWindowKnown: true,
    status: 'idle' as const,
    elapsedMs: 0,
    thinkingLevel: 'off',
    tokPerSec: 0,
    theme,
    caps: UNICODE,
  };

  it('renders `compacting` while a summarization is open', () => {
    const { lastFrame } = render(
      <StatusBar {...base} compactionActive={{ inFlight: true }} />,
    );
    expect(lastFrame()).toContain('compacting');
  });

  it('is absent entirely when compaction is off for the session', () => {
    const { lastFrame } = render(<StatusBar {...base} />);
    expect(lastFrame()).not.toContain('compact');
  });

  it('widens the `~` when the occupancy is DERIVED', () => {
    const measured = render(<StatusBar {...base} />);
    expect(measured.lastFrame()).not.toContain('~');

    const derived = render(<StatusBar {...base} contextEstimated />);
    expect(derived.lastFrame()).toContain('~');
  });
});

// ---------------------------------------------------------------------------
// The reducer
// ---------------------------------------------------------------------------

describe('the reducer (§5.5)', () => {
  it('opens a live card and settles it once', () => {
    const state = run([
      { type: 'compactionStart', index: 1, trigger: 'pressure', model: 'haiku' },
      { type: 'compactionEnd', record: record() },
    ]);
    const cards = state.entries.filter((e) => e.kind === 'compaction');
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ live: false, applied: true, mode: 'summarized' });
    expect(state.compactionEntryId).toBeUndefined();
  });

  it('appends a settled card when no live one was opened (the idle path)', () => {
    const state = run([{ type: 'compactionEnd', record: record() }]);
    expect(state.entries.filter((e) => e.kind === 'compaction')).toHaveLength(1);
  });

  it('P1-6 / AC-22 — one CLI event produces exactly ONE card, with the core events also delivered', () => {
    // Driving `reduceEvent` with core's two compaction events must contribute
    // NOTHING: its `default: return []` is the whole expression of "one
    // authority", and a case there would double every card and every total.
    expect(
      reduceEvent({
        type: 'compaction_start',
        trigger: 'pressure',
        messageCount: 10,
      }),
    ).toEqual([]);
    expect(
      reduceEvent({
        type: 'compaction_end',
        applied: true,
        mode: 'summarized',
        messagesBefore: 112,
        messagesAfter: 9,
        droppedMessages: 103,
        estimatedTokensBefore: 118_400,
        estimatedTokensAfter: 23_100,
        durationMs: 3400,
      }),
    ).toEqual([]);

    const state = run([
      { type: 'compactionStart', index: 1, trigger: 'pressure', model: 'haiku' },
      { type: 'compactionEnd', record: record() },
    ]);
    expect(state.entries.filter((e) => e.kind === 'compaction')).toHaveLength(1);
  });

  it('AC-5 — the gauge falls immediately and is marked as derived', () => {
    const state = run([
      { type: 'turnEnd', usage: { inputTokens: 190_000, outputTokens: 0 }, costDelta: 0 },
      { type: 'contextTokensEstimated', tokens: 23_100 },
    ]);
    expect(state.contextTokens).toBe(23_100);
    expect(state.contextTokensEstimated).toBe(true);
  });

  it('a MEASUREMENT supersedes the derivation at the next turnEnd', () => {
    const state = run([
      { type: 'contextTokensEstimated', tokens: 23_100 },
      { type: 'turnEnd', usage: { inputTokens: 30_000, outputTokens: 500 }, costDelta: 0 },
    ]);
    expect(state.contextTokens).toBe(30_500);
    expect(state.contextTokensEstimated).toBe(false);
  });

  it('turnEnd counts the CACHE fields, sharing one function with the trigger (AC-3)', () => {
    const state = run([
      {
        type: 'turnEnd',
        usage: {
          inputTokens: 1000,
          outputTokens: 200,
          cacheReadTokens: 5000,
          cacheWriteTokens: 300,
        },
        costDelta: 0,
      },
    ]);
    // The old formula gave 1200 and silently under-reported behind a gateway.
    expect(state.contextTokens).toBe(6500);
  });

  it('compactionUsage touches usageTotal and NOTHING else', () => {
    const seeded = run([
      { type: 'turnEnd', usage: { inputTokens: 40_000, outputTokens: 0 }, costDelta: 0 },
    ]);
    const state = viewReducer(seeded, {
      type: 'compactionUsage',
      usage: { inputTokens: 1000, outputTokens: 200 },
      costDelta: 0.05,
    });
    expect(state.usageTotal.inputTokens).toBe(41_000);
    expect(state.usageTotal.costUsd).toBeCloseTo(0.05);
    // NOT `contextTokens`: that gauge is the LEAD's occupancy, and a
    // summarization is a separate conversation with a different model.
    expect(state.contextTokens).toBe(40_000);
  });

  it('clearTranscript and resetConversation both drop the live card id', () => {
    const opened = run([
      { type: 'compactionStart', index: 1, trigger: 'pressure', model: 'haiku' },
    ]);
    expect(opened.compactionEntryId).toBeDefined();
    expect(viewReducer(opened, { type: 'clearTranscript' }).compactionEntryId).toBeUndefined();
    expect(viewReducer(opened, { type: 'resetConversation' }).compactionEntryId).toBeUndefined();
    // `/reset` zeroes the gauge, so the tilde has to go with it.
    expect(viewReducer(opened, { type: 'resetConversation' }).contextTokensEstimated).toBe(false);
  });
});

describe('P1-4 — the false /reset banner', () => {
  const overflowNotice: ViewAction = {
    type: 'notice',
    level: 'error',
    text: formatStreamError(
      Object.assign(new Error('too long'), { errorType: 'context_overflow' }) as Error,
    ),
  };

  it('rewrites a TRAILING context_overflow error into an informational line', () => {
    const state = run([
      overflowNotice,
      { type: 'compactionStart', index: 1, trigger: 'overflow', model: 'haiku' },
    ]);
    const notice = state.entries.find((e) => e.kind === 'notice')!;
    expect(notice).toMatchObject({ level: 'info' });
    expect((notice as Extract<Entry, { kind: 'notice' }>).text).toBe(
      'Context window exceeded - compacting and retrying.',
    );
    // AC-11b: no error notice mentioning /reset survives a successful recovery.
    expect(
      state.entries.some(
        (e) => e.kind === 'notice' && e.level === 'error' && e.text.includes('/reset'),
      ),
    ).toBe(false);
  });

  it('leaves an identical notice alone when it is NOT the tail entry', () => {
    // It rewrites in place rather than removing, and matches only the tail, so it
    // can never touch an older, genuine error.
    const state = run([
      overflowNotice,
      { type: 'notice', level: 'info', text: 'something else happened' },
      { type: 'compactionStart', index: 1, trigger: 'overflow', model: 'haiku' },
    ]);
    const first = state.entries.find((e) => e.kind === 'notice')!;
    expect(first).toMatchObject({ level: 'error' });
  });

  it('leaves a PRESSURE start alone', () => {
    const state = run([
      overflowNotice,
      { type: 'compactionStart', index: 1, trigger: 'pressure', model: 'haiku' },
    ]);
    expect(state.entries.find((e) => e.kind === 'notice')).toMatchObject({ level: 'error' });
  });

  it('formatStreamError names /compact alongside /reset', () => {
    const text = formatStreamError(
      Object.assign(new Error('too long'), { errorType: 'context_overflow' }) as Error,
    );
    expect(text).toContain('/compact');
    expect(text).toContain('/reset');
    // And the prefix the rewrite matches on is one shared constant, not two
    // literals that can drift apart.
    expect(text.startsWith(CONTEXT_OVERFLOW_NOTICE_PREFIX)).toBe(true);
  });

  it('seals a live streaming entry defensively (C-8)', () => {
    const streaming = run([
      { type: 'submit', text: 'go' },
      { type: 'runStart' },
      { type: 'turnStart' },
      { type: 'textDelta', delta: 'partial' },
    ]);
    expect(streaming.streamingId).toBeDefined();
    const state = viewReducer(streaming, {
      type: 'compactionStart',
      index: 1,
      trigger: 'overflow',
      model: 'haiku',
    });
    expect(state.streamingId).toBeUndefined();
    const assistant = state.entries.find((e) => e.kind === 'assistant');
    expect(assistant).toMatchObject({ streaming: false });
  });
});

// ---------------------------------------------------------------------------
// The plumbing every new Entry kind needs (C-8 / C-9 / C-15)
// ---------------------------------------------------------------------------

function compactionEntry(over: Partial<Extract<Entry, { kind: 'compaction' }>> = {}): Entry {
  return {
    id: 'c1',
    kind: 'compaction',
    index: 1,
    trigger: 'pressure',
    mode: 'summarized',
    applied: true,
    messagesBefore: 112,
    messagesAfter: 9,
    tokensBefore: 118_400,
    tokensAfter: 23_100,
    summary: '## Task\nship it',
    model: 'haiku',
    durationMs: 3400,
    live: false,
    ...over,
  };
}

describe('the new kind is plumbed everywhere it has to be', () => {
  it('C-8 — a LIVE card blocks the settled boundary', () => {
    const live = Array.from({ length: 10 }, (_, i) =>
      i === 0 ? compactionEntry({ id: 'c1', live: true }) : { id: `n${i}`, kind: 'notice' as const, level: 'info' as const, text: 'x' },
    );
    expect(computeSettledCount(live, {})).toBe(0);
    const settled = [...live];
    settled[0] = compactionEntry({ id: 'c1', live: false });
    expect(computeSettledCount(settled, {})).toBeGreaterThan(0);
  });

  it('C-8 — persist normalizes a live card away on load, and says it did not apply', () => {
    const [loaded] = normalizeLoadedEntries([compactionEntry({ live: true, applied: true })]);
    expect(loaded).toMatchObject({
      live: false,
      applied: false,
      mode: 'none',
      reason: 'interrupted (session resumed)',
    });
  });

  it('C-9 — BOTH virtual-window switches learned about it', () => {
    // `entryRevision` must change whenever the rendered output changes, and
    // `estimateEntryRows` must not disagree with what was drawn. Adding the case
    // to only one of the two yields drift rather than an error.
    expect(entryRevision(compactionEntry())).not.toBe('x');
    expect(entryRevision(compactionEntry({ live: true }))).not.toBe(entryRevision(compactionEntry()));
    expect(entryRevision(compactionEntry({ summary: 'a' }))).not.toBe(
      entryRevision(compactionEntry({ summary: 'ab' })),
    );
    expect(entryRevision(compactionEntry({ mode: 'truncated' }))).not.toBe(
      entryRevision(compactionEntry({ mode: 'summarized' })),
    );
    expect(estimateEntryRows(compactionEntry(), 80, 'comfortable', false)).toBeGreaterThan(1);
    // Expanding reveals more rows, so the estimate must grow with it.
    const long = compactionEntry({ summary: Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n') });
    expect(estimateEntryRows(long, 80, 'comfortable', true)).toBeGreaterThan(
      estimateEntryRows(long, 80, 'comfortable', false),
    );
  });

  it('the plain-text exporter accounts for it', () => {
    const text = renderTranscriptText([compactionEntry()], {
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      usageTotal: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
      glyphs: pickGlyphs(ASCII),
      elapsedMs: 0,
      droppedEntries: 0,
    });
    expect(text).toContain('context compacted');
    expect(text).toContain('112');
    expect(text).toContain('ship it');
  });

  it('C-15 / AC-21 — the Ctrl+O predicate selects a trailing compaction card', () => {
    // The predicate `App` uses, asserted here so the card's own
    // `ctrl+o to expand` hint cannot start lying without a red test.
    const entries: Entry[] = [
      { id: 't1', kind: 'tool', toolCallId: 'x', name: 'bash', label: 'Bash', argsRaw: '{}', status: 'done' },
      compactionEntry({ id: 'c9' }),
    ];
    const picked = [...entries]
      .reverse()
      .find((e) => e.kind === 'tool' || e.kind === 'team' || e.kind === 'compaction');
    expect(picked?.id).toBe('c9');
  });

  it('/expand stays TOOL-ONLY, deliberately (§6.3)', () => {
    // The asymmetry is a decision: `/expand 3` takes an N-from-last index over
    // TOOL cards, and widening it would change what that means for every user.
    const entries: Entry[] = [
      { id: 't1', kind: 'tool', toolCallId: 'x', name: 'bash', label: 'Bash', argsRaw: '{}', status: 'done' },
      compactionEntry({ id: 'c9' }),
    ];
    expect(entries.filter((e) => e.kind === 'tool').map((e) => e.id)).toEqual(['t1']);
  });
});

describe('compactionSnapshot drives the chip', () => {
  it('is stored verbatim', () => {
    const snap = snapshot();
    const state = viewReducer(initialViewState(), { type: 'compactionSnapshot', snapshot: snap });
    expect(state.compaction).toBe(snap);
  });

  it('starts null, which is what leaves an ordinary bar unchanged', () => {
    expect(initialViewState().compaction).toBeNull();
    expect(initialViewState().contextTokensEstimated).toBe(false);
  });
});
