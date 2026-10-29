/**
 * The connection probe behind `Test connection` and `Discover models`
 * (model-profile-connection-test §4.2-§4.8).
 *
 * WHY THIS IS NOT `ModelRegistry.discoverModels()`: that path folds every exception
 * into `[]` and stores the result in a five-minute process-wide cache. Using it here
 * would (a) collapse "wrong key", "wrong URL" and "this account owns no models" into
 * one sentence, and (b) let a probe of an UNSAVED draft endpoint poison `/model`,
 * `/context` and the main session's window resolution for five minutes. So the probe
 * talks to the adapter directly and classifies by `LLMError.errorType`.
 *
 * WHY `complete()` AND NOT ONLY `listModels()`: a model can be listed and still be
 * unable to generate (gateway aliases, permission layers). One real round trip is the
 * only honest answer to "does this work right now", and it is also the only evidence
 * that can produce `model_not_found`.
 *
 * ASCII ONLY: `agent/` is inside `glyphs.test.ts::inScope`.
 */

import { createHash } from 'node:crypto';
import {
  LLMError,
  MIN_MAX_OUTPUT_TOKENS,
  classifyOutputLimitFailure,
  type AssistantMessage,
  type LLMProvider,
  type ModelInfo,
  type ProviderRegistry,
} from '@aragon-agent/core';
import { isValidEndpointUrl } from '../config/model-profiles.js';
import { getTuiLogger } from '../logging/log-port.js';
import { PROBE_LIMITS } from './model-probe-limits.js';

/** Every way a probe can fail, once and for all (§7). */
export type ProbeFailureKind =
  | 'missing_key' | 'unsupported_provider' | 'invalid_base_url'
  | 'auth' | 'model_not_found' | 'invalid_request'
  | 'rate_limit' | 'provider_unavailable'
  | 'network' | 'timeout' | 'cancelled' | 'unknown';

export interface ProbeTarget {
  provider: string;
  /** `''` means "no model typed yet" - the probe then only lists models. */
  model: string;
  baseUrl: string | null;
  /** The RESOLVED plaintext key from `resolveDraftKey()`, never `editor.apiKey`. */
  apiKey: string | null;
}

export interface ProbeRequest extends ProbeTarget {
  signal?: AbortSignal;
}

export interface ProbeOutcome {
  ok: boolean;
  /** Fingerprint of the target this outcome describes (§4.6). */
  targetId: string;
  latencyMs: number;
  kind?: ProbeFailureKind;
  /** Locally composed, already redacted sentence. Never provider response text. */
  detail?: string;
  reply?: string;
  usage?: { inputTokens: number; outputTokens: number };
  availableModels?: number;
  modelListed?: boolean;
}

export interface ModelCandidate {
  id: string;
  name: string;
  contextWindow?: number;
  supportsTools: boolean;
}

export interface DiscoveryOutcome {
  ok: boolean;
  connectionId: string;
  kind?: ProbeFailureKind;
  detail?: string;
  models: ModelCandidate[];
  truncated: boolean;
  /**
   * How many models the endpoint returned BEFORE truncation. The truncation line
   * needs the real number ("Showing first 400 of 960"), and re-deriving it from a
   * clamped array is impossible.
   */
  total?: number;
}

export interface ModelProbe {
  test(request: ProbeRequest): Promise<ProbeOutcome>;
  discover(request: ProbeRequest): Promise<DiscoveryOutcome>;
  targetFingerprint(target: ProbeTarget): string;
  connectionFingerprint(target: ProbeTarget): string;
}

export interface ProbeDeps {
  registry: Pick<ProviderRegistry, 'get'>;
  /** Injected clock; tests pin `latencyMs` through it. */
  now?: () => number;
}

/** `Reply with the single word OK.` - one isolated call, no tools, no system prompt. */
const PROBE_PROMPT = 'Reply with the single word OK.';
const UNKNOWN_DETAIL = 'The provider failed in an unrecognized way.';
const NO_KEY_DETAIL_SUFFIX = ' Set one here or in the environment.';

/**
 * Which key this draft would actually use (§4.2.1).
 *
 * The editor's `apiKey` field is ALWAYS the empty string: it is the replacement
 * input, not the live credential. `finishProfileEditor` resolves `keep` to the
 * saved entry key and `shared` to `null`, and the runtime then falls back to the
 * shared per-provider key. Without this table the most common path - editing an
 * existing profile, whose credential mode defaults to `keep` - would report
 * `(no key)` for a profile that has one.
 */
