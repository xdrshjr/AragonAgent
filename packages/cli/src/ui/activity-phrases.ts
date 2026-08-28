/**
 * The working line's vocabulary (agent-activity-presentation §3.2.1).
 *
 * PURE: no React, no Ink, no clock. Everything here is a function of the two
 * numbers the caller already has, which is what makes the rotation testable
 * without a terminal and without fake timers.
 */

/** Rotation cadence. Long enough to read, short enough to prove liveness. */
export const PHRASE_ROTATE_MS = 4_000;

/**
 * ASCII ONLY, by the rule this tree is under (`glyphs.ts` header, enforced by
 * `glyphs.test.ts`'s static scan). Present participles, so the line reads as an
 * action in progress; twelve characters or fewer so the row never fights the
 * terminal's width.
 */
export const ACTIVITY_PHRASES: readonly string[] = [
  'Assembling', 'Brewing', 'Calibrating', 'Cogitating', 'Composing',
  'Computing', 'Concocting', 'Conjuring', 'Considering', 'Crunching',
  'Distilling', 'Divining', 'Drafting', 'Excavating', 'Fathoming',
  'Fermenting', 'Finessing', 'Foraging', 'Germinating', 'Herding',
  'Incubating', 'Inferring', 'Marinating', 'Meandering', 'Mulling',
  'Musing', 'Noodling', 'Percolating', 'Pondering', 'Puzzling',
  'Ruminating', 'Scheming', 'Sculpting', 'Simmering', 'Sketching',
  'Spelunking', 'Steeping', 'Stitching', 'Summoning', 'Tinkering',
  'Unfurling', 'Untangling', 'Weaving', 'Whittling', 'Wrangling',
];

/**
 * The phrase for a run at a moment.
 *
 * PURE AND TOTAL: the same inputs give the same word, for any finite numbers,
 * including a `now` before `startedAt`.
 *
 * The run's start seeds the sequence, so two consecutive runs do not open on the
 * same word — which is what makes the line read as alive rather than as a fixed
 * label. (The seed's granularity is one second, so two runs starting inside the
 * same second do share an opening word — P2-6.)
 *
 * `rotate: false` is the reduced-motion path: the word is chosen once for the run
 * and then holds. Rotating text IS motion, and a user who asked for
 * `reducedMotion` asked for the screen to stop changing under them; degrading
 * only the spinner would honor the letter of the setting and not its point.
 */
export function pickActivityPhrase(startedAt: number, now: number, rotate = true): string {
  const n = ACTIVITY_PHRASES.length;
  if (!Number.isFinite(startedAt) || !Number.isFinite(now)) return ACTIVITY_PHRASES[0]!;
  const seed = Math.floor(startedAt / 1000);
  const step = rotate ? Math.floor(Math.max(0, now - startedAt) / PHRASE_ROTATE_MS) : 0;
  return ACTIVITY_PHRASES[(((seed + step) % n) + n) % n]!;
}
