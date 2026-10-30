/**
 * Performance measurements against the real app (spec 3.2). Not run by `npm test` or `test:e2e`;
 * `npm run bench` (scripts/bench.mjs) runs it and writes `bench-results/`.
 *
 * Budgets apply on the REGISTERED benchmark machine only (README, "Performance baseline"): this
 * file always reports verdicts, and CI uploads the report without failing on it.
 *
 *   B-1 startup      launch -> window shown; click "recent" -> composer ready
 *   B-2 streaming    P95 frame time and the longest task while the model streams at 200 tokens/s
 *   B-3 big session  first paint of a transcript of 5,000 entries
 *   B-4 soak         renderer + host memory slope over a loop of turns
 *   B-5 checkpoint   writing a session file that holds eight ~1 MiB pictures (the engine's own writer)
 */
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { arch as osArch, cpus, release as osRelease, tmpdir, totalmem, type as osType } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { BUDGETS, frameDurations, percentile, slope, verdict } from '../../scripts/lib/bench-math.mjs';
import { writeBigSession } from '../e2e/fixtures/big-session.js';
import { launchApp } from '../e2e/fixtures/launch.js';

const suites = (process.env.BENCH_SUITES ?? 'startup,stream,big,soak,checkpoint').split(',');
const runs = Number(process.env.BENCH_RUNS ?? 5);
const streamSeconds = Number(process.env.BENCH_STREAM_SECONDS ?? 10);
const soakMinutes = Number(process.env.BENCH_SOAK_MINUTES ?? 1);
const results: Record<string, unknown> = {};

const when = (suite: string) => (suites.includes(suite) ? it : it.skip);

function electronVersion(): string {
  try { return (createRequire(import.meta.url)('electron/package.json') as { version: string }).version; } catch { return 'unknown'; }
}

/** Enough to tell two benchmark machines apart (and a provisional registration from a real one). */
function machine(): Record<string, unknown> {
  return {
    cpu: cpus()[0]?.model ?? 'unknown', cores: cpus().length, memoryGb: Math.round(totalmem() / 2 ** 30),
    platform: process.platform, os: `${osType()} ${osArch()}`, osBuild: osRelease(), electron: electronVersion(), node: process.versions.node,
  };
}

