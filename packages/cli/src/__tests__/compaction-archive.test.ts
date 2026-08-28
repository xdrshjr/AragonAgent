/**
 * The compaction archive (context-auto-compaction-hardening §8.1, tests 20-24).
 *
 * TEST 20b IS A GREEN-FROM-BIRTH TEST AND THAT IS THE POINT. `CompactionRecord`
 * is dispatched into the reducer and retained in view state for the card's
 * lifetime, so a later refactor that "simplifies" the side channel by hanging
 * the dropped `Message[]` off the record would park a megabyte of history in
 * React - an archive feature that creates the leak it audits. Nothing else in
 * the suite would notice.
 *
 * TEST 21 IS THE `runId` INVARIANT. `<home>/compaction/` is shared by every
 * `aragon` on the machine, and a global count-based prune deletes a LIVE
 * session's archives out from under it.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent, Message, ModelInfo, ModelRef } from '@aragon-agent/core';
import { CompactionWiring } from '../compaction/wiring.js';
import type { CompactionEvent } from '../compaction/types.js';
import {
  DEFAULT_COMPACTION_CONFIG,
  DEFAULT_FAST_CONFIG,
  type CliConfig,
} from '../config/schema.js';
import {
  ARCHIVE_FORMAT_VERSION,
  archiveFileName,
  findArchive,
  listArchives,
  mintRunId,
  pruneArchives,
  serializeArchive,
  writeArchive,
  type CompactionArchive,
} from '../compaction/archive.js';
import { COMPACTION_LIMITS } from '../compaction/limits.js';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aragon-archive-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    try {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    } catch {
      // Windows may still hold a handle; the OS reclaims the temp dir anyway.
    }
  }
});

function dropped(n: number, chars = 100): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < n; i += 1) out.push({ role: 'user', content: `m${i}: ${'x'.repeat(chars)}` });
  return out;
}

function write(dir: string, runId: string, index: number, now: number, count = 3): string | null {
  return writeArchive({
    runId,
    index,
    trigger: 'pressure',
    mode: 'summarized',
    model: 'claude-haiku-4-5',
    generation: 1,
    tokensBefore: 118_400,
    tokensAfter: 23_100,
    messagesBefore: 112,
    messagesAfter: 9,
    summary: 'the summary body',
    dropped: dropped(count),
    dir,
    now,
  });
}

describe('the archive document (§3.5.2)', () => {
  it('writes the verbatim dropped messages under `dropped`, counted by `droppedCount`', () => {
    const dir = tempDir();
    const path = write(dir, 'run1', 1, Date.now(), 5)!;
    const doc = JSON.parse(readFileSync(path, 'utf8')) as CompactionArchive;

    expect(doc.version).toBe(ARCHIVE_FORMAT_VERSION);
    expect(doc.runId).toBe('run1');
    expect(doc.droppedCount).toBe(5);
    expect(doc.dropped).toHaveLength(5);
    expect(doc.dropped[0]).toEqual({ role: 'user', content: `m0: ${'x'.repeat(100)}` });
    // NEITHER FIELD IS CALLED `droppedMessages` (RV-3): that name already means a
    // COUNT in three typed places, and this is the document someone reads while
    // diagnosing a bad summary.
    expect('droppedMessages' in doc).toBe(false);
  });

  it('carries the runId INSIDE the document as well as in the name', () => {
    const dir = tempDir();
    const path = write(dir, 'run1', 2, Date.now())!;
    const doc = JSON.parse(readFileSync(path, 'utf8')) as CompactionArchive;

    expect(path).toContain('-run1-2.json');
    // A file renamed or copied by hand is still self-describing, so the reader
    // never has to parse a name for meaning it cannot verify.
    expect(doc.runId).toBe('run1');
  });

  it('test 22: clips oldest bodies over the byte cap and keeps the metadata', () => {
    const doc: CompactionArchive = {
      version: ARCHIVE_FORMAT_VERSION,
      blockVersion: 'v1-2026-08',
      createdAt: 1,
      runId: 'run1',
      index: 1,
      trigger: 'pressure',
      mode: 'summarized',
      model: 'claude-haiku-4-5',
      generation: 1,
      tokensBefore: 1,
      tokensAfter: 1,
      messagesBefore: 40,
      messagesAfter: 2,
      droppedCount: 40,
      summary: 'the summary survives',
      clipped: false,
      dropped: dropped(40, 5_000),
    };

    const text = serializeArchive(doc, 20_000);
    const parsed = JSON.parse(text) as CompactionArchive;

    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(20_000);
    expect(parsed.clipped).toBe(true);
    expect(parsed.summary).toBe('the summary survives');
    expect(parsed.droppedCount).toBe(40);
    expect(parsed.dropped.length).toBeLessThan(40);
    // CLIPPED FROM THE OLDEST END: what survives is the newest.
    expect((parsed.dropped[parsed.dropped.length - 1]!.content as string).startsWith('m39')).toBe(
      true,
    );
  });

  it('test 23: an unwritable directory returns null rather than throwing', () => {
    // The failure posture, ASSERTED RATHER THAN ASSUMED. A filesystem is not
    // allowed to affect whether a session survives its context window.
    const dir = tempDir();
    const path = join(dir, 'a-file');
    writeFileSync(path, 'not a directory', 'utf8');

    expect(write(join(path, 'nested'), 'run1', 1, Date.now())).toBeNull();
  });
});

describe('retention is two-tier (§3.5.2 / RV-6 / test 21)', () => {
  it('prunes to archiveMaxFiles WITHIN one runId and leaves another runs alone', () => {
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    const now = Date.now();

    // Another run's archives, more numerous than the whole cap.
    for (let i = 1; i <= COMPACTION_LIMITS.archiveMaxFiles + 5; i += 1) {
      const name = archiveFileName('other', i, new Date(now - 1_000));
      writeFileSync(join(dir, name), '{}', 'utf8');
    }
    // This run's, one over the cap.
    for (let i = 1; i <= COMPACTION_LIMITS.archiveMaxFiles + 1; i += 1) {
      const name = archiveFileName('mine', i, new Date(now - (COMPACTION_LIMITS.archiveMaxFiles + 1 - i)));
      const full = join(dir, name);
      writeFileSync(full, '{}', 'utf8');
      const at = (now - (COMPACTION_LIMITS.archiveMaxFiles + 1 - i) * 1_000) / 1_000;
      utimesSync(full, at, at);
    }

    pruneArchives('mine', dir, now);
    const names = readdirSync(dir);

    expect(names.filter((n) => n.includes('-mine-')).length).toBe(COMPACTION_LIMITS.archiveMaxFiles);
    // A LIVE NEIGHBOUR IS UNTOUCHED, which is the whole reason the count is
    // per-run rather than per-directory.
    expect(names.filter((n) => n.includes('-other-')).length).toBe(
      COMPACTION_LIMITS.archiveMaxFiles + 5,
    );
  });

  // A RUN ID IS A PID IN BASE 36 PLUS FOUR BASE-36 CLOCK CHARACTERS, so a
  // six-character all-digit one is a legal `hhmmss` segment - and every other
  // run's file written at that second then contains `-<runId>-`. A substring
  // test therefore hands one run another run's archives, in the two places RV-6
  // exists to protect. Attribution is an exact parse of the name instead.
  it('does not claim a neighbours file whose clock segment equals this runId', () => {
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    const at = new Date(2026, 7, 17, 12, 15, 30);
    const runId = '121530';

    for (let i = 1; i <= COMPACTION_LIMITS.archiveMaxFiles + 2; i += 1) {
      writeFileSync(join(dir, archiveFileName('neighbour', i, at)), '{}', 'utf8');
    }

    pruneArchives(runId, dir, at.getTime());

    expect(readdirSync(dir).length).toBe(COMPACTION_LIMITS.archiveMaxFiles + 2);
    const listing = listArchives(runId, dir);
    expect(listing.entries).toHaveLength(0);
    expect(listing.otherRuns).toBe(COMPACTION_LIMITS.archiveMaxFiles + 2);
  });

  it('sweeps files older than archiveMaxAgeMs regardless of runId', () => {
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    const now = Date.now();

    const stale = join(dir, archiveFileName('ancient', 1, new Date(now)));
    writeFileSync(stale, '{}', 'utf8');
    const staleSec = (now - COMPACTION_LIMITS.archiveMaxAgeMs - 60_000) / 1_000;
    utimesSync(stale, staleSec, staleSec);

    const fresh = join(dir, archiveFileName('other', 1, new Date(now)));
    writeFileSync(fresh, '{}', 'utf8');

    pruneArchives('mine', dir, now);
    const names = readdirSync(dir);

    expect(names.some((n) => n.includes('-ancient-'))).toBe(false);
    expect(names.some((n) => n.includes('-other-'))).toBe(true);
  });
});

describe('reading it back (§3.5.4 / test 21a)', () => {
  it('lists only this runs archives and COUNTS the others in one number', () => {
    const dir = tempDir();
    const now = Date.now();
    write(dir, 'mine', 1, now - 2_000);
    write(dir, 'mine', 2, now - 1_000);
    write(dir, 'other', 1, now);

    const listing = listArchives('mine', dir);

    expect(listing.entries.map((e) => e.index)).toEqual([2, 1]);
    expect(listing.otherRuns).toBe(1);
    // NEVER THE MESSAGE BODIES (DH-9 / AC-H15): a single archive can be megabytes
    // and the transcript is not a pager.
    expect(listing.entries[0]).not.toHaveProperty('dropped');
  });

  it('resolves `show <n>` against this runs index and refuses another runs', () => {
    const dir = tempDir();
    const now = Date.now();
    write(dir, 'mine', 1, now);
    write(dir, 'other', 7, now);

    expect(findArchive('mine', 1, dir)?.index).toBe(1);
    expect(findArchive('mine', 7, dir)).toBeNull();
  });

  it('skips a half-written or future-format file rather than throwing', () => {
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, archiveFileName('mine', 1, new Date())), '{"version":', 'utf8');
    writeFileSync(join(dir, archiveFileName('mine', 2, new Date())), '{"version":99}', 'utf8');

    expect(listArchives('mine', dir).entries).toHaveLength(0);
  });
});

describe('mintRunId', () => {
  it('is short, filename-safe, and differs between processes', () => {
    const a = mintRunId(1234, 1_700_000_000_000);
    const b = mintRunId(5678, 1_700_000_000_000);

    expect(a).toMatch(/^[a-z0-9]+$/);
    expect(a.length).toBeLessThan(16);
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// The hand-off from the wiring (tests 20 / 20a / 20b / 23a / 24)
// ---------------------------------------------------------------------------

const MODEL: ModelInfo = {
  id: 'claude-sonnet-4-5',
  name: 'Sonnet',
  provider: 'anthropic',
  contextWindow: 200_000,
  maxOutputTokens: 64_000,
  supportsThinking: true,
  supportsTools: true,
  supportsImages: true,
  cost: { input: 3, output: 15 },
};

const REF: ModelRef = { providerId: 'anthropic', modelId: 'claude-sonnet-4-5' };

/**
 * NO NETWORK, AND NOT BY MOCKING ONE. `hasKey` answers `false`, so
 * `resolveSummarizer()` returns `null` and the ladder ends at
 * `no_summarizer_model` WITHOUT reaching `getRegistry()`. The result is a
 * `truncated` splice, which is a complete compaction cycle for everything here.
 */
