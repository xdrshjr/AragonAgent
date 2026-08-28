/**
 * The Windows VT-input gate
 * (shift-tab-and-mouse-wheel-dead-on-some-terminals, F1' / R6 item 5).
 *
 * THE TABLE IS THE POINT, and it is written as concrete version strings against
 * concrete booleans rather than as a re-derivation of the range constant.
 * `satisfiesNodeRange` FAILS OPEN by design, so a typo inside
 * `WINDOWS_VT_INPUT_NODE_RANGE` — a stray space in `>= 22.17.0`, a missing
 * `<23` — does not produce an error anywhere. It produces a gate that returns
 * `true` for every input, forever, with no message: the feature silently
 * un-fixes itself. Nothing else in the tree would notice, which is why these
 * rows are the only guard that constant has.
 *
 * Every version below is a real release boundary from the analysis, matched
 * against `nodejs/node`'s `src/tty_wrap.cc` tag by tag.
 */

import { describe, expect, it } from 'vitest';
import { supportsWindowsVtInput, WINDOWS_VT_INPUT_NODE_RANGE } from '../ui/win-vt-input.js';

/** `[version, supported]` on `win32`. */
const WIN32_TABLE: [string, boolean][] = [
  // 18.x and 20.x never got `UV_TTY_MODE_RAW_VT` — including the very last 20,
  // which is what makes this the DEFAULT LTS on most Windows machines and not a
  // long tail.
  ['18.20.8', false],
  ['20.19.0', false],
  ['20.20.0', false],
  // The 22 boundary, one patch either side of it.
  ['22.16.1', false],
  ['22.17.0', true],
  ['22.18.0', true],
  // 23 branched before the change and never received it. A range of
  // `>=22.17.0` without the `<23` clause would call this supported.
  ['23.11.1', false],
  // The 24 boundary: 24.0/24.1 predate the backport, 24.2.0 has it.
  ['24.1.0', false],
  ['24.2.0', true],
  ['25.0.0', true],
];

describe('supportsWindowsVtInput (win32 version boundaries)', () => {
  for (const [version, expected] of WIN32_TABLE) {
    it(`${expected ? 'accepts' : 'rejects'} Node ${version}`, () => {
      expect(supportsWindowsVtInput('win32', version)).toBe(expected);
    });
  }
});

describe('supportsWindowsVtInput (every other platform)', () => {
  it('is true on non-Windows regardless of the Node version', () => {
    // macOS and Linux go through a real pty: the TERMINAL encodes `CSI Z` and
    // the SGR reports, and no version of Node has ever been able to affect it.
    // An affected version paired with a non-Windows platform is the case that
    // proves the gate is reading BOTH arguments.
    for (const platform of ['darwin', 'linux', 'freebsd', 'aix']) {
      for (const [version] of WIN32_TABLE) {
        expect(supportsWindowsVtInput(platform, version), `${platform} ${version}`).toBe(true);
      }
    }
  });
});

describe('supportsWindowsVtInput (fail-open)', () => {
  it('assumes support when the version string cannot be parsed', () => {
    // The two errors are not symmetric. Guessing "supported" wrongly leaves the
    // machine exactly as it behaves today; guessing "unsupported" wrongly turns
    // the wheel off on a terminal where it works and shows a notice telling the
    // user to upgrade a Node that was already fine.
    for (const junk of ['', 'not-a-version', 'v', 'node', '22', '22.x']) {
      expect(supportsWindowsVtInput('win32', junk), junk).toBe(true);
    }
  });

  it('accepts a leading v, which is the shape process.version has', () => {
    // `process.versions.node` has no `v`, but `process.version` does, and the
    // two are one keystroke apart at the call site.
    expect(supportsWindowsVtInput('win32', 'v20.19.0')).toBe(false);
    expect(supportsWindowsVtInput('win32', 'v22.18.0')).toBe(true);
  });
});

describe('WINDOWS_VT_INPUT_NODE_RANGE', () => {
  it('is exactly the two disjoint windows, with the 23 line excluded', () => {
    // Pinned literally: this string is the entire gate, and the table above is
    // only meaningful while it is the thing being tested.
    expect(WINDOWS_VT_INPUT_NODE_RANGE).toBe('>=22.17.0 <23 || >=24.2.0');
  });
});
