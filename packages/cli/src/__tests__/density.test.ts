import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { separationRows } from '../ui/density.js';
import { GUTTER_WIDTH } from '../ui/layout/Gutter.js';
import type { Entry } from '../agent/reducer.js';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const user = (id = 'u'): Entry => ({ id, kind: 'user', text: 'hi' });
const asst = (id = 'a'): Entry => ({
  id,
  kind: 'assistant',
  text: 'yo',
  thinkingOpen: false,
  streaming: false,
});
const tool = (id = 't'): Entry => ({
  id,
  kind: 'tool',
  toolCallId: id,
  name: 'read_file',
  label: 'read_file',
  argsRaw: '{}',
  status: 'done',
});
const notice = (id = 'n'): Entry => ({ id, kind: 'notice', level: 'info', text: 'n' });

const ALL = [user(), asst(), tool(), notice()];

describe('separationRows (A-8)', () => {
  it('never puts a blank row above the first entry', () => {
    for (const e of ALL) {
      expect(separationRows(undefined, e, 'comfortable'), e.kind).toBe(0);
      expect(separationRows(undefined, e, 'compact'), e.kind).toBe(0);
    }
  });

  it('keeps consecutive tool calls tight', () => {
    // Two tool calls are one action as far as the reader is concerned.
    expect(separationRows(tool('t1'), tool('t2'), 'comfortable')).toBe(0);
  });

  it('spends its one blank row on the turn boundary', () => {
    // A new user message is the only place in a transcript where a blank line
    // buys anything. Everything else used to pay for one unconditionally, which
    // is how a single "ask -> read -> answer" turn reached 17 rows.
    for (const prev of ALL) {
      expect(separationRows(prev, user('u2'), 'comfortable'), prev.kind).toBe(1);
    }
  });

  it('adds nothing between an assistant answer and its tool calls', () => {
    expect(separationRows(asst(), tool(), 'comfortable')).toBe(0);
    expect(separationRows(tool(), asst(), 'comfortable')).toBe(0);
    expect(separationRows(asst(), notice(), 'comfortable')).toBe(0);
    expect(separationRows(notice(), asst(), 'comfortable')).toBe(0);
  });

  it('is uniformly zero in compact mode, including at turn boundaries', () => {
    for (const prev of ALL) {
      for (const next of ALL) {
        expect(separationRows(prev, next, 'compact'), `${prev.kind}->${next.kind}`).toBe(0);
      }
    }
  });

  it('only ever returns 0 or 1 across the full matrix', () => {
    for (const prev of [undefined, ...ALL]) {
      for (const next of ALL) {
        for (const mode of ['comfortable', 'compact'] as const) {
          expect([0, 1]).toContain(separationRows(prev, next, mode));
        }
      }
    }
  });

  it('costs a comfortable 3-entry turn exactly one blank row', () => {
    // The concrete budget claim behind M-4: the old renderer spent one blank row
    // per entry (3 here) plus 2 rows of card border.
    const turn = [user(), tool(), asst()];
    const blanks = turn.reduce(
      (sum, e, i) => sum + separationRows(i > 0 ? turn[i - 1] : undefined, e, 'comfortable'),
      0,
    );
    expect(blanks).toBe(0); // no user entry follows within this single turn
    const twoTurns = [...turn, user('u2')];
    const blanks2 = twoTurns.reduce(
      (sum, e, i) => sum + separationRows(i > 0 ? twoTurns[i - 1] : undefined, e, 'comfortable'),
      0,
    );
    expect(blanks2).toBe(1);
  });
});

describe('Gutter (A-6 / invariant I-2)', () => {
  it('keeps flexShrink={0} on the content column', () => {
    // Source-level because the assertion is about a PROP, and the test stack
    // (`ink-testing-library`) returns rendered strings only -- there is no
    // render tree to inspect and reaching for one would mean a new dependency.
    //
    // Why it matters: `ScrollViewport` derives overflow from `measureElement`.
    // Let yoga shrink this column and the measurement reports content ===
    // viewport, overflow is permanently 0, and PgUp becomes a silent no-op.
    // Nothing throws; scrolling just stops. The behavioural half of this
    // assertion lives in `app.test.tsx` ("actually scrolls when the content
    // overflows the viewport").
    const src = readFileSync(resolve(SRC, 'ui/layout/Gutter.tsx'), 'utf8');
    const contentColumn = /<Box flexDirection="column" flexShrink=\{0\}>/;
    expect(contentColumn.test(src)).toBe(true);
  });

  it('reserves a fixed two-column rail so entries stay aligned', () => {
    expect(GUTTER_WIDTH).toBe(2);
  });
});