function wiringHarness(
  messages: Message[],
  over: Partial<CliConfig['compaction']> = {},
  model: ModelInfo = MODEL,
) {
  const dir = tempDir();
  const config = {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    maxTokens: 8_192,
    fast: { ...DEFAULT_FAST_CONFIG },
    compaction: { ...DEFAULT_COMPACTION_CONFIG, ...over },
  } as unknown as CliConfig;

  const events: CompactionEvent[] = [];
  const wiring = new CompactionWiring({
    getConfig: () => config,
    hasKey: () => false,
    getApiKey: () => undefined,
    getModelInfoFor: () => model,
    isPricedModel: () => true,
    getMessages: () => messages,
    getSystemPrompt: () => 'sys',
    notify: () => {},
    archiveDir: dir,
  });
  wiring.subscribe((e) => events.push(e));

  let agent: ((event: AgentEvent) => void) | null = null;
  wiring.attach((listener) => {
    agent = listener;
    return (): void => {
      agent = null;
    };
  });

  const ends = (): Array<Extract<CompactionEvent, { type: 'compaction_end' }>> =>
    events.filter((e): e is Extract<CompactionEvent, { type: 'compaction_end' }> => {
      return e.type === 'compaction_end';
    });

  return { wiring, dir, ends, emitAgent: (e: AgentEvent): void => agent?.(e) };
}

