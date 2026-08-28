/**
 * The stream-feature gate matrix (tui-paste-handling D-13 / D-17 / I-11,
 * T-28 / T-29).
 *
 * WHY THIS FILE EXISTS AT ALL. Before this feature, `filter !== null` answered
 * FIVE questions in `cli.tsx` and only one of them was really about the stream.
 * Widening the gate so `paste` can build a filter on its own — and `paste`
 * defaults to `true` — flips the other four for every `--no-mouse` user:
 * `?1000h`/`?1006h`/`?1002h` written, the terminal's own click-drag selection
 * taken away (the ONLY reason anyone passes `--no-mouse`), and a startup notice
 * advising them about a mode they just disabled.
 *
 * NOTHING ABOUT THAT FAILURE IS VISIBLE IN A TEST THAT ONLY ASSERTS A FILTER
 * EXISTS, which is why the load-bearing row below asserts what each site is
 * HANDED rather than that construction succeeded.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { tryCreateStdinFilter } from '../input/stdin-filter.js';
import { enterAltScreen } from '../ui/screen.js';
import { stripComments } from './glyphs.test.js';

const CLI_SOURCE = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '..', 'cli.tsx'),
  'utf-8',
);

function fakeStdin(): NodeJS.ReadStream {
  const stream = new PassThrough();
  Object.assign(stream, { isTTY: true, setRawMode: () => stream });
  return stream as unknown as NodeJS.ReadStream;
}

function fakeStdout() {
  const writes: string[] = [];
  const stdout = {
    isTTY: true,
    write(s: string) {
      writes.push(s);
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  return { stdout, all: () => writes.join('') };
}

/**
 * `runInteractive`-SHAPED, deliberately: every expression below is copied from
 * `cli.tsx` verbatim, and the source assertions at the bottom of this file are
 * what stop the copy drifting from the original.
 */
function gate(opts: { wantMouse: boolean; configPaste: boolean; mode: 'fullscreen' | 'inline' }) {
  const real = fakeStdin();
  const wantPaste = opts.configPaste && !!real.isTTY;
  const filter =
    opts.wantMouse || wantPaste
      ? tryCreateStdinFilter(real, { mouse: opts.wantMouse, paste: wantPaste })
      : null;

  const mouseOn = opts.wantMouse && filter !== null;
  const pasteOn = wantPaste && filter !== null;
  const mouseSelectConfig = true;
  const wantSelect = mouseOn && mouseSelectConfig;

  const { stdout, all } = fakeStdout();
  const screen =
    opts.mode === 'fullscreen'
      ? enterAltScreen(stdout, {
          mouse: mouseOn,
          motion: wantSelect,
          bracketedPaste: pasteOn && opts.mode === 'fullscreen',
        })
      : null;

  const result = {
    filterBuilt: filter !== null,
    wantSelect,
    mouseCaptured: mouseOn,
    mouseSource: mouseOn && filter ? filter.source : undefined,
    inkStdin: filter?.stdin ?? real,
    realStdin: real,
    bytes: all(),
  };
  screen?.restore();
  filter?.dispose();
  return { ...result, bytesAfterRestore: all() };
}

const MOUSE_ON_BYTES = ['\x1b[?1000h', '\x1b[?1006h'];
const MOTION_BYTE = '\x1b[?1002h';
const PASTE_ON_BYTE = '\x1b[?2004h';

