/**
 * The file sink: rotation, retention, flush collapsing, overflow accounting and
 * self-disabling.
 *
 * Against the REAL filesystem in a temp directory, not a mock. The failures this
 * module exists to survive — a locked file, a rename refused while a handle is
 * open, a directory that cannot be created — are precisely the ones a mock
 * filesystem would model as succeeding.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSink, currentLogFileName, enforceRetention, localDateStamp } from '../logging/file-sink.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aragon-sink-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function sink(overrides: Partial<ConstructorParameters<typeof FileSink>[0]> = {}): FileSink {
  return new FileSink({ dir, maxFileBytes: 1024 * 1024, maxFiles: 10, ...overrides });
}

function todayFile(): string {
  return join(dir, currentLogFileName());
}

function lines(file: string): string[] {
  return readFileSync(file, 'utf-8').split('\n').filter((l) => l.length > 0);
}

describe('writing and flushing', () => {
  it('creates nothing until a record is actually written', () => {
    sink();
    // `aragon --version` must not leave an empty log directory behind.
    expect(existsSync(dir)).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('flushSync is idempotent and does not duplicate lines', () => {
    const s = sink();
    s.write('{"a":1}\n');
    s.flushSync();
    s.flushSync();
    s.flushSync();
    expect(lines(todayFile())).toEqual(['{"a":1}']);
    s.close();
  });

  it('keeps every line parseable when a batch is written at once', () => {
    const s = sink();
    for (let i = 0; i < 200; i += 1) s.write(`${JSON.stringify({ i })}\n`);
    s.flushSync();
    const parsed = lines(todayFile()).map((l) => JSON.parse(l) as { i: number });
    expect(parsed.length).toBe(200);
    expect(parsed[199]!.i).toBe(199);
    s.close();
  });

  it('appends rather than truncating when a second sink opens the same file', () => {
    const first = sink();
    first.write('{"who":"first"}\n');
    first.close();

    const second = sink();
    second.write('{"who":"second"}\n');
    second.close();

    expect(lines(todayFile()).length).toBe(2);
  });
});

describe('rotation', () => {
  it('rotates once the file would exceed maxFileBytes', () => {
    const s = sink({ maxFileBytes: 300 });
    const line = `${JSON.stringify({ padding: 'x'.repeat(80) })}\n`;
    for (let i = 0; i < 8; i += 1) {
      s.write(line);
      s.flushSync();
    }
    s.close();

    const rotated = readdirSync(dir).filter((f) => /\.\d+\.log$/.test(f));
    expect(rotated.length).toBeGreaterThan(0);
  });

  it('closes the handle BEFORE renaming, so the rotated file really exists', () => {
    // This is the order assertion. On Windows — the platform this feature was
    // asked for — renaming a file the process still holds open fails with
    // EPERM, the rename is swallowed, and no `.1.log` is ever produced. So the
    // existence of the rotated file with the pre-rotation content IS the proof
    // that close preceded rename.
    const s = sink({ maxFileBytes: 200 });
    s.write(`${JSON.stringify({ first: true, padding: 'a'.repeat(150) })}\n`);
    s.flushSync();
    s.write(`${JSON.stringify({ second: true, padding: 'b'.repeat(150) })}\n`);
    s.flushSync();
    s.close();

    const rotated = join(dir, `aragon-${localDateStamp()}.1.log`);
    expect(existsSync(rotated)).toBe(true);
    expect(readFileSync(rotated, 'utf-8')).toContain('"first":true');
    expect(readFileSync(todayFile(), 'utf-8')).toContain('"second":true');
  });

  it('increments the rotation index instead of overwriting an earlier one', () => {
    writeFileSync(join(dir, `aragon-${localDateStamp()}.1.log`), 'old\n', 'utf-8');

    const s = sink({ maxFileBytes: 200 });
    s.write(`${JSON.stringify({ padding: 'a'.repeat(150) })}\n`);
    s.flushSync();
    s.write(`${JSON.stringify({ padding: 'b'.repeat(150) })}\n`);
    s.flushSync();
    s.close();

    expect(readFileSync(join(dir, `aragon-${localDateStamp()}.1.log`), 'utf-8')).toBe('old\n');
    expect(existsSync(join(dir, `aragon-${localDateStamp()}.2.log`))).toBe(true);
  });
});

describe('retention (P1-5)', () => {
  it('keeps only the newest maxFiles', () => {
    for (let i = 1; i <= 6; i += 1) {
      const file = join(dir, `aragon-2026-01-0${i}.log`);
      writeFileSync(file, 'x\n', 'utf-8');
      const when = new Date(2026, 0, i);
      utimesSync(file, when, when);
    }

    enforceRetention(dir, 2);

    const left = readdirSync(dir).sort();
    expect(left).toEqual(['aragon-2026-01-05.log', 'aragon-2026-01-06.log']);
  });

  it('runs on the FIRST write of a process, not only on size rotation', () => {
    // A user who never reaches `maxFileBytes` would otherwise accumulate one
    // file per day forever under a setting that says 3.
    for (let i = 1; i <= 5; i += 1) {
      const file = join(dir, `aragon-2026-01-0${i}.log`);
      writeFileSync(file, 'x\n', 'utf-8');
      const when = new Date(2026, 0, i);
      utimesSync(file, when, when);
    }

    const s = sink({ maxFiles: 3 });
    s.write('{"new":true}\n');
    s.flushSync();
    s.close();

    // Today's file plus the two newest survivors.
    expect(readdirSync(dir).length).toBe(3);
    expect(existsSync(todayFile())).toBe(true);
  });

  it('ignores files that are not ours', () => {
    writeFileSync(join(dir, 'notes.txt'), 'keep me', 'utf-8');
    writeFileSync(join(dir, 'aragon-2026-01-01.log'), 'x\n', 'utf-8');
    enforceRetention(dir, 0);
    expect(readdirSync(dir)).toEqual(['notes.txt']);
  });

  it('never throws on a directory that does not exist', () => {
    expect(() => enforceRetention(join(dir, 'missing'), 5)).not.toThrow();
  });
});

describe('dropped-record accounting', () => {
  it('reports records lost to a failed flush once writing recovers', () => {
    // The reachable drop path. A flush that throws cannot keep its batch — the
    // queue would grow without bound behind a directory that may never become
    // writable — but losing records without a word is not acceptable either.
    const blocked = join(dir, 'logs');
    writeFileSync(blocked, 'a file where the directory should be', 'utf-8');

    const s = new FileSink({
      dir: blocked,
      maxFileBytes: 1024 * 1024,
      maxFiles: 10,
      formatDropNotice: (count) => `${JSON.stringify({ msg: 'records_dropped', count })}\n`,
    });

    s.write('{"i":1}\n');
    s.flushSync();
    s.write('{"i":2}\n');
    s.flushSync();
    expect(s.disabled).toBe(false); // two failures: not given up yet

    rmSync(blocked);
    mkdirSync(blocked);
    s.write('{"i":3}\n');
    s.flushSync();
    s.close();

    const written = lines(join(blocked, currentLogFileName()));
    const notice = JSON.parse(written[written.length - 1] as string) as {
      msg: string;
      count: number;
    };
    expect(notice.msg).toBe('records_dropped');
    expect(notice.count).toBe(2);
  });

  it('keeps the OLDEST records when the hard queue ceiling is reached', () => {
    // The head is what explains how a flood started; dropping it first would
    // discard the log's value exactly when it finally has some. Reached by
    // enqueuing without ever flushing.
    const s = sink({
      formatDropNotice: (count) => `${JSON.stringify({ msg: 'records_dropped', count })}\n`,
    });
    const queue = (s as unknown as { queue: string[] }).queue;
    for (let i = 0; i < 5200; i += 1) queue.push(`${JSON.stringify({ i })}\n`);

    s.write('{"i":"one-too-many"}\n');
    expect((s as unknown as { dropped: number }).dropped).toBe(1);
    expect(queue[0]).toBe(`${JSON.stringify({ i: 0 })}\n`);
    s.close();
  });
});

describe('self-disabling (§4.4.6)', () => {
  it('gives up after three consecutive failures and reports once', () => {
    // A FILE where the log directory should be: every `mkdirSync` throws
    // ENOTDIR, which is what "the directory is read-only" looks like from here.
    const blocked = join(dir, 'blocked');
    writeFileSync(blocked, 'not a directory', 'utf-8');

    const failures: string[] = [];
    const s = new FileSink({
      dir: blocked,
      maxFileBytes: 1024,
      maxFiles: 5,
      onFailure: (reason) => failures.push(reason),
    });

    for (let i = 0; i < 3; i += 1) {
      s.write('{"x":1}\n');
      s.flushSync();
    }

    expect(s.disabled).toBe(true);
    expect(s.lastError).toBeTruthy();
    expect(failures.length).toBe(1);

    // And a logging failure is never a CLI failure.
    expect(() => {
      s.write('{"x":2}\n');
      s.flushSync();
      s.close();
    }).not.toThrow();
  });
});

describe('reconfigure', () => {
  it('moves subsequent records to a new directory', () => {
    const s = sink();
    s.write('{"where":"first"}\n');
    s.flushSync();

    const next = join(dir, 'elsewhere');
    mkdirSync(next);
    s.reconfigure({ dir: next, maxFileBytes: 1024 * 1024, maxFiles: 10 });
    s.write('{"where":"second"}\n');
    s.flushSync();
    s.close();

    expect(readFileSync(todayFile(), 'utf-8')).toContain('first');
    expect(readFileSync(join(next, currentLogFileName()), 'utf-8')).toContain('second');
  });
});

describe('permissions', () => {
  it.runIf(process.platform !== 'win32')('creates the directory 0700', () => {
    // debug/trace files carry prompt text, so the directory belongs in the same
    // bracket as the 0600 config file.
    const s = sink();
    s.write('{"a":1}\n');
    s.flushSync();
    s.close();
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });
});
