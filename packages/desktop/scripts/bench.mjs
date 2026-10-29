#!/usr/bin/env node
// Run the desktop benchmarks and write `bench-results/<timestamp>-<platform>.json`.
//
//   node scripts/bench.mjs [--suite=startup,stream,big,soak] [--runs=N] [--stream-seconds=N] [--soak-minutes=N]
//
// The exit code reports whether the MEASUREMENT ran, never whether a budget was met: budgets are
// judged on the registered benchmark machine at release review (README, "Performance baseline"),
// not on a shared CI runner whose noise exceeds the margins being tested.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const flag = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
if (flag('suite')) env.BENCH_SUITES = flag('suite');
if (flag('runs')) env.BENCH_RUNS = flag('runs');
if (flag('stream-seconds')) env.BENCH_STREAM_SECONDS = flag('stream-seconds');
if (flag('soak-minutes')) env.BENCH_SOAK_MINUTES = flag('soak-minutes');
const result = spawnSync('npx', ['vitest', 'run', '-c', 'vitest.bench.config.ts'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32', env });
process.exit(result.status ?? 1);
