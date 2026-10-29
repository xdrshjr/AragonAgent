import { describe, expect, it } from 'vitest';
import { eraseLinesPrefix } from '../ui/frame-differ.js';
import { wrapStdoutForFrames } from '../ui/stdout-frame-writer.js';
import { createScrollbackDrain } from '../ui/scrollback/drain.js';
import { createScrollbackWriter } from '../ui/scrollback/scrollback-writer.js';
import { createMiniVt, type MiniVt } from '../testing/mini-vt.js';

/**
 * The writer's bytes fed to a terminal model WITH scrollback. These assert the
 * thing the byte tests cannot: what a user scrolling their terminal would see.
 */
function session(rows = 10, cols = 40, shell: string[] = ['$ ls', 'a.txt b.txt', '$ aragon']) {
  const vt = createMiniVt(rows, cols);
  for (const line of shell) vt.write(line + '\r\n');
  const drain = createScrollbackDrain();
  const writer = createScrollbackWriter({
    rows: () => rows, cols: () => cols, sync: true, fullEveryFrame: false, drain,
  });
  let inkCount = 0;
  const frame = (lines: string[], statics: string[] = []): void => {
    if (statics.length > 0) drain.enqueue(statics, { id: String(Math.random()), kind: 'user' });
    const chunk = eraseLinesPrefix(inkCount) + lines.join('\n') + '\n';
    inkCount = lines.length + 1;
    const out = writer.transform(chunk);
    vt.write(out === null ? chunk : out);
  };
  const repaint = (): void => {
    const out = writer.repaint();
    if (out) vt.write(out);
  };
  return { vt, drain, writer, frame, repaint, shell };
}

function expectCleanHistory(vt: MiniVt, expected: string[]): void {
  expect(vt.forbidden).toEqual([]);
  expect(vt.history()).toEqual(expected);
}