export function resolveDraftKey(input: {
  credentialMode: 'keep' | 'replace' | 'shared';
  draftKey: string;
  existingKey: string | null;
  sharedKey?: string;
}): string | null {
  const nonEmpty = (value: string | null | undefined): string | null =>
    value && value.trim().length > 0 ? value.trim() : null;
  if (input.credentialMode === 'replace') return nonEmpty(input.draftKey);
  if (input.credentialMode === 'keep') {
    return nonEmpty(input.existingKey) ?? nonEmpty(input.sharedKey);
  }
  return nonEmpty(input.sharedKey);
}

/** Trailing slashes are not part of an endpoint's identity. */
function normalizeBaseUrl(baseUrl: string | null): string | null {
  const trimmed = (baseUrl ?? '').trim();
  if (trimmed.length === 0) return null;
  return trimmed.replace(/\/+$/, '');
}

function keyDigest(apiKey: string | null): string {
  const trimmed = (apiKey ?? '').trim();
  if (trimmed.length === 0) return 'none';
  return createHash('sha256').update(trimmed).digest('hex').slice(0, 12);
}

/**
 * The host a failure sentence names - same four clauses as
 * `profileEndpointSummary()` in `ui/overlays/ModelProfilePicker.tsx`, which this
 * layer may not import (agent -> ui would invert the layering). `model-probe.test.ts`
 * asserts the two agree, so the duplication cannot drift silently.
 */
export function endpointHost(baseUrl: string | null): string {
  if (!baseUrl || baseUrl.trim().length === 0) return 'the provider';
  try {
    const url = new URL(baseUrl.trim());
    return url.username || url.password || url.search || url.hash ? 'this endpoint'
      : url.host || 'the provider';
  } catch { return 'this endpoint'; }
}

function fingerprint(provider: string, baseUrl: string | null, apiKey: string | null,
  model?: string): string {
  const connection = `${provider}|${normalizeBaseUrl(baseUrl) ?? ''}|${keyDigest(apiKey)}`;
  return model === undefined ? connection : `${connection}|${model.trim()}`;
}

/** Absolute sentence so a redacted, truncated message can never show a key. */
function redactDetail(text: string, secrets: readonly string[]): string {
  let safe = text;
  for (const secret of secrets) {
    if (secret.length > 0) safe = safe.split(secret).join('[redacted]');
  }
  return safe.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, PROBE_LIMITS.detailChars);
}

interface Deadline {
  signal: AbortSignal;
  isFired(): boolean;
  isCancelled(): boolean;
  dispose(): void;
}

/**
 * One timer, two recorded facts. `cancelled` and `timeout` must be distinguishable
 * AFTER the fact, because an aborted adapter may resolve quietly or throw something
 * that looks like a network error (§4.3 step 6).
 */
function createDeadline(timeoutMs: number, parent?: AbortSignal): Deadline {
  const controller = new AbortController();
  let fired = false;
  const onParentAbort = (): void => controller.abort();
  if (parent) {
    if (parent.aborted) controller.abort();
    else parent.addEventListener('abort', onParentAbort, { once: true });
  }
  const handle = setTimeout(() => { fired = true; controller.abort(); }, timeoutMs);
  unrefTimer(handle);
  return {
    signal: controller.signal,
    isFired: () => fired,
    isCancelled: () => parent?.aborted === true,
    dispose: () => {
      clearTimeout(handle);
      parent?.removeEventListener('abort', onParentAbort);
    },
  };
}

/**
 * Run the best-effort model list under a cap. It never rejects and never vetoes.
 *
 * The cap timer is `unref`'d exactly like the deadline (§4.8): after a fast verdict the
 * list is still in flight, and a referenced five-second timer would keep the process
 * alive on exit for a number nobody is going to read.
 *
 * Taking a THUNK rather than a promise is what stops a synchronous throw (§4.3 step 3):
 * an adapter that fails before its first `await` - a test double, or a guard clause -
 * would otherwise escape past this layer and cancel a completion not yet attempted.
 */
