export interface CaseCounts {
  passed: number;
  failed: number;
  skipped: number;
}
export interface Aggregated {
  cases: Map<string, CaseCounts>;
  runs: number;
}
export interface RepeatSummary {
  runs: number;
  cases: number;
  allGreen: number;
  skipped: number;
  flaky: Array<{ id: string } & CaseCounts>;
  ok: boolean;
}
export function caseId(file: string, assertion: { ancestorTitles?: string[]; title: string }): string;
export function aggregate(reports: ReadonlyArray<Record<string, any>>): Aggregated;
export function flaky(aggregated: Aggregated): Array<{ id: string } & CaseCounts>;
export function summarize(aggregated: Aggregated): RepeatSummary;
export function renderSummary(summary: RepeatSummary): string;
