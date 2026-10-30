// The arithmetic of the benchmarks, apart from the benchmarks: percentiles, the green/amber/red
// verdict against a budget, and a least-squares slope for the memory soak. Pure, so it is unit-tested
// (test/bench-math.test.ts) and a wrong verdict cannot hide behind a slow Electron run.

/** Nearest-rank percentile (p in 0..100). `NaN` for an empty sample: no data is not "zero". */
export function percentile(samples, p) {
  if (samples.length === 0) return Number.NaN;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(sorted.length, rank) - 1];
}

/**
 * green: within budget. amber: over by at most `tolerance` (default 20%). red: more than that.
 * A missing measurement is red - an unmeasured budget has not been met.
 */
export function verdict(value, budget, tolerance = 0.2) {
  if (!Number.isFinite(value)) return 'red';
  if (value <= budget) return 'green';
  return value <= budget * (1 + tolerance) ? 'amber' : 'red';
}

/** Slope (units of y per unit of x) of the best straight line through the points; 0 for fewer than 2. */
export function slope(points) {
  if (points.length < 2) return 0;
  const n = points.length;
  const mx = points.reduce((sum, [x]) => sum + x, 0) / n;
  const my = points.reduce((sum, [, y]) => sum + y, 0) / n;
  let num = 0;
  let den = 0;
  for (const [x, y] of points) { num += (x - mx) * (y - my); den += (x - mx) ** 2; }
  return den === 0 ? 0 : num / den;
}

/** Frame durations (ms) from successive timestamps. */
export function frameDurations(timestamps) {
  const out = [];
  for (let index = 1; index < timestamps.length; index += 1) out.push(timestamps[index] - timestamps[index - 1]);
  return out;
}

/** Budgets from the spec (AC-47..AC-50). They only apply on the registered benchmark machine. */
export const BUDGETS = {
  readyToShowP95Ms: 400,
  firstInputP95Ms: 1500,
  frameP95Ms: 16.7,
  longTaskMaxMs: 100,
  bigTranscriptFirstPaintMs: 1000,
  soakSlopeMbPerMin: 2,
  /** Writing a session checkpoint that holds eight ~1 MiB pictures (attachments R-1). */
  checkpointWithImagesMs: 150,
};
