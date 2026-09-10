/** Explicit host enrollment bridges selection evidence to the existing resource runtime. */
import { lstatSync } from 'node:fs';
import { isAbsolute, join, parse, resolve } from 'node:path';
import { readKillSwitch } from '../sandbox/policy.js';
import { readResourceJson } from '../resources/pool-runtime.js';
import { validateResourcePool } from '../resources/pool-policy.js';
import { validateResourceBindings } from '../resources/worker.js';
import { verifyValueHypothesisV1, type ValueHypothesisV1 } from '../vision/value-portfolio.js';
import { canonical, digest, inspectPrivateDirectory } from './artifacts.js';
import type { DecisionTraceKeyOptions } from './decision-trace.js';
import { resourceGenerationTaskId } from './generation.js';
import { generateResourceCompletion, validateResourceGenerationRuntime, type ResourceGenerationCompletion } from './resource-generation.js';
import { readValueAllocations } from './value-allocation-store.js';

export interface FirmResourceEnrollmentV1 {
  executionIdentityDigest: string;
  resourceRuntime: string;
  /** Hash of canonical validated runtime, including its immutable ledger location. */
  runtimeDigest: string;
  poolId: string;
  poolDigest: string;
  workerId: string;
}
/**
 * Trusted host arguments, never loaded from a graph, allocation or provider output.
 * Enrolling a mapping is explicit execution authority. Its digest is only a join
 * key: neither it nor the configured native command proves an account identity.
 * The host must retain these ledger locations across aliases and invocations.
 */
