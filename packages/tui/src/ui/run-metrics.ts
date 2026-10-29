/** UI-only metrics. Feed only the existing generation-guarded main subscription. */
export interface RunMetrics {
  runId: number;
  startedAt: number | null;
  endedAt: number | null;
  outputTokens: number;
  usageKnown: boolean;
}
export interface RunMetricsEvent { type: string; usage?: { outputTokens?: number } }
export interface RunMetricsProjection { elapsedMs: number; tokPerSec: number; speedKnown: boolean }
export function createRunMetrics(): RunMetrics {
  return { runId: 0, startedAt: null, endedAt: null, outputTokens: 0, usageKnown: false };
}
export function freezeRunMetrics(state: RunMetrics, now: number): RunMetrics {
  if (state.startedAt === null || state.endedAt !== null) return state;
  return { ...state, endedAt: Number.isFinite(now) ? Math.max(state.startedAt, now) : state.startedAt };
}
export function updateRunMetrics(state: RunMetrics, event: RunMetricsEvent, now: number): RunMetrics {
  if (event.type === 'agent_start') return { ...createRunMetrics(), runId: state.runId + 1,
    startedAt: Number.isFinite(now) ? now : 0 };
  if (state.startedAt === null || state.endedAt !== null) return state;
  if (event.type === 'agent_end' || event.type === 'error') return freezeRunMetrics(state, now);
  const output = event.usage?.outputTokens;
  if (event.type !== 'turn_end' || output === undefined || !Number.isFinite(output) || output < 0) return state;
  return { ...state, outputTokens: Math.min(Number.MAX_VALUE, state.outputTokens + output), usageKnown: true };
}
export function projectRunMetrics(state: RunMetrics, now: number): RunMetricsProjection {
  const end = state.endedAt ?? (Number.isFinite(now) ? now : state.startedAt ?? 0);
  const elapsedMs = state.startedAt === null ? 0 : Math.max(0, end - state.startedAt);
  const speedKnown = state.startedAt !== null && state.endedAt === null && state.usageKnown && elapsedMs > 500;
  return { elapsedMs, speedKnown, tokPerSec: speedKnown ? state.outputTokens / (elapsedMs / 1000) : 0 };
}
