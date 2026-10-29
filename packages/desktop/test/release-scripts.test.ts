/** AC-90 (manifest generator), AC-87 (bench verdict) and the E2E repeat aggregation (AC-85). */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseManifest } from '../src/main/update-service.js';
import { exitCodeFor, judge, renderTable } from '../scripts/lib/bench-verdict.mjs';
import { aggregate, flaky, renderSummary, summarize } from '../scripts/lib/e2e-repeat.mjs';
import {
  assertHttpsBase, buildManifest, findArtifacts, platformOf, readBack, sha256File,
} from '../scripts/lib/update-manifest.mjs';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(os.tmpdir(), 'aragon-rel-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('update manifest generator', () => {
  it('hashes real files, and the result is accepted by the app parser (read back)', async () => {
    writeFileSync(join(dir, 'AragonAgent-Setup-1.2.0.exe'), 'installer bytes');
    writeFileSync(join(dir, 'notes.txt'), 'not an installer');
    const names = findArtifacts(dir);
    expect(names).toEqual(['AragonAgent-Setup-1.2.0.exe']);
    const sha256 = await sha256File(join(dir, names[0]!));
    expect(sha256).toBe(createHash('sha256').update('installer bytes').digest('hex'));

    const manifest = buildManifest({
      version: '1.2.0', baseUrl: 'https://downloads.example.com/aragon/', notesUrl: 'https://downloads.example.com/notes',
      artifacts: [{ name: names[0]!, sha256, size: 15 }],
    });
    const parsed = readBack(manifest, 'https://downloads.example.com/aragon/', parseManifest);
    expect(parsed.version).toBe('1.2.0');
    expect(parsed.downloadUrl).toBe('https://downloads.example.com/aragon/AragonAgent-Setup-1.2.0.exe');
    expect(parsed.notesUrl).toBe('https://downloads.example.com/notes');
    expect(manifest.artifacts[0]).toMatchObject({ platform: 'win', sha256, size: 15 });
  });

  it('with several installers the download link is the base address (the parser carries one link)', () => {
    const manifest = buildManifest({
      version: '1.2.0', baseUrl: 'https://d.example.com/x/',
      artifacts: [{ name: 'a.exe', sha256: 'a'.repeat(64), size: 1 }, { name: 'b.dmg', sha256: 'b'.repeat(64), size: 2 }],
    });
    expect(manifest.downloadUrl).toBe('https://d.example.com/x/');
    expect(readBack(manifest, 'https://d.example.com/x/', parseManifest).downloadUrl).toBe('https://d.example.com/x/');
  });

  it('refuses a non-https base URL, one with credentials, and one that is not a URL', () => {
    expect(() => assertHttpsBase('http://d.example.com/')).toThrow(/https/);
    expect(() => assertHttpsBase('ftp://d.example.com/')).toThrow(/https/);
    expect(() => assertHttpsBase('https://user:pw@d.example.com/')).toThrow(/credentials/);
    expect(() => assertHttpsBase('not a url')).toThrow(/not a URL/);
    expect(() => buildManifest({ version: '1.0.0', baseUrl: 'http://d.example.com/', artifacts: [] })).toThrow(/https/);
  });

  it('a missing directory or one with no installers is an error naming the problem', () => {
    expect(() => findArtifacts(join(dir, 'nope'))).toThrow(/not found/);
    writeFileSync(join(dir, 'readme.md'), 'x');
    expect(() => findArtifacts(dir)).toThrow(/no installer artifacts/);
  });

  it('read-back catches a manifest the parser would reject (bad version)', () => {
    const manifest = buildManifest({ version: 'one.two', baseUrl: 'https://d.example.com/', artifacts: [{ name: 'a.exe', sha256: 'a'.repeat(64), size: 1 }] });
    expect(() => readBack(manifest, 'https://d.example.com/', parseManifest)).toThrow(/rejected/);
  });

  it('knows installer extensions case-insensitively', () => {
    expect(platformOf('X.AppImage')).toBe('linux');
    expect(platformOf('X.DMG')).toBe('mac');
    expect(platformOf('x.zip')).toBeNull();
  });
});