function withCap<T>(call: () => Promise<T>, ms: number): Promise<T | undefined> {
  let pending: Promise<T>;
  try { pending = call(); } catch { return Promise.resolve(undefined); }
  return new Promise<T | undefined>((resolve) => {
    const handle = setTimeout(() => resolve(undefined), ms);
    unrefTimer(handle);
    const settle = (value: T | undefined): void => { clearTimeout(handle); resolve(value); };
    pending.then((value) => settle(value), () => settle(undefined));
  });
}

/** Timers and immediates both expose `unref<Timer>`; neither may outlive the probe. */
function unrefTimer(handle: ReturnType<typeof setTimeout>
  | ReturnType<typeof setImmediate>): void {
  const unrefable = handle as { unref?: () => void };
  unrefable.unref?.();
}

/**
 * The list AS IT STANDS when the verdict is reached.
 *
 * One macrotask of grace, so a list that resolved while the completion was in flight
 * publishes itself before we judge - and a list still in flight is NOT waited for,
 * because it has no veto over the verdict (§4.3 step 3 / RV-P1-1).
 */
function listAtVerdict(listing: Promise<ModelInfo[] | undefined>):
Promise<ModelInfo[] | undefined> {
  const grant = new Promise<undefined>((resolve) => {
    unrefTimer(setImmediate(() => resolve(undefined)));
  });
  return Promise.race([listing, grant]);
}

function guardFailure(provider: LLMProvider | undefined, request: ProbeTarget,
  targetId: string): ProbeOutcome | undefined {
  const base = { ok: false, targetId, latencyMs: 0 } as const;
  if (!provider) {
    return { ...base, kind: 'unsupported_provider',
      detail: `This build has no adapter for ${request.provider}.` };
  }
  if (!request.apiKey || request.apiKey.trim().length === 0) {
    return { ...base, kind: 'missing_key',
      detail: `No API key for ${request.provider}.${NO_KEY_DETAIL_SUFFIX}` };
  }
  if (request.baseUrl && !isValidEndpointUrl(request.baseUrl)) {
    return { ...base, kind: 'invalid_base_url',
      detail: 'Base URL must be an http(s) URL without credentials, query or fragment.' };
  }
  return undefined;
}

interface FailureFacts {
  provider: string;
  model: string;
  host: string;
  timeoutSeconds: number;
}

function mentionsModel(err: LLMError): boolean {
  return /model/i.test(err.message);
}

/** The ONE classification matrix (§4.4). Signal facts are checked by the caller. */
function classifyError(err: unknown, facts: FailureFacts):
{ kind: ProbeFailureKind; detail: string } {
  if (!(err instanceof LLMError)) return { kind: 'unknown', detail: UNKNOWN_DETAIL };
  const status = typeof err.statusCode === 'number' ? err.statusCode : undefined;
  const suffix = status === undefined ? '' : ` (HTTP ${status})`;
  switch (err.errorType) {
    case 'auth_error':
      return { kind: 'auth', detail: `Key rejected by ${facts.provider}${suffix}.` };
    case 'invalid_request':
    case 'context_overflow':
      return mentionsModel(err)
        ? { kind: 'model_not_found',
          detail: `The provider did not accept model "${facts.model}"${suffix}.` }
        : { kind: 'invalid_request', detail: `The provider rejected the request${suffix}.` };
    case 'rate_limit':
      return { kind: 'rate_limit',
        detail: `Rate limited by ${facts.provider}${suffix || ' (HTTP 429)'}. Try again shortly.` };
    case 'overloaded':
    case 'server_error':
      return { kind: 'provider_unavailable',
        detail: `${facts.provider} is unavailable right now${suffix}.` };
    case 'network_error':
      return { kind: 'network',
        detail: `Could not reach ${facts.host}. Check the base URL, DNS, proxy or VPN.` };
    case 'timeout':
      return { kind: 'timeout',
        detail: `No answer from ${facts.host} within ${facts.timeoutSeconds} s.` };
    default:
      return { kind: 'unknown', detail: UNKNOWN_DETAIL };
  }
}

function firstText(message: AssistantMessage): string | undefined {
  const block = message.content.find((part) => part.type === 'text');
  return block && block.type === 'text' ? block.text : undefined;
}

/** Only text literally present in the error body may count as "the field is wrong". */
function errorBody(err: LLMError): string {
  return typeof err.raw === 'string' ? err.raw : err.message;
}

