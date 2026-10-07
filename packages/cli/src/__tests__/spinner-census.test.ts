/**
 * The spinner census — two static scans (single-spinner-while-running AC-9,
 * AC-11).
 *
 * NEITHER OF THESE CAN BE WRITTEN AS A COMPONENT TEST, which is the whole
 * reason they exist as file scans. `single-spinner.test.tsx` asserts the
 * invariant on TODAY's frame; these two assert it survives the NEXT feature:
 *
 *   AC-9  — every animated site takes the suppression signal. A new component
 *           that imports `ink-spinner` and ignores `reducedMotion` animates
 *           unconditionally, and no existing test renders it.
 *   AC-11 — the WIRING in `App.tsx` is right. AC-9 scans the seven leaves and
 *           proves each still honours the prop; it is blind to `App` handing one
 *           of them the RAW flag instead of the widened one. That mistake is one
 *           identifier's difference, it typechecks, it passes AC-9, and it
 *           re-introduces exactly the second spinner this round removed.
 *
 * Same shape as the whole-file scanner in `glyphs.test.ts`, and for the same
 * reason: a whole-file invariant that no component test can see.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UI = join(SRC, 'ui');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

const rel = (file: string): string => relative(SRC, file).replace(/\\/g, '/');

/** Every file under `src/ui/**` that mounts an animated spinner. */
function spinnerFiles(): string[] {
  return walk(UI)
    .filter((f) => /from ['"]ink-spinner['"]/.test(readFileSync(f, 'utf8')))
    .map(rel)
    .sort();
}

describe('AC-9: every animated site takes the suppression signal', () => {
  it('leaves no `ink-spinner` importer that ignores `reducedMotion`', () => {
    // R-6, stated as a scan rather than as a comment: the moment a new site
    // takes `reducedMotion`, it is suppressed BY CONSTRUCTION, because `App`
    // already passes every view consumer the widened value. A site that does not
    // take it is a site that animates through the whole of every run, and the
    // only symptom is a second spinner nobody assigned to anyone.
    const offenders = spinnerFiles().filter(
      (r) => !/reducedMotion/.test(readFileSync(join(SRC, r), 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('the scan is not vacuous — it really sees the nine known sites', () => {
    // A scanner that silently matches nothing passes the assertion above
    // forever. This is the same self-check `glyphs.test.ts` carries one level up
    // at the directory: "the suite passes" is not evidence that anything was
    // scanned. The census is also the CHECKLIST for §3.1 — a tenth entry here
    // means a tenth row belongs in the design's table.
    //
    // `CompactionCard` IS THE NINTH, and it arrived through this assertion
    // rather than around it (context-auto-compaction §6.1): the card animates
    // while a summarization is open, so it has to take `reducedMotion` like the
    // other eight, and `App` already hands every view consumer the widened value.
    // The activity row still owns the only animation while it is mounted —
    // `single-spinner-while-running` D-1 is unchanged.
    expect(spinnerFiles()).toEqual([
      'ui/ActivityLine.tsx',
      'ui/TeamPanel.tsx',
      'ui/TodoPanel.tsx',
      'ui/Transcript.tsx',
      'ui/entries/CompactionCard.tsx',
      'ui/entries/FastCard.tsx',
      'ui/entries/RetryCard.tsx',
      'ui/entries/TeamCard.tsx',
      'ui/entries/ToolCard.tsx',
    ]);
  });
});

describe('AC-11: the global status owns activity through overlays', () => {
  const app = readFileSync(join(UI, 'App.tsx'), 'utf8');
  const status = readFileSync(join(UI, 'StatusBar.tsx'), 'utf8');
  const bottom = readFileSync(join(UI, 'BottomStatusRow.tsx'), 'utf8');
  const count = (needle: string): number => app.split(needle).length - 1;

  it('passes the raw motion flag to the global status spinner', () => {
    expect(app).toMatch(/<StatusBar[\s\S]*?reducedMotion=\{reducedMotion\}/);
    expect(count('reducedMotion={reducedMotion}')).toBe(1);
    expect(status).toContain('liveSpinner(props.reducedMotion');
    expect(bottom).not.toMatch(/<ActivityLine|liveSpinner\(/);
  });

  it('passes the widened signal to all three view consumers', () => {
    expect(count('reducedMotion={viewReducedMotion}')).toBe(3);
  });

  it('suppresses other sites during starting, running and idle compaction regardless of overlay', () => {
    const expression = app.match(/const viewReducedMotion = ([^;]+);/)?.[1] ?? '';
    expect(expression).toContain('reducedMotion');
    expect(expression).toContain('running');
    expect(expression).toContain("state.runPhase === 'starting'");
    expect(expression).toContain('compactionLive');
    expect(expression).not.toMatch(/overlay/i);
    expect(app).not.toContain('const runRowShown');
  });
});