describe('bench verdict', () => {
  const report = (results: Record<string, unknown>) => ({ machine: { cpu: 'Test CPU', cores: 8, memoryGb: 16, platform: 'win32', os: 'win32', osBuild: '10.0.1', electron: '45.1.0', node: '22' }, results });

  it('recomputes verdicts from the raw numbers, ignoring the verdict fields in the report', () => {
    const rows = judge(report({
      'B-1': { windowShownMs: { p95: 390 }, firstInputMs: { p95: 1700 }, verdicts: { windowShown: 'red', firstInput: 'green' } },
      'B-3': { firstPaintMs: 1300, verdict: 'green' },
      'B-4': { slopeMbPerMin: 0.5, verdict: 'red' },
    }));
    const byLabel = Object.fromEntries(rows.map((row) => [row.label, row.verdict]));
    expect(byLabel['B-1 window shown (P95)']).toBe('green');
    expect(byLabel['B-1 first input (P95)']).toBe('amber'); // 1700 vs 1500 budget: over by 13%
    expect(byLabel['B-3 5,000-entry first paint']).toBe('red'); // 30% over
    expect(byLabel['B-4 memory slope']).toBe('green');
  });

  it('the soak slope has no tolerance band: over budget is red at once', () => {
    expect(judge(report({ 'B-4': { slopeMbPerMin: 2.1 } }))[0]!.verdict).toBe('red');
  });

  it('exits 0 by default and 1 only with --strict and a red row (or nothing to judge)', () => {
    const reds = judge(report({ 'B-3': { firstPaintMs: 5000 } }));
    expect(exitCodeFor(reds, false)).toBe(0);
    expect(exitCodeFor(reds, true)).toBe(1);
    expect(exitCodeFor(judge(report({ 'B-3': { firstPaintMs: 500 } })), true)).toBe(0);
    expect(exitCodeFor([], true)).toBe(1);
  });

  it('the table names the machine, marks it provisional and warns about a short soak', () => {
    const data = report({ 'B-4': { minutes: 5, elapsedMinutes: 0.4, warmupDominated: true, slopeMbPerMin: 1, steadySlopeMbPerMin: 0.5 } });
    const text = renderTable(data, judge(data));
    expect(text).toContain('Test CPU');
    expect(text).toContain('(provisional)');
    expect(text).toMatch(/\| B-4 memory slope \| 1\.0 MB\/min \| 2 MB\/min \| green \|/);
    expect(text).toContain('dominated by warm-up');
    expect(text).toContain('the soak ran 0.4 minute(s)');
    expect(text).toContain('Steady-state slope');
  });

  it('a missing or non-numeric measurement is red, never green', () => {
    expect(judge(report({ 'B-3': { firstPaintMs: Number.NaN } }))[0]!.verdict).toBe('red');
  });
});

describe('e2e repeat aggregation', () => {
  const run = (statuses: Record<string, string>) => ({
    testResults: [{ name: 'C:\\x\\test\\e2e\\a.e2e.ts', status: 'passed', assertionResults: Object.entries(statuses).map(([title, status]) => ({ ancestorTitles: ['suite'], title, status })) }],
  });

  it('all green in every run is OK', () => {
    const summary = summarize(aggregate([run({ one: 'passed', two: 'passed' }), run({ one: 'passed', two: 'passed' }), run({ one: 'passed', two: 'passed' })]));
    expect(summary).toMatchObject({ runs: 3, cases: 2, allGreen: 2, ok: true });
    expect(renderSummary(summary)).toContain('result: OK');
  });

  it('a case that passes 2 of 3 is named as flaky and fails the run', () => {
    const aggregated = aggregate([run({ one: 'passed', two: 'passed' }), run({ one: 'passed', two: 'failed' }), run({ one: 'passed', two: 'passed' })]);
    expect(flaky(aggregated).map((entry) => entry.id)).toEqual(['a.e2e.ts::suite > two']);
    const summary = summarize(aggregated);
    expect(summary.ok).toBe(false);
    expect(renderSummary(summary)).toContain('2/3 passed, 1 failed  a.e2e.ts::suite > two');
  });

  it('a skipped case is not flaky; a suite that failed to load is a failure; no data is not OK', () => {
    expect(summarize(aggregate([run({ one: 'passed', two: 'skipped' }), run({ one: 'passed', two: 'skipped' })])).ok).toBe(true);
    const broken = { testResults: [{ name: 'b.e2e.ts', status: 'failed', assertionResults: [] }] };
    expect(summarize(aggregate([broken])).ok).toBe(false);
    expect(summarize(aggregate([])).ok).toBe(false);
  });
});
