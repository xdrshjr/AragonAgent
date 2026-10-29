// Turn a bench report into a green / amber / red table against the budgets in README
// ("Performance baseline"). Pure, so a wrong verdict cannot hide behind a slow Electron run.
// The verdict is RECOMPUTED from the raw numbers with the budgets in bench-math, never copied from the
// report's own `verdict` fields: a report written by an older build must not be able to vouch for itself.
import { BUDGETS, verdict } from './bench-math.mjs';

const TOLERANCE_SOAK = 0; // the soak budget is a hard slope limit, as in the benchmark itself

/** Every budgeted figure a report may contain: [row label, path into `results`, budget, unit, tolerance]. */
const ROWS = [
  ['B-1 window shown (P95)', ['B-1', 'windowShownMs', 'p95'], BUDGETS.readyToShowP95Ms, 'ms'],
  ['B-1 first input (P95)', ['B-1', 'firstInputMs', 'p95'], BUDGETS.firstInputP95Ms, 'ms'],
  ['B-2 frame time (P95)', ['B-2', 'frameP95Ms'], BUDGETS.frameP95Ms, 'ms'],
  ['B-2 longest task', ['B-2', 'longestTaskMs'], BUDGETS.longTaskMaxMs, 'ms'],
  ['B-3 5,000-entry first paint', ['B-3', 'firstPaintMs'], BUDGETS.bigTranscriptFirstPaintMs, 'ms'],
  ['B-4 memory slope', ['B-4', 'slopeMbPerMin'], BUDGETS.soakSlopeMbPerMin, 'MB/min', TOLERANCE_SOAK],
];

const dig = (object, path) => path.reduce((value, key) => (value && typeof value === 'object' ? value[key] : undefined), object);

/** `[{ label, value, budget, unit, verdict }]` for the figures present in `report`; absent suites are skipped. */
export function judge(report) {
  const rows = [];
  for (const [label, path, budget, unit, tolerance] of ROWS) {
    const value = dig(report.results ?? {}, path);
    if (value === undefined) continue;
    rows.push({ label, value, budget, unit, verdict: verdict(Number(value), budget, tolerance ?? 0.2) });
  }
  return rows;
}

const fmt = (value) => (Number.isFinite(Number(value)) ? Number(value).toFixed(1) : 'n/a');

export function renderTable(report, rows, { provisional = true } = {}) {
  const machine = report.machine ?? {};
  const where = [
    machine.cpu ?? 'unknown', `${machine.cores ?? '?'} cores`, `${machine.memoryGb ?? '?'} GB`,
    `${machine.os ?? machine.platform ?? '?'}${machine.osBuild ? ` ${machine.osBuild}` : ''}`,
    `Electron ${machine.electron ?? '?'}`, `Node ${machine.node ?? '?'}`,
  ].join(' · ');
  const lines = [
    `Machine: ${where}${provisional ? ' (provisional)' : ''}`,
    '',
    '| Figure | Measured | Budget | Verdict |',
    '|---|---|---|---|',
    ...rows.map((row) => `| ${row.label} | ${fmt(row.value)} ${row.unit} | ${row.budget} ${row.unit} | ${row.verdict} |`),
  ];
  const soak = report.results?.['B-4'];
  if (soak?.warmupDominated) {
    const ran = Number(soak.elapsedMinutes ?? soak.minutes);
    lines.push('', `Note: the soak ran ${Number.isFinite(ran) ? ran.toFixed(1) : '?'} minute(s); under 5 minutes the slope is dominated by warm-up and is not a leak measurement.`);
  }
  if (soak && Number.isFinite(Number(soak.steadySlopeMbPerMin))) {
    lines.push('', `Steady-state slope (second half of the soak, informational): ${Number(soak.steadySlopeMbPerMin).toFixed(1)} MB/min. The verdict above uses the whole-run slope, as the budget is written.`);
  }
  return lines.join('\n');
}

/** Process exit code: 0 unless `strict` and some row is red (or there is nothing to judge in strict mode). */
export function exitCodeFor(rows, strict) {
  if (!strict) return 0;
  return rows.length === 0 || rows.some((row) => row.verdict === 'red') ? 1 : 0;
}
