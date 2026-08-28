/**
 * `config/prompt-history.ts` — the append-only recall store
 * (config-state-separation §8.2).
 *
 * ISOLATION: `ARAGON_HOME` is pointed at a throwaway directory BEFORE the
 * module is imported, because `app-paths.ts` resolves the root once at load.
 * Nothing here recursively deletes a path a function returned — only the
 * history file itself, or the temp root this file created (R-6).
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const TMP = mkdtempSync(join(tmpdir(), 'aragon-cli-hist-'));
process.env.ARAGON_HOME = TMP;

const { getPromptHistoryPath } = await import('../config/app-paths.js');
const {
  HISTORY_COMPACT_AT_LINES,
  PROMPT_ENTRY_MAX_CHARS,
  appendPrompt,
  clearPromptHistory,
  importLegacyPromptHistory,
  listPromptHistory,
  loadPromptHistory,
  resetPromptHistoryForTests,
  setHistoryEnabled,
} = await import('../config/prompt-history.js');
const { PROMPT_HISTORY_CAP } = await import('../config/schema.js');

const PATH = getPromptHistoryPath();

function writeLines(entries: { ts?: number; text: string; v?: number }[]): void {
  const body = entries
    .map((e) => `${JSON.stringify({ v: e.v ?? 1, ts: e.ts ?? 1, text: e.text })}\n`)
    .join('');
  writeFileSync(PATH, body, 'utf-8');
}

function fileLines(): string[] {
  if (!existsSync(PATH)) return [];
  return readFileSync(PATH, 'utf-8').split('\n').filter((l) => l.trim().length > 0);
}

beforeEach(() => {
  rmSync(PATH, { force: true });
  resetPromptHistoryForTests();
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('loading', () => {
  it('returns an empty list when there is no file', () => {
    expect(loadPromptHistory()).toEqual([]);
  });

  it('returns entries oldest-first, the order PromptInput walks with ↑', () => {
    writeLines([{ text: 'first' }, { text: 'second' }, { text: 'third' }]);
    expect(loadPromptHistory()).toEqual(['first', 'second', 'third']);
  });

  it('skips a broken line instead of discarding the whole history', () => {
    writeFileSync(
      PATH,
      `${JSON.stringify({ v: 1, ts: 1, text: 'kept' })}\n{oops\n${JSON.stringify({
        v: 1,
        ts: 2,
        text: 'also kept',
      })}\n`,
      'utf-8',
    );
    expect(loadPromptHistory()).toEqual(['kept', 'also kept']);
  });

  it('skips lines from a future schema version rather than coercing them', () => {
    writeLines([{ text: 'v1 entry' }, { text: 'v2 entry', v: 2 }]);
    expect(loadPromptHistory()).toEqual(['v1 entry']);
  });

  it('de-duplicates, keeping the most recent position', () => {
    writeLines([{ text: 'repeat' }, { text: 'other' }, { text: 'repeat' }]);
    expect(loadPromptHistory()).toEqual(['other', 'repeat']);
  });

  it('keeps only the newest PROMPT_HISTORY_CAP entries', () => {
    writeLines(
      Array.from({ length: PROMPT_HISTORY_CAP + 20 }, (_, i) => ({ text: `entry ${i}` })),
    );
    const loaded = loadPromptHistory();
    expect(loaded).toHaveLength(PROMPT_HISTORY_CAP);
    expect(loaded[loaded.length - 1]).toBe(`entry ${PROMPT_HISTORY_CAP + 19}`);
  });
});

describe('appending', () => {
  it('writes one line and makes it visible immediately', () => {
    appendPrompt('a prompt');
    expect(fileLines()).toHaveLength(1);
    expect(loadPromptHistory()).toEqual(['a prompt']);
  });

  /**
   * RV-1 at the unit level: `App.tsx` feeds this return value straight into
   * `setPromptHistory`, so it has to BE the list, not a stale copy of it. AC-2's
   * first half is the mounted-component version of this assertion.
   */
  it('returns the updated list, ending with what was just appended', () => {
    appendPrompt('older');
    const returned = appendPrompt('newest');
    expect(returned[returned.length - 1]).toBe('newest');
    expect(returned).toEqual(loadPromptHistory());
  });

  it('does not record a blank submission', () => {
    appendPrompt('   \n  ');
    expect(fileLines()).toHaveLength(0);
  });

  it('refuses an oversized entry rather than storing a truncated one', () => {
    appendPrompt('x'.repeat(PROMPT_ENTRY_MAX_CHARS + 1));
    expect(fileLines()).toHaveLength(0);
  });

  it('writes nothing while historyEnabled is false, and still returns the list', () => {
    appendPrompt('recorded');
    setHistoryEnabled(false);
    try {
      const returned = appendPrompt('not recorded');
      expect(fileLines()).toHaveLength(1);
      expect(returned).toEqual(['recorded']);
    } finally {
      setHistoryEnabled(true);
    }
  });

  /**
   * RV-12: switching recording off must not also hide what is already stored,
   * or "let me see what is in there before I delete it" becomes impossible.
   */
  it('still READS existing entries while historyEnabled is false', () => {
    writeLines([{ text: 'stored earlier' }]);
    setHistoryEnabled(false);
    try {
      expect(loadPromptHistory()).toEqual(['stored earlier']);
      expect(listPromptHistory().map((e) => e.text)).toEqual(['stored earlier']);
    } finally {
      setHistoryEnabled(true);
    }
  });

  /**
   * RV-2. `<home>` is created by the logger or the first config write, and a
   * fresh install that did neither has no directory at all. Without the
   * `mkdirSync` in the write path this throws `ENOENT`, the never-throws policy
   * swallows it, and the history silently never persists.
   */
  it('creates <home> when it does not exist yet', () => {
    rmSync(TMP, { recursive: true, force: true });
    expect(existsSync(TMP)).toBe(false);
    appendPrompt('first ever prompt');
    expect(fileLines()).toHaveLength(1);
    expect(loadPromptHistory()).toEqual(['first ever prompt']);
  });

  it.runIf(process.platform !== 'win32')('creates the file 0600 on POSIX', () => {
    appendPrompt('private prompt');
    expect(statSync(PATH).mode & 0o777).toBe(0o600);
  });

  /**
   * C2, the never-throws policy. Written as "the path is a directory" rather
   * than "the directory is read-only" because `chmod` is a no-op on Windows and
   * is ignored for root, either of which would turn this into a test that
   * passes without exercising the catch at all.
   */
  it('survives an unwritable target without throwing (C2)', () => {
    rmSync(PATH, { force: true });
    mkdirSync(PATH, { recursive: true });
    try {
      expect(() => appendPrompt('still fine')).not.toThrow();
      // The recall list still works for this session even though nothing landed.
      expect(appendPrompt('and again')).toContain('and again');
    } finally {
      rmSync(PATH, { recursive: true, force: true });
    }
  });
});

