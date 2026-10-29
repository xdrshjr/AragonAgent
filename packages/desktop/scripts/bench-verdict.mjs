#!/usr/bin/env node
// node scripts/bench-verdict.mjs <report.json> [--strict]
//
// Prints a markdown table of the report's figures against the budgets. The default exit code is 0 (the
// table is information); with --strict any red row - or a report with nothing to judge - exits 1.
import { readFileSync } from 'node:fs';
import { exitCodeFor, judge, renderTable } from './lib/bench-verdict.mjs';

const args = process.argv.slice(2);
const path = args.find((arg) => !arg.startsWith('--'));
if (!path) {
  console.error('usage: bench-verdict.mjs <report.json> [--strict]');
  process.exit(2);
}
let report;
try {
  report = JSON.parse(readFileSync(path, 'utf8'));
} catch (error) {
  console.error(`bench-verdict: cannot read ${path}: ${error.message}`);
  process.exit(2);
}
const rows = judge(report);
console.log(renderTable(report, rows));
process.exit(exitCodeFor(rows, args.includes('--strict')));