describe('T-29: the (mouse, paste) gate matrix', () => {
  it('(mouse: false, paste: true) builds a filter and STILL writes no mouse byte', () => {
    // THE LOAD-BEARING ROW (P0-1). Asserting only that a filter exists is what
    // would let the regression through.
    const g = gate({ wantMouse: false, configPaste: true, mode: 'fullscreen' });

    expect(g.filterBuilt).toBe(true);
    for (const byte of [...MOUSE_ON_BYTES, MOTION_BYTE]) {
      expect(g.bytesAfterRestore).not.toContain(byte);
    }
    expect(g.wantSelect).toBe(false);
    expect(g.mouseCaptured).toBe(false);
    expect(g.mouseSource).toBeUndefined();
    // ...and paste really is on, or the row proves nothing.
    expect(g.bytes).toContain(PASTE_ON_BYTE);
    expect(g.inkStdin).not.toBe(g.realStdin);
  });

  it('(mouse: true, paste: false) is the v0.6.3 session, byte for byte', () => {
    const g = gate({ wantMouse: true, configPaste: false, mode: 'fullscreen' });

    expect(g.filterBuilt).toBe(true);
    for (const byte of MOUSE_ON_BYTES) expect(g.bytes).toContain(byte);
    expect(g.bytes).toContain(MOTION_BYTE);
    expect(g.bytes).not.toContain(PASTE_ON_BYTE);
    expect(g.wantSelect).toBe(true);
    expect(g.mouseCaptured).toBe(true);
    expect(g.mouseSource).toBeDefined();
  });

  it('(mouse: true, paste: true) turns both on and neither off', () => {
    const g = gate({ wantMouse: true, configPaste: true, mode: 'fullscreen' });

    for (const byte of [...MOUSE_ON_BYTES, MOTION_BYTE, PASTE_ON_BYTE]) {
      expect(g.bytes).toContain(byte);
    }
    expect(g.mouseSource).toBeDefined();
  });

  it('T-28: (mouse: false, paste: false) hands Ink the REAL stdin, unwrapped', () => {
    // AC-6 / I-10: with every stream feature off, nothing is wrapped — and that
    // stays a statement about the code rather than about behaviour only while
    // this identity holds.
    const g = gate({ wantMouse: false, configPaste: false, mode: 'fullscreen' });

    expect(g.filterBuilt).toBe(false);
    expect(g.inkStdin).toBe(g.realStdin);
    expect(g.mouseSource).toBeUndefined();
    for (const byte of [...MOUSE_ON_BYTES, MOTION_BYTE, PASTE_ON_BYTE]) {
      expect(g.bytes).not.toContain(byte);
    }
  });

  it('inline mode never asks for bracketed paste, even with paste on (D-6 / N5)', () => {
    // `?2004h` left set after a `kill` makes every subsequent paste in the shell
    // arrive as a literal `[200~`. Inline mode has no `screen.ts` handle on the
    // four exit paths, so it does not get to ask.
    const g = gate({ wantMouse: false, configPaste: true, mode: 'inline' });
    expect(g.filterBuilt).toBe(true);
    expect(g.bytes).toBe('');
  });
});

/**
 * The harness above is a COPY of `cli.tsx`'s expressions, so it is only evidence
 * for as long as the original still reads that way. These assertions are what
 * make that true.
 */
describe('I-11: `filter !== null` answers exactly one question in cli.tsx', () => {
  it('derives `mouseOn` and `pasteOn` explicitly', () => {
    expect(CLI_SOURCE).toMatch(/const mouseOn = wantMouse && filter !== null;/);
    expect(CLI_SOURCE).toMatch(/const pasteOn = wantPaste && filter !== null;/);
  });

  it('repoints all four mouse sites at `mouseOn`', () => {
    expect(CLI_SOURCE).toMatch(/const wantSelect = mouseOn && config\.mouseSelect;/);
    expect(CLI_SOURCE).toMatch(/mouse: mouseOn,/);
    expect(CLI_SOURCE).toMatch(/let mouseCaptured = mouseOn;/);
    expect(CLI_SOURCE).toMatch(/mouseSource=\{mouseOn && filter \? filter\.source : undefined\}/);
  });

  it('leaves `filter !== null` nowhere else — the handle is not a mouse signal', () => {
    // Exactly two occurrences IN CODE, and they are the two derivations above.
    // A third is how the five-sites problem comes back. Comments are blanked
    // first because this invariant is explained at length in several of them,
    // and a scanner that counted prose would fail on its own documentation.
    const code = stripComments(CLI_SOURCE);
    expect(code.split('filter !== null').length - 1).toBe(2);
  });

  it('gates `?2004h` on `pasteOn` and full-screen, never on the handle', () => {
    expect(CLI_SOURCE).toMatch(/bracketedPaste: pasteOn && mode === 'fullscreen',/);
  });

  it('still hands the STREAM question to the handle', () => {
    expect(CLI_SOURCE).toMatch(/stdin: filter\?\.stdin \?\? process\.stdin,/);
  });
});