function isTokenFieldRejection(err: unknown, provider: string): boolean {
  if (!(err instanceof LLMError)) return false;
  return classifyOutputLimitFailure(provider, err.statusCode ?? 0, errorBody(err)) !== undefined;
}

function requestFor(request: ProbeRequest, deadline: Deadline,
  maxTokens?: number) {
  return {
    model: request.model.trim(),
    messages: [{ role: 'user' as const, content: PROBE_PROMPT }],
    apiKey: request.apiKey ?? '',
    ...(request.baseUrl ? { baseUrl: request.baseUrl } : {}),
    signal: deadline.signal,
    ...(maxTokens === undefined ? {} : { maxTokens }),
  };
}

function logProbe(facts: FailureFacts, outcome: ProbeOutcome, now: number): void {
  try {
    getTuiLogger().child('llm').info('probe_result', {
      provider: facts.provider, model: facts.model, host: facts.host,
      latencyMs: outcome.latencyMs, ok: outcome.ok, kind: outcome.kind ?? 'ok',
      at: now,
    });
  } catch { /* logging must never fail a probe */ }
}

function candidateOf(model: ModelInfo): ModelCandidate {
  return {
    id: model.id,
    name: model.name && model.name !== model.id ? model.name : model.id,
    ...(model.contextWindowSource === 'api' && model.contextWindow
      ? { contextWindow: model.contextWindow } : {}),
    supportsTools: model.supportsTools === true,
  };
}

async function runDiscovery(provider: LLMProvider | undefined, request: ProbeRequest,
  connectionId: string): Promise<DiscoveryOutcome> {
  const guard = guardFailure(provider, request, connectionId);
  if (guard) {
    return { ok: false, connectionId, kind: guard.kind, detail: guard.detail, models: [],
      truncated: false, total: 0 };
  }
  const deadline = createDeadline(PROBE_LIMITS.discoveryTimeoutMs, request.signal);
  const facts: FailureFacts = { provider: request.provider, model: request.model,
    host: endpointHost(request.baseUrl), timeoutSeconds: PROBE_LIMITS.discoveryTimeoutMs / 1000 };
  try {
    const listed = await provider!.listModels(request.apiKey!, request.baseUrl ?? undefined,
      deadline.signal);
    const candidates = (listed ?? []).map(candidateOf).filter((entry) => entry.id.length > 0);
    return { ok: true, connectionId, total: candidates.length,
      models: candidates.slice(0, PROBE_LIMITS.maxListedModels),
      truncated: candidates.length > PROBE_LIMITS.maxListedModels };
  } catch (failure) {
    const verdict = request.signal?.aborted ? { kind: 'cancelled' as const, detail: 'Cancelled.' }
      : deadline.isFired()
        ? { kind: 'timeout' as const,
          detail: `No answer from ${facts.host} within ${facts.timeoutSeconds} s.` }
        : classifyError(failure, facts);
    return { ok: false, connectionId, kind: verdict.kind, detail: verdict.detail, models: [],
      truncated: false, total: 0 };
  } finally {
    deadline.dispose();
  }
}

/** Create the probe port. One instance per App; `SettingsScreen` only passes it down. */
export function createModelProbe(deps: ProbeDeps): ModelProbe {
  const now = deps.now ?? Date.now;
  return {
    targetFingerprint: (target) =>
      fingerprint(target.provider, target.baseUrl, target.apiKey, target.model),
    connectionFingerprint: (target) =>
      fingerprint(target.provider, target.baseUrl, target.apiKey),
    discover: (request) => runDiscovery(deps.registry.get(request.provider), request,
      fingerprint(request.provider, request.baseUrl, request.apiKey)),
    test: (request) => runTest(deps, request),
  };
}

interface JudgeContext {
  targetId: string;
  started: number;
  now: () => number;
  /** The capped list promise, awaited only when there is no model to complete. */
  listing: Promise<ModelInfo[] | undefined>;
}

