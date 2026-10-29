/**
 * THE UPGRADE TRIPWIRE (tui-input-flicker-fix §4.3 / K-2).
 *
 * Everything in `frame-differ.test.ts` is synthetic: it asserts the differ
 * behaves correctly for chunks THIS REPOSITORY constructs. This file is what
 * ties those chunks to reality — it drives the real `ink/build/log-update.js`
 * against a fake stream and asserts the write shape the differ recognises is
 * byte-for-byte the one Ink produces.
 *
 * Without it, a future Ink that changes its write strategy would make the differ
 * fall through to pass-through FOREVER: no crash, no log line, no failing test —
 * just the flicker quietly coming back, months after the change that caused it.
 */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { eraseLinesPrefix } from '../ui/frame-differ.js';

const ERASE_PREFIX_RE = /^(?:\x1b\[2K(?:\x1b\[1A)?)+\x1b\[G/;

interface LogUpdateModule {
  default: { create: (stream: NodeJS.WriteStream) => (str: string) => void };
}

/**
 * `log-update.js` is PRIVATE — ink's `exports` map has no subpath for it, so
 * `import 'ink/build/log-update.js'` is refused by the resolver. Reaching it by
 * absolute file URL is deliberate and is the point of this file: the differ
 * reverse-engineers a private module, so the tripwire has to bind to that exact
 * module rather than to a public stand-in that could drift away from it.
 */
const require = createRequire(import.meta.url);
const logUpdateUrl = new URL('log-update.js', pathToFileURL(require.resolve('ink')));
const { default: logUpdate } = (await import(logUpdateUrl.href)) as LogUpdateModule;

interface Captured {
  writes: string[];
  render: (str: string) => void;
}

function capture(): Captured {
  const writes: string[] = [];
  const stream = { write: (s: string) => writes.push(s) } as unknown as NodeJS.WriteStream;
  return { writes, render: logUpdate.create(stream) };
}

describe('ink log-update write shape', () => {
  it('writes the frame with NO erase prefix on the first render', () => {
    // `previousLineCount` starts at 0, so `eraseLines(0)` is the empty string.
    // That is the whole reason the session's first chunk is passed through
    // un-diffed and does not seed the cache (P1-1).
    const { writes, render } = capture();
    render('a\nb\nc');
    expect(writes).toHaveLength(1);
    expect(writes[0]).toBe('a\nb\nc\n');
    expect(ERASE_PREFIX_RE.test(writes[0]!)).toBe(false);
  });

  it('prefixes every later write with eraseLines(previousLineCount)', () => {
    const { writes, render } = capture();
    render('a\nb\nc');
    render('a\nb\nd');
    expect(writes).toHaveLength(2);
    expect(ERASE_PREFIX_RE.test(writes[1]!)).toBe(true);
  });

  it('reconstructs that prefix byte-for-byte from prev.length + 1', () => {
    // THE EXACT-PREFIX FAST PATH (P2-3). The differ never scans in steady state;
    // it knows the string it expects and compares with `startsWith`. If this
    // reconstruction ever drifts from Ink's, every frame silently falls back.
    const { writes, render } = capture();
    const frame = ['a', 'b', 'c'];
    render(frame.join('\n'));
    render('a\nb\nd');

    const expected = eraseLinesPrefix(frame.length + 1);
    expect(writes[1]!.startsWith(expected)).toBe(true);
    // And it is EXACTLY the prefix, not merely a prefix of one: the body starts
    // immediately after it.
    expect(writes[1]!.slice(expected.length)).toBe('a\nb\nd\n');
  });

  it('always appends exactly one trailing newline to the frame', () => {
    // Step 4 of the algorithm rejects any body that does not end in `\n`, and
    // step 5 slices that newline off to get the row array.
    const { writes, render } = capture();
    render('one');
    expect(writes[0]).toBe('one\n');
  });

  it('returns early on an identical frame, which is why out.length === 0 is unreachable', () => {
    // P2-4: a chunk that reaches the differ differs by at least one line.
    const { writes, render } = capture();
    render('same');
    render('same');
    expect(writes).toHaveLength(1);
  });
});
