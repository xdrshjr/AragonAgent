#!/usr/bin/env node
// npm run test:e2e:repeat -- --runs=3
//
// Runs the whole E2E suite N times in a row and fails when any case does not pass every time. Each run
// writes test-results/repeat-<k>.json (Vitest's JSON reporter); the summary says which cases flaked.
// `ARAGON_E2E_APP=<exe>` points it at a packaged E2E-flavor build, as for a single run.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregate, renderSummary, summarize } from './lib/e2e-repeat.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const flag = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const runs = Math.max(1, Number(flag('runs') ?? process.env.E2E_REPEAT ?? 1) || 1);
const filter = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const results = join(root, 'test-results');
mkdirSync(results, { recursive: true });

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const reports = [];
for (let run = 1; run <= runs; run += 1) {
  const out = join(results, `repeat-${run}.json`);
  console.log(`\n== E2E run ${run} of ${runs}`);
  const result = spawnSync(
    'npx',
    ['vitest', 'run', '-c', 'vitest.e2e.config.ts', '--reporter=default', '--reporter=json', `--outputFile.json=${out}`, ...filter],
    { cwd: root, stdio: 'inherit', shell: process.platform === 'win32', env },
  );
  try {
    reports.push(JSON.parse(readFileSync(out, 'utf8')));
  } catch {
    console.error(`e2e-repeat: run ${run} produced no report (vitest exit ${result.status})`);
    process.exit(1);
  }
}
const summary = summarize(aggregate(reports));
const text = renderSummary(summary);
console.log(`\n${text}`);
writeFileSync(join(results, 'repeat-summary.txt'), `${text}\n`);
process.exit(summary.ok ? 0 : 1);
