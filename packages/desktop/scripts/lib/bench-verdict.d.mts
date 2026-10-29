export interface BenchRow {
  label: string;
  value: number;
  budget: number;
  unit: string;
  verdict: 'green' | 'amber' | 'red';
}
export interface BenchReport {
  machine?: Record<string, unknown>;
  results?: Record<string, any>;
}
export function judge(report: BenchReport): BenchRow[];
export function renderTable(report: BenchReport, rows: BenchRow[], options?: { provisional?: boolean }): string;
export function exitCodeFor(rows: readonly BenchRow[], strict: boolean): 0 | 1;