function conversation(turns: number): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < turns; i += 1) {
    out.push({ role: 'user', content: `turn ${i}: ${'q'.repeat(2_000)}`, timestamp: 0 });
    out.push({ role: 'assistant', content: [{ type: 'text', text: `answer ${i}: ${'a'.repeat(4_000)}` }] });
  }
  return out;
}

function names(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

describe('the wiring hand-off (§3.5.3 / W4)', () => {
  it('test 20 / 20a: writes the verbatim dropped messages on applied: true', async () => {
    const history = conversation(8);
    const h = wiringHarness(history);

    await h.wiring.compactNow({
      messages: history,
      systemPrompt: 'sys',
      model: REF,
      signal: new AbortController().signal,
    });

    const files = names(h.dir);
    expect(files).toHaveLength(1);
    const doc = JSON.parse(readFileSync(join(h.dir, files[0]!), 'utf8')) as CompactionArchive;
    expect(doc.droppedCount).toBe(doc.dropped.length);
    expect(doc.droppedCount).toBeGreaterThan(0);
    // VERBATIM, AND FROM `protectedPrefix`. On a FIRST compaction there is no
    // tagged anchor and no prior block yet, so the protected prefix is 0 and the
    // dropped head starts at the very first message.
    expect(doc.dropped[0]).toEqual(history[0]);
    expect(h.ends()[0]!.record.archivePath).toBe(join(h.dir, files[0]!));
  });

  it('test 20: writes nothing when the engine REFUSES the splice', async () => {
    const history = conversation(8);
    const h = wiringHarness(history);

    void h.wiring.manager().compact({
      messageCount: history.length,
      turnIndex: 1,
      trigger: 'pressure',
      messages: history,
      systemPrompt: 'sys',
      model: REF,
      signal: new AbortController().signal,
    });
    await new Promise((r) => setImmediate(r));
    h.emitAgent({
      type: 'compaction_end',
      applied: false,
      mode: 'none',
      reason: 'invalid_history: orphan_tool_result',
      messagesBefore: history.length,
      messagesAfter: history.length,
      droppedMessages: 0,
      estimatedTokensBefore: 1,
      estimatedTokensAfter: 1,
      durationMs: 1,
    });

    expect(names(h.dir)).toHaveLength(0);
    expect(h.ends()[0]!.record.archivePath).toBeUndefined();
  });

  it('test 20b: the record dispatched to the reducer carries NO message array', async () => {
    const history = conversation(8);
    const h = wiringHarness(history);
    await h.wiring.compactNow({
      messages: history,
      systemPrompt: 'sys',
      model: REF,
      signal: new AbortController().signal,
    });

    const record = h.ends()[0]!.record as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(record)) {
      const holdsMessages =
        Array.isArray(value) &&
        value.some((v) => typeof v === 'object' && v !== null && 'role' in (v as object));
      expect(holdsMessages, `record.${key} holds messages`).toBe(false);
    }
  });

  it('test 23a: the manual path has written before compactNow resolves (RV-7)', async () => {
    const history = conversation(8);
    const h = wiringHarness(history);

    const outcome = await h.wiring.compactNow({
      messages: history,
      systemPrompt: 'sys',
      model: REF,
      signal: new AbortController().signal,
    });

    expect(outcome.ok).toBe(true);
    expect(names(h.dir)).toHaveLength(1);
  });

  // §3.5.2's document says `mode` is `summarized | truncated | relieved`, and the
  // third one is only ever reachable here: relief clips, so it drops nothing, and
  // a writer gated on the dropped slice can never produce it. `/compact history`
  // numbers its rows by COMPACTION INDEX, so skipping this compaction leaves a
  // hole at exactly the index a user investigating a clipped tail asks for.
  it('archives a relief-only compaction, which drops nothing (AC-H9)', async () => {
    // A SMALL WINDOW and one unsplittable turn: `planCompaction` finds no cut
    // above the protected prefix and the tool results alone exceed the window.
    const small: ModelInfo = { ...MODEL, contextWindow: 32_000, maxOutputTokens: 8_192 };
    const history: Message[] = [
      { role: 'user', content: 'the only turn', timestamp: 0 },
      {
        role: 'assistant',
        content: [{ type: 'tool_call', toolCallId: 'a', toolName: 'read_file', args: {} }],
      },
      { role: 'tool_result', toolCallId: 'a', content: 'r'.repeat(120_000) },
    ];
    const h = wiringHarness(history, {}, small);

    const outcome = await h.wiring.compactNow({
      messages: history,
      systemPrompt: 'sys',
      model: REF,
      signal: new AbortController().signal,
    });

    expect(outcome.ok).toBe(true);
    const files = names(h.dir);
    expect(files).toHaveLength(1);
    const doc = JSON.parse(readFileSync(join(h.dir, files[0]!), 'utf8')) as CompactionArchive;
    expect(doc.mode).toBe('relieved');
    expect(doc.droppedCount).toBe(0);
    expect(doc.dropped).toEqual([]);
    expect(doc.tailRelief?.messages).toBe(1);
  });

  it('test 24: archive: false writes nothing and creates no directory entry', async () => {
    const history = conversation(8);
    const h = wiringHarness(history, { archive: false });

    await h.wiring.compactNow({
      messages: history,
      systemPrompt: 'sys',
      model: REF,
      signal: new AbortController().signal,
    });

    expect(names(h.dir)).toHaveLength(0);
    expect(h.ends()[0]!.record.archivePath).toBeUndefined();
  });
});
