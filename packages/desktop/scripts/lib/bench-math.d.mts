export function percentile(samples: readonly number[], p: number): number;
export function verdict(value: number, budget: number, tolerance?: number): 'green' | 'amber' | 'red';
export function slope(points: ReadonlyArray<readonly [number, number]>): number;
export function frameDurations(timestamps: readonly number[]): number[];
export const BUDGETS: {
  readonly readyToShowP95Ms: number;
  readonly firstInputP95Ms: number;
  readonly frameP95Ms: number;
  readonly longTaskMaxMs: number;
  readonly bigTranscriptFirstPaintMs: number;
  readonly soakSlopeMbPerMin: number;
  readonly checkpointWithImagesMs: number;
};