async function runTest(deps: ProbeDeps, request: ProbeRequest): Promise<ProbeOutcome> {
  const clock = deps.now ?? Date.now;
  const started = clock();
  const targetId = fingerprint(request.provider, request.baseUrl, request.apiKey, request.model);
  const provider = deps.registry.get(request.provider);
  const guard = guardFailure(provider, request, targetId);
  if (guard) return guard;
  const adapter = provider!;
  const deadline = createDeadline(PROBE_LIMITS.testTimeoutMs, request.signal);
  const facts: FailureFacts = { provider: request.provider, model: request.model.trim(),
    host: endpointHost(request.baseUrl), timeoutSeconds: PROBE_LIMITS.testTimeoutMs / 1000 };
  // The list runs CONCURRENTLY and has no veto (§4.3 step 3): it may only decorate a
  // verdict the completion already produced. Nothing waits for it except the
  // model-less path, which has no completion to wait for.
  const listing = withCap(() => adapter.listModels(request.apiKey!,
    request.baseUrl ?? undefined, deadline.signal), PROBE_LIMITS.listModelsBudgetMs);
  try {
    return await completeAndJudge(adapter, request, deadline, facts,
      { targetId, started, now: clock, listing });
  } finally {
    deadline.dispose();
  }
}

async function completeAndJudge(provider: LLMProvider, request: ProbeRequest, deadline: Deadline,
  facts: FailureFacts, context: JudgeContext): Promise<ProbeOutcome> {
  const base = { targetId: context.targetId };
  if (request.model.trim().length === 0) {
    // Nothing to complete: list only, and report what the key can reach.
    const reachable = await context.listing;
    const latencyMs = context.now() - context.started;
    if (request.signal?.aborted) {
      return { ...base, ok: false, latencyMs, kind: 'cancelled', detail: 'Cancelled.' };
    }
    if (deadline.isFired()) {
      return { ...base, ok: false, latencyMs, kind: 'timeout',
        detail: `No answer from ${facts.host} within ${facts.timeoutSeconds} s.` };
    }
    return { ...base, ok: true, latencyMs,
      ...(reachable ? { availableModels: reachable.length } : {}) };
  }
  let message: AssistantMessage | undefined;
  let failure: unknown;
  try {
    message = await provider.complete(requestFor(request, deadline, MIN_MAX_OUTPUT_TOKENS));
  } catch (error) {
    failure = error;
  }
  if (failure !== undefined && isTokenFieldRejection(failure, request.provider)) {
    // Exactly ONE repair retry with the cap left to the adapter's own learned field.
    try {
      message = await provider.complete(requestFor(request, deadline));
      failure = undefined;
    } catch (error) { failure = error; }
  }
  const latencyMs = context.now() - context.started;
  if (request.signal?.aborted) {
    return { ...base, ok: false, latencyMs, kind: 'cancelled', detail: 'Cancelled.' };
  }
  if (deadline.isFired()) {
    return { ...base, ok: false, latencyMs, kind: 'timeout',
      detail: `No answer from ${facts.host} within ${facts.timeoutSeconds} s.` };
  }
  if (failure !== undefined || !message) {
    const verdict = classifyError(failure, facts);
    const secrets = [request.apiKey ?? ''];
    const outcome: ProbeOutcome = { ...base, ok: false, latencyMs, kind: verdict.kind,
      detail: redactDetail(verdict.detail, secrets) };
    const reachable = await listAtVerdict(context.listing);
    if (reachable) outcome.availableModels = reachable.length;
    if (verdict.kind === 'model_not_found' && reachable) {
      outcome.modelListed = reachable.some((model) => model.id === facts.model);
    }
    logProbe(facts, outcome, context.now());
    return outcome;
  }
  const text = firstText(message);
  if (text === undefined) {
    const outcome: ProbeOutcome = { ...base, ok: false, latencyMs, kind: 'unknown',
      detail: UNKNOWN_DETAIL };
    logProbe(facts, outcome, context.now());
    return outcome;
  }
  const reachable = await listAtVerdict(context.listing);
  const outcome: ProbeOutcome = {
    ...base, ok: true, latencyMs,
    reply: text.trim().slice(0, PROBE_LIMITS.replyChars),
    ...(message.usage ? { usage: { inputTokens: message.usage.inputTokens,
      outputTokens: message.usage.outputTokens } } : {}),
    ...(reachable ? { availableModels: reachable.length,
      modelListed: reachable.some((model) => model.id === facts.model) } : {}),
  };
  logProbe(facts, outcome, context.now());
  return outcome;
}