export interface FirmResourceExecutionHost {
  allocationRoot: string;
  candidatePath: string;
  constitutionVersion: string;
  policyEpoch: number;
  enrollments: FirmResourceEnrollmentV1[];
}
export interface FirmResourceExecutionRequest {
  allocationId: string;
  expectedReceiptDigest: string;
  hypothesisId: string;
  hypotheses: ValueHypothesisV1[];
  expectedHypothesesDigest: string;
  prompt: string;
  timeoutMs: number;
  maxOutputTokens: number;
}
export interface FirmResourceExecutionResult {
  disposition: 'held' | 'attempted';
  reason: 'invalid-input' | 'selection-unavailable' | 'hypotheses-unavailable' | 'constraints-held' |
    'enrollment-unavailable' | 'budget-held' | 'kill-or-cancellation' | 'runtime-result';
  taskId: string | null;
  completion: ResourceGenerationCompletion | null;
  /** Completion is response data, never graph success or independent acceptance. */
  verifiedAccepted: false;
}

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Reflect.ownKeys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function path(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 4096 && isAbsolute(value) && resolve(value) === value &&
    parse(value).root !== value && [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127);
}
/** Bounded JSON snapshot before touching storage; never invoke getters/toJSON. */
function snapshot(value: unknown): unknown {
  let nodes = 0; let bytes = 0;
  const copy = (item: unknown, depth: number): unknown => {
    if (++nodes > 30_000 || depth > 32) throw new Error();
    if (item === null || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return item;
    if (typeof item === 'string') { bytes += Buffer.byteLength(item); if (bytes > 1024 * 1024) throw new Error(); return item; }
    if (!item || typeof item !== 'object') throw new Error();
    if (Array.isArray(item)) {
      if (Object.getPrototypeOf(item) !== Array.prototype || item.length > 4096 || Reflect.ownKeys(item).length !== item.length + 1) throw new Error();
      return Array.from({ length: item.length }, (_, index) => {
        const entry = Object.getOwnPropertyDescriptor(item, index);
        if (!entry || !entry.enumerable || !('value' in entry)) throw new Error();
        return copy(entry.value, depth + 1);
      });
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw new Error();
    const result: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(item)) {
      const entry = Object.getOwnPropertyDescriptor(item, key)!;
      if (typeof key !== 'string' || key.length > 256 || !entry.enumerable || !('value' in entry)) throw new Error();
      result[key] = copy(entry.value, depth + 1);
    }
    return result;
  };
  return copy(value, 0);
}
function stopped(root: string, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  try {
    const kill = readKillSwitch();
    if (kill.state !== 'inactive' || kill.sourceState !== 'healthy') return true;
    try { lstatSync(join(root, 'KILL')); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== 'ENOENT'; }
  } catch { return true; }
}

/**
 * One fixed completion operation per receipt and hypothesis. Alias IDs, prompts,
 * limits and enrollment names cannot manufacture a new task ID; the existing
 * locked resource ledger rejects changed task data and replays without output.
 * No graph effects, source edits, provider discovery or outcome acceptance occur.
 */
export async function executeFirmResourceTask(input: unknown, hostInput: FirmResourceExecutionHost,
  options: DecisionTraceKeyOptions & { signal: AbortSignal }): Promise<FirmResourceExecutionResult> {
  let taskId: string | null = null;
  const held = (reason: FirmResourceExecutionResult['reason']): FirmResourceExecutionResult =>
    ({ disposition: 'held', reason, taskId, completion: null, verifiedAccepted: false });
  let phase: FirmResourceExecutionResult['reason'] = 'invalid-input';
  let timer: ReturnType<typeof setInterval> | undefined;
  let cancel: (() => void) | undefined;
  try {
    const request = snapshot(input); const host = snapshot(hostInput);
    if (!exact(request, ['allocationId', 'expectedReceiptDigest', 'hypothesisId', 'hypotheses', 'expectedHypothesesDigest',
      'prompt', 'timeoutMs', 'maxOutputTokens']) || !exact(host, ['allocationRoot', 'candidatePath', 'constitutionVersion', 'policyEpoch', 'enrollments']) ||
      typeof request.allocationId !== 'string' || !ID.test(request.allocationId) ||
      ![request.expectedReceiptDigest, request.hypothesisId, request.expectedHypothesesDigest].every((value) => typeof value === 'string' && HASH.test(value)) ||
      !Array.isArray(request.hypotheses) || request.hypotheses.length < 1 || request.hypotheses.length > 12 ||
      typeof request.prompt !== 'string' || !request.prompt.trim() || request.prompt.includes('\0') || Buffer.byteLength(request.prompt) > 128 * 1024 ||
      !Number.isSafeInteger(request.timeoutMs) || Number(request.timeoutMs) < 1 || Number(request.timeoutMs) > 900_000 ||
      !Number.isSafeInteger(request.maxOutputTokens) || Number(request.maxOutputTokens) < 1 || Number(request.maxOutputTokens) > 16_384 ||
      !path(host.allocationRoot) || !path(host.candidatePath) || typeof host.constitutionVersion !== 'string' ||
      !Number.isSafeInteger(host.policyEpoch) || Number(host.policyEpoch) < 0 ||
      !Array.isArray(host.enrollments) || host.enrollments.length < 1 || host.enrollments.length > 32) return held(phase);
    const requestData = request as unknown as FirmResourceExecutionRequest;
    const hostData = host as unknown as FirmResourceExecutionHost;
    const keys = options.testKey ? { testKey: Buffer.from(options.testKey) } : undefined;
    if (stopped(hostData.allocationRoot, options.signal)) return held('kill-or-cancellation');
    phase = 'selection-unavailable';
    const store = readValueAllocations({ root: hostData.allocationRoot }, keys);
    if (store.sourceState !== 'healthy' || !store.complete) return held(phase);
    const stored = store.records.find((record) => record.allocationId === requestData.allocationId);
    if (!stored || stored.receipt.receiptDigest !== requestData.expectedReceiptDigest ||
      stored.receipt.constitutionVersion !== hostData.constitutionVersion || stored.receipt.policyEpoch !== hostData.policyEpoch ||
      Date.parse(stored.receipt.basis.asOf) > Date.now()) return held(phase);
    const receipt = stored.receipt;
    const selected = receipt.portfolio.decisions.find((decision) => decision.hypothesisId === requestData.hypothesisId);
    if (!selected || selected.disposition !== 'continue' || selected.reason !== 'allocated' || !selected.allocation) return held(phase);
    phase = 'hypotheses-unavailable';
    if (requestData.expectedHypothesesDigest !== receipt.basis.hypothesesDigest ||
      digest(canonical(requestData.hypotheses)) !== receipt.basis.hypothesesDigest) return held(phase);
    const hypotheses = requestData.hypotheses.map((value) => verifyValueHypothesisV1(value));
    if (hypotheses.some((value) => !value)) return held(phase);
    const hypothesis = hypotheses.find((value) => value?.hypothesisId === selected.hypothesisId);
    if (!hypothesis || hypothesis.hypothesisDigest !== selected.hypothesisDigest ||
      hypothesis.specDigest !== receipt.basis.visionSpecDigest || hypothesis.missionDigest !== receipt.basis.missionGraphDigest) return held(phase);
    phase = 'constraints-held';
    if (!hypothesis.constraints.dependenciesSatisfied || hypothesis.constraints.humanGateRequired || !hypothesis.constraints.reversible ||
      hypothesis.constraints.shardable || selected.allocation.inventory.length !== 1) return held(phase);
    const inventory = selected.allocation.inventory[0]!;
    if (!hypothesis.constraints.allowedProviders.includes(inventory.provider)) return held(phase);
    phase = 'budget-held';
    const now = Date.now(); const budget = hypothesis.budget;
    const deadline = Math.min(Date.parse(budget.deadline), inventory.resetAt === null ? Infinity : Date.parse(inventory.resetAt));
    // Byte length is a conservative request-size allowance, not measured model
    // tokens. Native token ceilings remain post-response checks in the runtime.
    const requestedTokens = Buffer.byteLength(canonical([{ role: 'user', content: requestData.prompt }])) + requestData.maxOutputTokens;
    if (now + requestData.timeoutMs > deadline ||
      requestData.timeoutMs > Math.min(selected.allocation.minutes, inventory.minutes, budget.maxMinutes - budget.spentMinutes) * 60_000 ||
      requestedTokens > Math.min(selected.allocation.tokens, inventory.tokens, budget.maxTokens - budget.spentTokens) ||
      budget.attempts >= budget.maxAttempts || budget.inconclusiveWindows >= budget.maxInconclusiveWindows) return held(phase);
    phase = 'enrollment-unavailable';
    const seen = new Set<string>();
    for (const enrollment of hostData.enrollments) {
      if (!exact(enrollment, ['executionIdentityDigest', 'resourceRuntime', 'runtimeDigest', 'poolId', 'poolDigest', 'workerId']) ||
        ![enrollment.runtimeDigest, enrollment.poolDigest].every((value) => typeof value === 'string' && HASH.test(value)) ||
        typeof enrollment.executionIdentityDigest !== 'string' || !/^(?:sha256:)?[a-f0-9]{64}$/.test(enrollment.executionIdentityDigest) ||
        !path(enrollment.resourceRuntime) || ![enrollment.poolId, enrollment.workerId].every((value) => typeof value === 'string' && ID.test(value)) ||
        seen.has(enrollment.executionIdentityDigest)) return held(phase);
      seen.add(enrollment.executionIdentityDigest);
    }
    const enrollment = hostData.enrollments.find((entry) => entry.executionIdentityDigest === inventory.executionIdentityDigest);
    if (!enrollment) return held(phase);
    const runtime = validateResourceGenerationRuntime(readResourceJson(enrollment.resourceRuntime));
    if (digest(canonical(runtime)) !== enrollment.runtimeDigest) return held(phase);
    const pool = validateResourcePool(readResourceJson(runtime.poolPath));
    const bindings = validateResourceBindings(readResourceJson(runtime.bindingsPath), pool);
    if (pool.id !== enrollment.poolId || digest(canonical({ pool, bindings })) !== enrollment.poolDigest ||
      pool.workers.find((worker) => worker.id === enrollment.workerId)?.provider !== inventory.provider) return held(phase);
    inspectPrivateDirectory(hostData.candidatePath);
    const identity = { universeId: 'firm-resource-completion-v1', runId: receipt.receiptDigest, variantId: hypothesis.hypothesisId };
    taskId = resourceGenerationTaskId(identity);
    const controller = new AbortController();
    cancel = () => controller.abort();
    options.signal.addEventListener('abort', cancel, { once: true });
    const check = () => { if (stopped(hostData.allocationRoot, options.signal) || Date.now() >= deadline) controller.abort(); };
    check(); if (controller.signal.aborted) return held('kill-or-cancellation');
    timer = setInterval(check, 50);
    const completion = await generateResourceCompletion({ kind: 'resource-pool', poolId: enrollment.poolId,
      poolDigest: enrollment.poolDigest, allowedWorkerIds: [enrollment.workerId], files: ['completion.txt'], maxOutputTokens: requestData.maxOutputTokens },
    { messages: [{ role: 'user', content: requestData.prompt }], candidatePath: hostData.candidatePath,
      timeoutMs: requestData.timeoutMs, signal: controller.signal, resourceRuntime: enrollment.resourceRuntime,
      expectedRuntimeDigest: enrollment.runtimeDigest, resourceUniverseRoot: hostData.allocationRoot, resourceIdentity: identity });
    return { disposition: 'attempted', reason: 'runtime-result', taskId, completion, verifiedAccepted: false };
  } catch { return held(phase); }
  finally {
    if (timer !== undefined) clearInterval(timer);
    if (cancel) options.signal.removeEventListener('abort', cancel);
  }
}
