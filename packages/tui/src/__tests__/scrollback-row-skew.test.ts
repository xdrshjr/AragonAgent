/**
 * A terminal shrink can leave the screen one row off the writer's cache. The next batch
 * after a re-pin or a probe result must therefore be a full canvas repaint, not a diff
 * that trusts the cache (`tui-live-region-row-skew`).
 *
 * Two shrink models, because the terminal's behaviour is not known:
 *   scroll   - the top row goes to scrollback, the rows nearest the cursor stay.
 *   truncate - the blank parked row under the cursor is dropped, the cursor lands ON
 *              the status row and nothing scrolls.
 */
import { describe, expect, it } from 'vitest';
import { eraseLinesPrefix } from '../ui/frame-differ.js';
import { createScrollbackDrain } from '../ui/scrollback/drain.js';
import { createScrollbackWriter } from '../ui/scrollback/scrollback-writer.js';
import { createMiniVt, type MiniVt } from '../testing/mini-vt.js';

const COLS = 100;

/** `[band][composer top, input, composer bottom][identity][status]` = the native region. */
function region(height: number, tick: number): string[] {
  const band = height - 5;
  const lines: string[] = [];
  for (let i = 0; i < band - 2; i += 1) lines.push(`band ${i} |`);
  lines.push(`no output for ${tick}s |`);
  lines.push('Write file  queued |');
  lines.push('TOP-BORDER', 'INPUT', 'BOTTOM-BORDER', 'IDENTITY');
  lines.push(`STATUS t=${String(tick).padStart(3, '0')}`);
  return lines;
}

type Model = 'scroll' | 'truncate';
/** What reaches the writer after the shrink, in order. */
type Aftermath = 'frames-only' | 'probe-then-frame' | 'probe-frame-repaint' | 'probe-repaint';

function run(model: Model, aftermath: Aftermath): { vt: MiniVt; last: string[] } {
  let rows = 31;
  let vt: MiniVt = createMiniVt(rows, COLS);
  vt.write('$ aragon\r\n');
  let inkCount = 0;
  const writer = createScrollbackWriter({
    rows: () => rows, cols: () => COLS, sync: false,
    fullEveryFrame: false, drain: createScrollbackDrain(),
  });
  const frame = (lines: string[]): void => {
    const chunk = eraseLinesPrefix(inkCount) + lines.join('\n') + '\n';
    inkCount = lines.length + 1;
    const out = writer.transform(chunk);
    vt.write(out === null ? chunk : out);
  };

  writer.setAnchorSpaceBelow(rows - 2, 'probe');
  frame(region(30, 1));
  frame(region(30, 2));
  const before = vt.screen();

  const next = createMiniVt(rows - 1, COLS);
  if (model === 'scroll') next.write(before.slice(1, 30).join('\r\n') + '\r\n');
  else next.write(before.slice(0, 30).join('\r\n'));
  vt = next;
  rows -= 1;
  writer.onResize?.();

  // React's 50 ms throttle: one more frame at the old height, then the new one.
  frame(region(30, 3));
  let tick = 4;
  if (aftermath !== 'frames-only') {
    writer.setAnchorSpaceBelow(0, 'probe');
    if (aftermath === 'probe-repaint') {
      const out = writer.repaint();
      if (out) vt.write(out);
    } else {
      // An ordinary frame lands between the probe result and the deferred repaint().
      frame(region(29, tick++));
      if (aftermath === 'probe-frame-repaint') {
        const out = writer.repaint();
        if (out) vt.write(out);
      }
    }
  }
  let final = region(29, tick);
  for (; tick < 12; tick += 1) {
    final = region(29, tick);
    frame(final);
  }
  return { vt, last: final };
}

const AFTERMATHS: Aftermath[] = [
  'frames-only', 'probe-then-frame', 'probe-frame-repaint', 'probe-repaint',
];

describe('screen vs cache after a terminal shrink', () => {
  for (const model of ['scroll', 'truncate'] as const) {
    for (const aftermath of AFTERMATHS) {
      it(`converges_to_the_last_frame_${model}_${aftermath}`, () => {
        const { vt, last } = run(model, aftermath);
        const screen = vt.screen();
        expect(screen.filter((l) => l.startsWith('STATUS'))).toHaveLength(1);
        // The last row is the parked row: it must be empty.
        expect(screen[screen.length - 1]).toBe('');
        // The region sits directly above it, row for row.
        expect(screen.slice(screen.length - 1 - last.length, screen.length - 1)).toEqual(last);
      });
    }
  }

  it('does_not_leave_a_stale_status_row_when_the_probe_result_is_swallowed_by_a_frame', () => {
    const { vt } = run('truncate', 'probe-frame-repaint');
    expect(vt.screen().filter((l) => l.startsWith('STATUS'))).toHaveLength(1);
  });

  it('heals_without_any_probe_result_or_repaint', () => {
    const { vt } = run('truncate', 'frames-only');
    expect(vt.screen().filter((l) => l.startsWith('STATUS'))).toHaveLength(1);
  });
});