describe('compaction', () => {
  it('rewrites the file down to the cap once the line budget is exceeded', () => {
    writeLines(
      Array.from({ length: HISTORY_COMPACT_AT_LINES }, (_, i) => ({ text: `old ${i}` })),
    );
    loadPromptHistory();
    appendPrompt('the one that tips it over');

    const lines = fileLines();
    expect(lines.length).toBeLessThanOrEqual(PROMPT_HISTORY_CAP);
    const texts = lines.map((l) => (JSON.parse(l) as { text: string }).text);
    expect(texts[texts.length - 1]).toBe('the one that tips it over');
    expect(loadPromptHistory()).toEqual(texts);
  });

  /**
   * RV-3 — the reason compaction re-reads the file first. Writing this
   * process's in-memory array over the file would delete everything a second
   * `aragon` window appended since this one last read, which is exactly the
   * clobbering that append-only exists to prevent.
   */
  it('does not swallow entries another instance appended', () => {
    writeLines(
      Array.from({ length: HISTORY_COMPACT_AT_LINES }, (_, i) => ({ text: `old ${i}` })),
    );
    loadPromptHistory();

    // A second instance writes while this one holds a stale snapshot.
    appendFileSync(
      PATH,
      `${JSON.stringify({ v: 1, ts: Date.now(), text: 'from another window' })}\n`,
      'utf-8',
    );

    appendPrompt('mine');
    const texts = fileLines().map((l) => (JSON.parse(l) as { text: string }).text);
    expect(texts).toContain('from another window');
    expect(texts).toContain('mine');
  });

  it.runIf(process.platform !== 'win32')('re-applies 0600 after the rename', () => {
    writeLines(
      Array.from({ length: HISTORY_COMPACT_AT_LINES }, (_, i) => ({ text: `old ${i}` })),
    );
    chmodSync(PATH, 0o644);
    loadPromptHistory();
    appendPrompt('tips it over');
    expect(statSync(PATH).mode & 0o777).toBe(0o600);
  });
});

describe('list / clear / import', () => {
  it('lists raw entries newest-first with their timestamps', () => {
    writeLines([{ ts: 10, text: 'older' }, { ts: 20, text: 'newer' }]);
    expect(listPromptHistory()).toEqual([
      { v: 1, ts: 20, text: 'newer' },
      { v: 1, ts: 10, text: 'older' },
    ]);
  });

  it('clears the file, the cache and reports how many entries went', () => {
    writeLines([{ text: 'one' }, { text: 'two' }]);
    loadPromptHistory();
    expect(clearPromptHistory()).toBe(2);
    expect(existsSync(PATH)).toBe(false);
    expect(loadPromptHistory()).toEqual([]);
  });

  it('imports only the texts the file does not already hold', () => {
    writeLines([{ text: 'already here' }]);
    expect(importLegacyPromptHistory(['already here', 'new one'])).toBe(1);
    expect(loadPromptHistory()).toEqual(['already here', 'new one']);
  });
});
