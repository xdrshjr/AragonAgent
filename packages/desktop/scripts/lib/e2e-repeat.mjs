// Aggregate several Vitest JSON reports of the SAME E2E suite into a per-case pass count, and name the
// cases that did not pass every time. A case that passes 2 of 3 is a FLAKY case, and the run fails: the
// fix is to repair the test or the product, never to raise a timeout (README, "E2E").
export function caseId(file, assertion) {
  const name = String(file).replace(/\\/g, '/').split('/').pop();
  return `${name}::${[...(assertion.ancestorTitles ?? []), assertion.title].join(' > ')}`;
}

/** `{ cases: Map<id, { passed, failed, skipped }>, runs }` */
export function aggregate(reports) {
  const cases = new Map();
  const bump = (id, key) => {
    const entry = cases.get(id) ?? { passed: 0, failed: 0, skipped: 0 };
    entry[key] += 1;
    cases.set(id, entry);
  };
  for (const report of reports) {
    for (const file of report.testResults ?? []) {
      if ((file.assertionResults ?? []).length === 0 && file.status === 'failed') {
        bump(`${String(file.name).replace(/\\/g, '/').split('/').pop()}::(suite failed to load)`, 'failed');
      }
      for (const assertion of file.assertionResults ?? []) {
        const key = assertion.status === 'passed' ? 'passed' : assertion.status === 'failed' ? 'failed' : 'skipped';
        bump(caseId(file.name, assertion), key);
      }
    }
  }
  return { cases, runs: reports.length };
}

/** Cases that did not pass in every run (skipped ones are counted separately; they are not flaky). */
export function flaky(aggregated) {
  return [...aggregated.cases]
    .filter(([, entry]) => entry.failed > 0 || (entry.passed > 0 && entry.passed + entry.skipped < aggregated.runs))
    .map(([id, entry]) => ({ id, ...entry }));
}

export function summarize(aggregated) {
  const list = [...aggregated.cases];
  const bad = flaky(aggregated);
  return {
    runs: aggregated.runs,
    cases: list.length,
    allGreen: list.filter(([, entry]) => entry.passed === aggregated.runs).length,
    skipped: list.filter(([, entry]) => entry.skipped > 0).length,
    flaky: bad,
    ok: aggregated.runs > 0 && list.length > 0 && bad.length === 0,
  };
}

export function renderSummary(summary) {
  const lines = [`E2E repeat: ${summary.runs} run(s), ${summary.cases} case(s), ${summary.allGreen} passed every time, ${summary.skipped} skipped`];
  if (summary.flaky.length > 0) {
    lines.push('', 'FLAKY (did not pass in every run):');
    for (const entry of summary.flaky) lines.push(`  ${entry.passed}/${summary.runs} passed, ${entry.failed} failed  ${entry.id}`);
  }
  lines.push('', summary.ok ? 'result: OK' : 'result: FAILED');
  return lines.join('\n');
}