describe('desktop benchmarks', () => {
  when('startup')('B-1 startup', async () => {
    const shown: number[] = [];
    const ready: number[] = [];
    for (let run = 0; run < runs; run += 1) {
      const t0 = performance.now();
      const app = await launchApp({ turns: [] });
      shown.push(performance.now() - t0);
      const t1 = performance.now();
      await app.openWorkspace();
      ready.push(performance.now() - t1);
      await app.close();
    }
    results['B-1'] = {
      windowShownMs: { p50: percentile(shown, 50), p95: percentile(shown, 95), samples: shown },
      firstInputMs: { p50: percentile(ready, 50), p95: percentile(ready, 95), samples: ready },
      verdicts: { windowShown: verdict(percentile(shown, 95), BUDGETS.readyToShowP95Ms), firstInput: verdict(percentile(ready, 95), BUDGETS.firstInputP95Ms) },
      note: 'windowShown includes process spawn and Playwright attach, so it over-reads the in-app ready-to-show figure.',
    };
  }, 10 * 60_000);

  when('stream')('B-2 streaming at 200 tokens/s', async () => {
    const pieces = Array.from({ length: streamSeconds * 50 }, () => 'word '.repeat(4)); // 20 chars ~ 5 tokens
    const app = await launchApp({ turns: [{ deltas: pieces, tokensPerSecond: 200 }] });
    await app.openWorkspace();
    await app.window.evaluate(() => {
      const w = window as unknown as { __frames: number[]; __long: number[] };
      w.__frames = []; w.__long = [];
      const tick = (time: number) => { w.__frames.push(time); requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
      new PerformanceObserver((list) => { for (const entry of list.getEntries()) w.__long.push(entry.duration); }).observe({ entryTypes: ['longtask'] });
    });
    await app.send('stream a lot');
    await app.window.getByRole('log').getByText(/word word/).first().waitFor({ timeout: 30_000 });
    await app.window.waitForTimeout(streamSeconds * 1000);
    const { frames, long } = await app.window.evaluate(() => {
      const w = window as unknown as { __frames: number[]; __long: number[] };
      return { frames: w.__frames, long: w.__long };
    });
    const durations = frameDurations(frames);
    results['B-2'] = {
      frames: durations.length, frameP50Ms: percentile(durations, 50), frameP95Ms: percentile(durations, 95), longestTaskMs: long.length ? Math.max(...long) : 0,
      verdicts: { frameP95: verdict(percentile(durations, 95), BUDGETS.frameP95Ms), longTask: verdict(long.length ? Math.max(...long) : 0, BUDGETS.longTaskMaxMs) },
    };
    // Closing while the reply is still streaming raises the app's "Quit? 1 session is still working" dialog and
    // `app.close()` then waits for a person to answer it - forever (found when this run hung for 300 s and left
    // an orphan that made the next benchmarks fail to launch). Let the reply finish first.
    await app.window.getByRole('button', { name: 'Stop', exact: true }).waitFor({ state: 'hidden', timeout: 120_000 }).catch(() => undefined);
    await app.close();
  }, 5 * 60_000);

  when('big')('B-3 a 5,000-entry session', async () => {
    const app = await launchApp({ turns: [], seed: ({ home }) => { writeBigSession(home, 'bigsession1', 5000); } });
    try {
      const row = app.window.getByRole('button', { name: /Untitled session/ }).first();
      await row.waitFor({ timeout: 60_000 });
      const t0 = performance.now();
      await row.click();
      await app.window.locator('.row').first().waitFor({ timeout: 60_000 });
      await app.window.getByText(/earlier entries were trimmed/).waitFor({ timeout: 60_000 });
      const firstPaintMs = performance.now() - t0;
      const mounted = await app.window.locator('.row').count();
      results['B-3'] = {
        firstPaintMs, rowsMounted: mounted, verdict: verdict(firstPaintMs, BUDGETS.bigTranscriptFirstPaintMs),
        note: 'the view keeps the newest 1000 entries (older ones are trimmed and announced) and only a bounded window of rows is mounted, so the cost does not grow with the transcript',
      };
    } finally {
      await app.close();
    }
  }, 5 * 60_000);

  when('soak')('B-4 memory soak', async () => {
    const turns = Array.from({ length: soakMinutes * 20 }, () => ({ deltas: ['A reply of moderate length. '.repeat(8)] }));
    const app = await launchApp({ turns });
    await app.openWorkspace();
    const points: Array<[number, number]> = [];
    const started = Date.now();
    /** Total working set of every Electron process, in KILOBYTES (Electron's unit). */
    const sample = async (): Promise<number> => app.evaluate(({ app: electron }) => electron.getAppMetrics().reduce((sum, metric) => sum + (metric.memory?.workingSetSize ?? 0), 0));
    const baseline = await sample();
    // The mock answers instantly, so without pacing 100 turns take ~25 s and the "5 minute" soak measures warm-up
    // only (the first report of this suite did exactly that: 1,538 MB/min over 25 s). Spread the turns over the
    // requested window so the slope is a slope.
    const pace = (soakMinutes * 60_000) / turns.length;
    for (let turn = 0; turn < turns.length && Date.now() - started < soakMinutes * 60_000; turn += 1) {
      await app.send(`turn ${turn}`);
      await app.window.getByRole('log').getByText(/A reply of moderate length/).last().waitFor({ timeout: 30_000 });
      points.push([(Date.now() - started) / 60_000, (await sample()) / 1024]);
      const wait = started + (turn + 1) * pace - Date.now();
      if (wait > 0) await app.window.waitForTimeout(wait);
    }
    const elapsedMinutes = (Date.now() - started) / 60_000;
    const perMinute = slope(points);
    // Informational: the slope of the second half only, i.e. after the process has warmed up. The verdict stays on
    // the whole-run slope (the budget as written); this is here so a red can be read as "warm-up" or "keeps growing".
    const steady = slope(points.slice(Math.floor(points.length / 2)));
    results['B-4'] = {
      minutes: soakMinutes, elapsedMinutes, warmupDominated: elapsedMinutes < 5, turns: points.length, baselineMb: baseline / 1024,
      endMb: points.at(-1)?.[1] ?? 0, slopeMbPerMin: perMinute, steadySlopeMbPerMin: steady, verdict: verdict(perMinute, BUDGETS.soakSlopeMbPerMin, 0),
    };
    await app.close();
  }, (soakMinutes + 5) * 60_000);

  when('checkpoint')('B-5 a checkpoint holding eight pictures', async () => {
    // The engine's own session writer, with pictures in the history the way a long screenshot-heavy
    // session has them. An image is kept inline in the file, so this is what every turn end pays.
    const { saveSession } = await import('@aragon-agent/cli/dist/session/persist.js');
    const dir = mkdtempSync(join(tmpdir(), 'aragon-bench-ckpt-'));
    const picture = Buffer.alloc(1024 * 1024, 7).toString('base64'); // ~1.33 MiB of base64 text per picture
    const messages = Array.from({ length: 8 }, (_unused, index) => ({
      role: 'user' as const,
      content: [{ type: 'text' as const, text: `screenshot ${index + 1}` }, { type: 'image' as const, mediaType: 'image/png', data: picture }],
    }));
    const samples: number[] = [];
    let bytes = 0;
    try {
      for (let run = 0; run < Math.max(runs, 5); run += 1) {
        const file = join(dir, `ckpt-${run}.json`);
        const t0 = performance.now();
        saveSession(file, { model: { providerId: 'acme', modelId: 'm-1' }, messages: messages as never, entries: [], todos: [] });
        samples.push(performance.now() - t0);
        bytes = statSync(file).size;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    results['B-5'] = {
      pictures: 8, fileMb: Math.round((bytes / 2 ** 20) * 10) / 10,
      writeMs: { p50: percentile(samples, 50), p95: percentile(samples, 95), samples },
      verdict: verdict(percentile(samples, 95), BUDGETS.checkpointWithImagesMs),
      note: 'If this is over budget the follow-up is to keep pictures out of the checkpoint (reference a staged copy and re-read it on resume); that changes the session file and needs its own design.',
    };
  }, 120_000);

  it('writes the report', () => {
    const dir = join(process.cwd(), 'bench-results');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.platform}.json`);
    writeFileSync(file, JSON.stringify({ machine: machine(), parameters: { runs, streamSeconds, soakMinutes, suites }, results }, null, 2));
    process.stdout.write(`bench report: ${file}\n`);
  });
});