describe('ScrollbackWriter against a scrolling terminal model', () => {
  it('prints below the shell output on startup without gaps or blank rows', () => {
    const { vt, frame, shell } = session();
    frame(['> prompt', 'status'], ['Welcome', 'v1']);
    expectCleanHistory(vt, [...shell, 'Welcome', 'v1', '> prompt', 'status']);
  });

  it('pushes only printed rows into scrollback as content grows past the screen', () => {
    const { vt, frame, shell } = session(8, 40);
    frame(['> p', 's']);
    const printed: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const row = `message ${i}`;
      printed.push(row);
      frame(['> p', 's'], [row]);
    }
    expectCleanHistory(vt, [...shell, ...printed, '> p', 's']);
    expect(vt.scrollback.length).toBeGreaterThan(0);
    expect(vt.scrollback.filter((line) => line === '').length).toBe(0);
  });

  it('keeps the region hugging the last history row after it shrinks and grows', () => {
    const { vt, frame, shell } = session(10, 40);
    frame(['top1', 'top2', 'top3', '> p', 's']);
    frame(['> p', 's'], ['A']);
    expectCleanHistory(vt, [...shell, 'A', '> p', 's']);
    frame(['x1', 'x2', 'x3', 'x4', '> p', 's'], ['B']);
    expectCleanHistory(vt, [...shell, 'A', 'B', 'x1', 'x2', 'x3', 'x4', '> p', 's']);
    frame(['> p', 's']);
    expectCleanHistory(vt, [...shell, 'A', 'B', '> p', 's']);
  });

  it('handles a static batch taller than the screen with order preserved', () => {
    const { vt, frame, shell } = session(8, 40);
    frame(['> p', 's']);
    const big = Array.from({ length: 30 }, (_, i) => `row ${i}`);
    frame(['> p', 's'], big);
    expectCleanHistory(vt, [...shell, ...big, '> p', 's']);
  });

  it('diff batches update a row in place without disturbing history', () => {
    const { vt, frame, shell } = session();
    frame(['> a', 'status 1'], ['hello']);
    frame(['> ab', 'status 1']);
    frame(['> ab', 'status 2']);
    expectCleanHistory(vt, [...shell, 'hello', '> ab', 'status 2']);
  });

  it('repaint prints a final entry with no Ink frame in between', () => {
    const { vt, frame, drain, repaint, shell } = session();
    frame(['> p', 's']);
    drain.enqueue(['you: hi'], { id: 'u', kind: 'user' });
    repaint();
    expectCleanHistory(vt, [...shell, 'you: hi', '> p', 's']);
  });

  it('works when the shell output already fills the screen', () => {
    const filler = Array.from({ length: 20 }, (_, i) => `old ${i}`);
    const { vt, frame, shell } = session(8, 40, filler);
    frame(['> p', 's'], ['first']);
    frame(['> p', 's'], ['second']);
    expectCleanHistory(vt, [...shell, 'first', 'second', '> p', 's']);
  });

  it('never emits a forbidden sequence across a full scripted session', () => {
    const { vt, frame, repaint, drain } = session(9, 30);
    frame(['> p', 's'], ['banner']);
    for (let i = 0; i < 15; i += 1) {
      frame(['preview a', 'preview b', '> p', 's'], [`entry ${i}`]);
      frame(['preview a', 'preview b', 'preview c', '> p', 's']);
      frame(['> p', 's']);
      drain.enqueue([`late ${i}`], { id: `l${i}`, kind: 'assistant' });
      repaint();
    }
    expect(vt.forbidden).toEqual([]);
  });

  it('finalize leaves the cursor on a blank new line at column 0 (I-S10)', () => {
    const { vt, frame, writer, drain, shell } = session();
    frame(['> p', 's'], ['hello']);
    drain.enqueue(['last'], { id: 'z', kind: 'assistant' });
    vt.write(writer.finalize(['Session ended']));
    expect(vt.forbidden).toEqual([]);
    expect(vt.history()).toEqual([...shell, 'hello', 'last', 'Session ended']);
    expect(vt.cursor().col).toBe(0);
    expect(vt.screen()[vt.cursor().row]).toBe('');
  });

  it('survives Ink frames arriving after finalize (RV-2)', () => {
    const { vt, frame, writer, shell } = session();
    frame(['> p', 's'], ['hello']);
    vt.write(writer.finalize(['bye']));
    const before = vt.history();
    frame(['> p', 's']);
    expect(vt.history()).toEqual(before);
    expect(before).toEqual([...shell, 'hello', 'bye']);
  });

  it('does not erase history after a rows-unknown pass-through (RV-6)', () => {
    const vt = createMiniVt(10, 40);
    vt.write('$ aragon\r\n');
    const drain = createScrollbackDrain();
    let rows: number | undefined = 10;
    const writer = createScrollbackWriter({
      rows: () => rows, cols: () => 40, sync: false, fullEveryFrame: false, drain,
    });
    let inkCount = 0;
    const send = (lines: string[]): void => {
      const chunk = eraseLinesPrefix(inkCount) + lines.join('\n') + '\n';
      inkCount = lines.length + 1;
      const out = writer.transform(chunk);
      vt.write(out === null ? chunk : out);
    };
    drain.enqueue(['kept history'], { id: 'h', kind: 'user' });
    send(['r1', 'r2', 'r3', 'r4']);
    rows = undefined;
    send(['p']); // Ink writes this itself, shrinking the region
    rows = 10;
    drain.enqueue(['more'], { id: 'm', kind: 'user' });
    send(['p']);
    expect(vt.forbidden).toEqual([]);
    expect(vt.history()).toEqual(['$ aragon', 'kept history', 'more', 'p']);
  });
});

describe('wrapStdoutForFrames with the scrollback writer', () => {
  it('routes OSC 52 through writeForeign without invalidating the region', () => {
    const vt = createMiniVt(10, 40);
    const drain = createScrollbackDrain();
    const writer = createScrollbackWriter({
      rows: () => 10, cols: () => 40, sync: false, fullEveryFrame: false, drain,
    });
    const real = {
      write: (chunk: string) => { vt.write(chunk); return true; },
      on: () => undefined, off: () => undefined, rows: 10, columns: 40,
    } as unknown as NodeJS.WriteStream;
    const handle = wrapStdoutForFrames(real, writer);
    let inkCount = 0;
    const send = (lines: string[]): void => {
      handle.stdout.write(eraseLinesPrefix(inkCount) + lines.join('\n') + '\n');
      inkCount = lines.length + 1;
    };
    send(['> a', 's']);
    handle.writeForeign('\x1b]52;c;aGk=\x07');
    send(['> ab', 's']);
    expect(writer.scrollbackStats().framesSeed).toBe(1);
    expect(vt.history()).toEqual(['> ab', 's']);
    handle.dispose();
  });
});
