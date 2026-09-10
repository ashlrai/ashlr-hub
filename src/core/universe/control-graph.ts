import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { killSwitchOn } from '../sandbox/policy.js';
import { canonicalEvidencePackJsonV3 } from '../foundry/provenance.js';
import { acquireLocalStoreLockWithOutcome, ownsLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { readImmutablePrivateRecords, writeImmutablePrivateRecord, type ImmutablePrivateRecordStoreConfig } from '../util/immutable-private-record-store.js';
import { canonical, digest, inspectPrivateDirectory } from './artifacts.js';
import { signDecisionTraceV1, verifyDecisionTraceV1, type DecisionTraceV1, type DecisionTraceKeyOptions } from './decision-trace.js';
import { isFirmEngineeringControlHandler, firmEngineeringControlRecovery, firmEngineeringControlContinuation } from './firm-engineering-control-handler.js';
import type { PortfolioControllerGraphDispatch } from './portfolio-controller-types.js';

export const CONTROL_NODE_KINDS = ['plan', 'explore', 'implement', 'verify', 'critic', 'integrate', 'weigh', 'mutate-harness', 'sweep', 'invent', 'talk', 'deliver'] as const;
export type ControlNodeKind = typeof CONTROL_NODE_KINDS[number];
export interface ControlGraphNode { id: string; kind: ControlNodeKind; requires: string[]; input: unknown }
export interface ControlGraphDefinition { schemaVersion: 1; id: string; nodes: ControlGraphNode[]; maxConcurrent: number; maxDurationMs: number;
  /** Optional host association, signed with the definition; never effect authority. */
  hostEnrollmentDigest?: string }
export interface ControlArtifact { nodeId: string; digest: string; value: unknown }
export interface ControlHandlerContext { node: ControlGraphNode; artifacts: ControlArtifact[]; signal: AbortSignal;
  /** Trusted synchronous stop/ownership check, including the original graph deadline. */
  isExecutionStopped?: () => boolean;
  /** Invocation-only monotonic cap; never changes the durable graph definition. */
  deadlineMonotonicMs?: number;
  /** Derived only after durable signed intent publication; not an effect permit. */
  graphDispatch?: PortfolioControllerGraphDispatch }
export interface ControlHandlerResult {
  artifact: unknown; verifier?: DecisionTraceV1['verifier']; conflicts?: DecisionTraceV1['conflicts'];
  outcome?: 'completed' | 'rejected'; spend?: DecisionTraceV1['spend'];
}
export type ControlGraphHandler = (context: ControlHandlerContext) => Promise<ControlHandlerResult>;
/** Receipt-only synchronous proof collection, never dispatch or controller resume. */
export type ControlGraphRecoveryHandler = (context: ControlHandlerContext) => ControlHandlerResult | null;
/** Separately enrolled execution of untouched child work, never replay of graph intent. */
export type ControlGraphContinuationHandler = (context: ControlHandlerContext) => Promise<ControlHandlerResult | null>;
export interface GraphContinuationAuthority {
  readonly graphDispatch: Readonly<PortfolioControllerGraphDispatch>;
  readonly signal: AbortSignal;
  readonly deadlineMonotonicMs: number;
  readonly isExecutionStopped: () => boolean;
}
const continuationAuthorities = new WeakMap<object, { bindingDigest: string; authority: GraphContinuationAuthority }>();
/** Internal live-context lookup. Neither copied JSON nor a retained context grants execution. */
export function readGraphContinuationAuthority(context: unknown, bindingDigest: string): GraphContinuationAuthority | null {
  if (context === null || typeof context !== 'object') return null;
  const entry = continuationAuthorities.get(context);
  if (!entry || entry.bindingDigest !== bindingDigest) return null;
  try { return entry.authority.isExecutionStopped() ? null : entry.authority; }
  catch { return null; }
}
/** Trusted host declaration, not an effect permit or model-authored authority. */
export type ControlHandlerExecution = { constitutionVersion: string; policyEpoch: number; bindingDigest: string } &
  ({ effectClass: 'resource-completion' } | { effectClass: 'engineering-portfolio-local-delivery' });
export type ControlGraphHandlerRegistration = ControlGraphHandler | (ControlHandlerExecution & { run: ControlGraphHandler });
export interface ControlGraphOptions {
  root: string;
  /** Trusted host adapters, never executable code or command strings from graph JSON. */
  handlers: Partial<Record<ControlNodeKind, ControlGraphHandlerRegistration>>;
  signal?: AbortSignal;
  /** Trusted enclosing owner/project guard. True or a throw vetoes effects. */
  isExecutionStopped?: () => boolean;
  /** First-launch race guard, checked under graph execution ownership. */
  requireNewGraph?: boolean;
  /** Only local test fixtures may inject a key; runtime default uses existing provenance. */
  traceKeys?: DecisionTraceKeyOptions;
}
export interface ControlGraphReport {
  schemaVersion: 1; sourceState: 'healthy' | 'missing' | 'degraded';
  status: 'completed' | 'incomplete' | 'stopped' | 'unavailable';
  graphId: string | null; definitionDigest: string | null; deadlineAt: string | null;
  nodes: Array<{ id: string; kind: ControlNodeKind; state: 'pending' | 'unresolved' | 'completed' | 'rejected'; artifactDigest: string | null }>;
  edges: Array<{ from: string; to: string; artifactDigest: string }>;
  traces: DecisionTraceV1[]; reasons: string[];
}
type Event = { sequence: number; previousDigest: string | null; kind: 'created' | 'intent' | 'settled';
  nodeId: string | null; definitionDigest: string; data: unknown; trace: DecisionTraceV1 };
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_BYTES = 512 * 1024;
const MAX_EVENTS = 257;
const GUARDED = new Set<ControlNodeKind>(['integrate', 'deliver', 'mutate-harness', 'sweep']);

function executionMetadata(value: unknown): ControlHandlerExecution {
  const row = snapshot<ControlHandlerExecution>(value, 1024);
  if (!exact(row, ['effectClass', 'constitutionVersion', 'policyEpoch', 'bindingDigest']) ||
    !['resource-completion', 'engineering-portfolio-local-delivery'].includes(row.effectClass) ||
    typeof row.constitutionVersion !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(row.constitutionVersion) ||
    !Number.isSafeInteger(row.policyEpoch) || row.policyEpoch < 0 || typeof row.bindingDigest !== 'string' || !HASH.test(row.bindingDigest)) {
    throw new Error('Invalid graph execution declaration');
  }
  return row;
}
function registration(value: ControlGraphHandlerRegistration): { run: ControlGraphHandler; execution?: ControlHandlerExecution;
  engineeringDelivery?: true; recover?: ControlGraphRecoveryHandler; continuePending?: ControlGraphContinuationHandler } {
  if (typeof value === 'function') return { run: value };
  if (!exact(value, ['run', 'effectClass', 'constitutionVersion', 'policyEpoch', 'bindingDigest']) ||
    Object.keys(value).some((key) => !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value')) ||
    typeof value.run !== 'function') throw new Error('Invalid graph handler registration');
  const { run, ...metadata } = value;
  return { run, execution: executionMetadata(metadata),
    ...(isFirmEngineeringControlHandler(value) ? { engineeringDelivery: true as const, recover: firmEngineeringControlRecovery(value),
      continuePending: firmEngineeringControlContinuation(value) } : {}) };
}
function assertExecutionTrace(trace: DecisionTraceV1, execution?: ControlHandlerExecution): void {
  if (trace.authority.effectClass !== (execution?.effectClass ?? 'simulate') ||
    trace.constitutionVersion !== (execution?.constitutionVersion ?? 'existing-doctrine') ||
    trace.policyEpoch !== (execution?.policyEpoch ?? 0)) throw new Error('Graph execution declaration changed');
}

function snapshot<T>(value: unknown, limit = MAX_BYTES): T {
  const text = canonicalEvidencePackJsonV3(value);
  if (text === null || Buffer.byteLength(text) > limit) throw new Error('Invalid control graph data');
  return JSON.parse(text) as T;
}
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
export function validateControlGraph(input: unknown): ControlGraphDefinition {
  const value = snapshot<ControlGraphDefinition>(input, 256 * 1024);
  if (!exact(value, ['schemaVersion', 'id', 'nodes', 'maxConcurrent', 'maxDurationMs',
    ...(Object.hasOwn(value, 'hostEnrollmentDigest') ? ['hostEnrollmentDigest'] : [])]) || value.schemaVersion !== 1 ||
      Object.hasOwn(value, 'hostEnrollmentDigest') && (typeof value.hostEnrollmentDigest !== 'string' || !HASH.test(value.hostEnrollmentDigest)) ||
      typeof value.id !== 'string' || !ID.test(value.id) || !Array.isArray(value.nodes) || value.nodes.length < 1 || value.nodes.length > 128 ||
      !Number.isSafeInteger(value.maxConcurrent) || value.maxConcurrent < 1 || value.maxConcurrent > 8 ||
      !Number.isSafeInteger(value.maxDurationMs) || value.maxDurationMs < 1 || value.maxDurationMs > 86_400_000) throw new Error('Invalid control graph definition');
  const ids = new Set<string>();
  for (const node of value.nodes) {
    if (!exact(node, ['id', 'kind', 'requires', 'input']) || typeof node.id !== 'string' || !ID.test(node.id) || ids.has(node.id) ||
        !CONTROL_NODE_KINDS.includes(node.kind) || !Array.isArray(node.requires) || node.requires.length > 127 ||
        node.requires.some((id) => typeof id !== 'string' || !ID.test(id) || id === node.id) || new Set(node.requires).size !== node.requires.length) {
      throw new Error('Invalid control graph node');
    }
    snapshot(node.input, 32 * 1024); ids.add(node.id);
  }
  const visited = new Set<string>();
  while (visited.size < ids.size) {
    const next = value.nodes.find((node) => !visited.has(node.id) && node.requires.every((id) => visited.has(id)));
    if (!next) throw new Error('Invalid control graph dependency');
    visited.add(next.id);
  }
  // Reserve event-envelope depth and trace fields before admitting a definition.
  // The provenance canonicalizer also has structural limits, not just bytes.
  snapshot({ data: { definition: value }, traceReserve: Array(128).fill(null) });
  return value;
}

function configuration(root: string, keys?: DecisionTraceKeyOptions): ImmutablePrivateRecordStoreConfig<Event> {
  const parse = (raw: unknown): Event | null => {
    try {
      const row = snapshot<Event>(raw);
      if (!exact(row, ['sequence', 'previousDigest', 'kind', 'nodeId', 'definitionDigest', 'data', 'trace']) ||
          !Number.isSafeInteger(row.sequence) || row.sequence < 0 || row.sequence >= MAX_EVENTS ||
          row.previousDigest !== null && (typeof row.previousDigest !== 'string' || !HASH.test(row.previousDigest)) ||
          !['created', 'intent', 'settled'].includes(row.kind) || row.nodeId !== null && (typeof row.nodeId !== 'string' || !ID.test(row.nodeId)) ||
          typeof row.definitionDigest !== 'string' || !HASH.test(row.definitionDigest) || !verifyDecisionTraceV1(row.trace, keys)) return null;
      const { trace, ...body } = row;
      return trace.inputsDigest === digest(canonical(body)) ? row : null;
    } catch { return null; }
  };
  const codec = { parse, serialize: (row: Event) => `${canonical(row)}\n`, recordId: (row: Event) => String(row.sequence).padStart(8, '0'),
    recordFileName: (row: Event) => `${String(row.sequence).padStart(8, '0')}.json`, isRecordFileName: (name: string) => /^\d{8}\.json$/.test(name),
    stageToken: (row: Event) => digest(canonical(row)), equivalent: (a: Event, b: Event) => canonical(a) === canonical(b), compare: (a: Event, b: Event) => a.sequence - b.sequence };
  return { label: 'Universe control graph', anchorPath: root, rootPath: join(root, 'control-graph'), lockFileName: '.records.lock',
    maxRecordBytes: MAX_BYTES, defaultMaxFiles: MAX_EVENTS, hardMaxFiles: MAX_EVENTS,
    defaultMaxBytes: 32 * 1024 * 1024, hardMaxBytes: 32 * 1024 * 1024, codecForRead: () => codec, codecForWrite: () => codec };
}
function load(root: string, keys?: DecisionTraceKeyOptions) {
  inspectPrivateDirectory(root);
  const result = readImmutablePrivateRecords(configuration(root, keys), { requireComplete: true });
  if (result.sourceState === 'degraded' || !result.complete && result.sourceState !== 'missing') throw new Error('Control graph evidence unavailable');
  const events = result.records;
  let definition: ControlGraphDefinition | null = null;
  let deadlineAt: string | null = null;
  const states = new Map<string, { state: 'pending' | 'unresolved' | 'completed' | 'rejected'; artifact?: ControlArtifact;
    execution?: ControlHandlerExecution; intent?: Event }>();
  const edges: ControlGraphReport['edges'] = [];
  for (let index = 0; index < events.length; index++) {
    const row = events[index]!;
    if (row.sequence !== index || row.previousDigest !== (index ? digest(canonical(events[index - 1])) : null)) throw new Error('Control graph history unavailable');
    if (!index) {
      if (row.kind !== 'created' || row.nodeId !== null || !exact(row.data, ['definition', 'deadlineAt']) || typeof row.data.deadlineAt !== 'string' ||
          !Number.isFinite(Date.parse(row.data.deadlineAt))) throw new Error('Invalid graph enrollment');
      definition = validateControlGraph(row.data.definition); deadlineAt = row.data.deadlineAt;
      assertExecutionTrace(row.trace);
      if (row.definitionDigest !== digest(canonical(definition))) throw new Error('Graph definition changed');
      for (const node of definition.nodes) states.set(node.id, { state: 'pending' });
      continue;
    }
    if (!definition || row.definitionDigest !== events[0]!.definitionDigest || row.nodeId === null) throw new Error('Graph enrollment changed');
    const node = definition.nodes.find((item) => item.id === row.nodeId);
    const prior = states.get(row.nodeId);
    if (!node || !prior) throw new Error('Unknown graph node');
    if (row.kind === 'intent') {
      const inputs = node.requires.map((id) => states.get(id)?.artifact);
      if (prior.state !== 'pending' || inputs.some((item) => !item) ||
          !(exact(row.data, ['inputDigests']) || exact(row.data, ['inputDigests', 'execution'])) ||
          canonical(row.data.inputDigests) !== canonical(inputs.map((item) => ({ nodeId: item!.nodeId, digest: item!.digest })))) throw new Error('Invalid graph intent');
      const execution = Object.hasOwn(row.data, 'execution') ? executionMetadata(row.data.execution) : undefined;
      if (execution?.effectClass === 'engineering-portfolio-local-delivery' && node.kind !== 'deliver') {
        throw new Error('Engineering execution requires a deliver node');
      }
      assertExecutionTrace(row.trace, execution);
      for (const item of inputs) edges.push({ from: item!.nodeId, to: node.id, artifactDigest: item!.digest });
      states.set(node.id, { state: 'unresolved', intent: row, ...(execution ? { execution } : {}) });
    } else if (row.kind === 'settled') {
      if (prior.state !== 'unresolved' || !exact(row.data, ['state', 'artifact', 'artifactDigest', ...(prior.execution ? ['execution'] : [])]) ||
          !['completed', 'rejected'].includes(String(row.data.state)) ||
          row.data.artifactDigest !== digest(canonical(row.data.artifact)) || row.trace.artifactDigest !== row.data.artifactDigest) throw new Error('Invalid graph settlement');
      if (prior.execution && canonical(executionMetadata(row.data.execution)) !== canonical(prior.execution)) throw new Error('Graph execution binding changed');
      assertExecutionTrace(row.trace, prior.execution);
      if ((['verify', 'critic', 'weigh'].includes(node.kind) || prior.execution?.effectClass === 'engineering-portfolio-local-delivery') && row.data.state === 'completed' &&
          (row.trace.verifier.verdict !== 'pass' || !row.trace.verifier.independent)) throw new Error('Missing independent graph verdict');
      states.set(node.id, { state: row.data.state as 'completed' | 'rejected', ...(row.data.state === 'completed' ? {
        artifact: { nodeId: node.id, digest: row.data.artifactDigest as string, value: row.data.artifact } } : {}) });
    } else throw new Error('Duplicate graph enrollment');
  }
  return { events, definition, deadlineAt, states, edges };
}
export function readControlGraph(root: string, keys?: DecisionTraceKeyOptions): ControlGraphReport {
  try {
    const state = load(root, keys);
    return { schemaVersion: 1, sourceState: state.definition ? 'healthy' : 'missing',
      status: state.definition && [...state.states.values()].every((row) => row.state === 'completed') ? 'completed' : 'incomplete',
      graphId: state.definition?.id ?? null, definitionDigest: state.events[0]?.definitionDigest ?? null, deadlineAt: state.deadlineAt,
      nodes: state.definition?.nodes.map((node) => ({ id: node.id, kind: node.kind, state: state.states.get(node.id)!.state,
        artifactDigest: state.states.get(node.id)!.artifact?.digest ?? null })) ?? [], edges: state.edges,
      traces: state.events.map((row) => row.trace), reasons: state.definition ? [] : ['graph-missing'] };
  } catch {
    return { schemaVersion: 1, sourceState: 'degraded', status: 'unavailable', graphId: null, definitionDigest: null, deadlineAt: null,
      nodes: [], edges: [], traces: [], reasons: ['graph-evidence-unavailable'] };
  }
}
function presentOrUncertain(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ENOENT'; }
}

/**
 * Durable bounded graph kernel for trusted host-owned, confined adapters. No
 * command/provider dispatch or activation authority is created here. Integrate,
 * sweep and live harness mutation remain withheld. Deliver admits only the
 * concrete factory-branded engineering adapter through its existing effect gates.
 * A persisted intent is never re-dispatched. Only the concrete engineering
 * adapter can reconcile exact completed child evidence within the original budget.
 */
export async function runControlGraph(input: unknown, options: ControlGraphOptions): Promise<ControlGraphReport> {
  const definition = validateControlGraph(input);
  const root = inspectPrivateDirectory(options.root);
  const parentStopped = options.isExecutionStopped;
  if (parentStopped !== undefined && typeof parentStopped !== 'function') throw new Error('Invalid graph stop guard');
  const requireNewGraph = options.requireNewGraph;
  if (requireNewGraph !== undefined && typeof requireNewGraph !== 'boolean') throw new Error('Invalid graph enrollment requirement');
  const traceKeys = options.traceKeys?.testKey ? { testKey: Buffer.from(options.traceKeys.testKey) } : undefined;
  // Capture trusted callbacks and detached metadata before the first async yield.
  const handlers = new Map<ControlNodeKind, ReturnType<typeof registration>>();
  for (const kind of CONTROL_NODE_KINDS) {
    const value = options.handlers[kind];
    if (value !== undefined) handlers.set(kind, registration(value));
  }
  const controller = new AbortController();
  const started = performance.now();
  let stopReason: string | null = null;
  let deadlineAt: string | null = null;
  const stop = () => {
    if (options.signal?.aborted) stopReason ??= 'caller-cancelled';
    try { if (parentStopped?.()) stopReason ??= 'enclosing-execution-stopped'; }
    catch { stopReason ??= 'enclosing-execution-stopped'; }
    if (killSwitchOn() || presentOrUncertain(join(root, 'KILL'))) stopReason ??= 'kill-switch';
    if (performance.now() - started >= definition.maxDurationMs || deadlineAt && Date.now() >= Date.parse(deadlineAt)) stopReason ??= 'duration-exhausted';
    if (stopReason) controller.abort();
    return stopReason !== null;
  };
  if (stop()) return { ...readControlGraph(root, traceKeys), status: 'stopped', reasons: [stopReason!] };
  const ownership = acquireLocalStoreLockWithOutcome(join(root, '.control-execution.lock'), 0, { anchorPath: root, exactPrivateStorage: true });
  if (ownership.state !== 'acquired') return { ...readControlGraph(root, traceKeys), status: 'unavailable', reasons: ['graph-owner-unavailable'] };
  const own = () => { if (!ownsLocalStoreLock(ownership.lock)) { stopReason ??= 'ownership-lost'; controller.abort(); return false; } return true; };
  const timer = setInterval(() => { stop(); own(); }, 50);
  const abort = () => { stopReason ??= 'caller-cancelled'; controller.abort(); };
  options.signal?.addEventListener('abort', abort, { once: true });
  const active = new Map<string, Promise<void>>();
  const reasons = new Set<string>();
  try {
    let state = load(root, traceKeys);
    if (requireNewGraph && state.definition) throw new Error('Host requires a new graph enrollment');
    const definitionDigest = digest(canonical(definition));
    const append = (kind: Event['kind'], nodeId: string | null, data: unknown, verifier: DecisionTraceV1['verifier'],
      conflicts: DecisionTraceV1['conflicts'] = [], execution?: ControlHandlerExecution, spend: DecisionTraceV1['spend'] = { unknown: true },
      requireRunning = false) => {
      if (!own()) throw new Error('Graph ownership lost');
      const current = load(root, traceKeys);
      if (current.events.length !== state.events.length || canonical(current.events.at(-1) ?? null) !== canonical(state.events.at(-1) ?? null)) throw new Error('Graph evidence changed');
      const body = { sequence: state.events.length, previousDigest: state.events.length ? digest(canonical(state.events.at(-1))) : null,
        kind, nodeId, definitionDigest, data: snapshot(data, 384 * 1024) };
      const artifactDigest = kind === 'settled' ? (body.data as { artifactDigest: string }).artifactDigest : undefined;
      const trace = signDecisionTraceV1({ id: `${definition.id}:${body.sequence}`, ts: new Date().toISOString(),
        entities: nodeId ? [`graph:${definition.id}`, `node:${nodeId}`] : [`graph:${definition.id}`], action: `graph-${kind}`,
        constitutionVersion: execution?.constitutionVersion ?? 'existing-doctrine', policyEpoch: execution?.policyEpoch ?? 0, inputsDigest: digest(canonical(body)),
        ...(artifactDigest ? { artifactDigest } : {}), verifier, authority: { effectClass: execution?.effectClass ?? 'simulate' }, spend, conflicts }, traceKeys);
      if (!trace) throw new Error('Graph provenance unavailable');
      const result = writeImmutablePrivateRecord(configuration(root, traceKeys), { ...body, trace }, {
        lockWaitMs: 0, prepublish: () => own() && (!requireRunning || !stop()),
      });
      if (!['recorded', 'replayed'].includes(result)) throw new Error('Graph publication unavailable');
      state = load(root, traceKeys);
    };
    if (!state.definition) {
      if (stop() || !own()) return { ...readControlGraph(root, traceKeys), status: 'stopped', reasons: [stopReason ?? 'ownership-lost'] };
      deadlineAt = new Date(Date.now() + definition.maxDurationMs).toISOString();
      append('created', null, { definition, deadlineAt }, { id: 'pending', verdict: 'unavailable', independent: false });
    } else if (canonical(state.definition) !== canonical(definition)) throw new Error('Graph definition drift');
    deadlineAt = state.deadlineAt;
    const context = (node: ControlGraphNode): ControlHandlerContext => {
      const intent = state.states.get(node.id)?.intent;
      if (!intent) throw new Error('Graph dispatch intent unavailable');
      return { node: snapshot(node), artifacts: node.requires.map((id) => snapshot<ControlArtifact>(state.states.get(id)!.artifact!)),
        signal: controller.signal, isExecutionStopped: () => stop() || !own(),
        deadlineMonotonicMs: Math.min(started + definition.maxDurationMs,
          performance.now() + Math.max(0, Date.parse(deadlineAt!) - Date.now())),
        graphDispatch: { schemaVersion: 1, graphRootDigest: digest(canonical(root)), graphId: definition.id,
          definitionDigest, nodeId: node.id, intentDigest: digest(canonical(intent)) } };
    };
    const handlerResult = (output: unknown, execution?: ControlHandlerExecution): ControlHandlerResult => {
      const result = snapshot<ControlHandlerResult>(output, 64 * 1024);
      if (!result || typeof result !== 'object' || !Object.hasOwn(result, 'artifact') ||
        Object.keys(result).some((key) => !['artifact', 'verifier', 'conflicts', 'outcome', 'spend'].includes(key)) ||
        (execution || Object.hasOwn(result, 'outcome')) && !['completed', 'rejected'].includes(result.outcome!)) throw new Error('Invalid handler result');
      return result;
    };
    // Preserve receipt-only recovery first. Only explicitly bound handlers can
    // then continue untouched child work, once per invocation, under this intent.
    for (const node of definition.nodes) {
      if (stop() || !own()) break;
      const prior = state.states.get(node.id)!;
      if (prior.state !== 'unresolved') continue;
      const handler = handlers.get(node.kind);
      if (node.kind !== 'deliver' || !handler?.engineeringDelivery || !handler.recover ||
        prior.execution?.effectClass !== 'engineering-portfolio-local-delivery') continue;
      if (canonical(prior.execution) !== canonical(handler.execution)) {
        reasons.add(`${node.id}:recovery-binding-mismatch`); continue;
      }
      try {
        let output = handler.recover(context(node));
        if (output === null && handler.continuePending && !stop() && own()) {
          const current = context(node);
          const authority: GraphContinuationAuthority = Object.freeze({
            graphDispatch: Object.freeze({ ...current.graphDispatch! }), signal: controller.signal,
            deadlineMonotonicMs: current.deadlineMonotonicMs!,
            isExecutionStopped: () => continuationAuthorities.get(current)?.authority !== authority || stop() || !own(),
          });
          continuationAuthorities.set(current, { bindingDigest: handler.execution!.bindingDigest, authority });
          try { output = await handler.continuePending(current); }
          finally { continuationAuthorities.delete(current); }
        }
        if (output === null) { reasons.add(`${node.id}:recovery-evidence-unavailable`); continue; }
        const result = handlerResult(output, prior.execution);
        if (result.outcome !== 'completed' || result.verifier?.verdict !== 'pass' || !result.verifier.independent) {
          reasons.add(`${node.id}:recovery-evidence-unavailable`); continue;
        }
        if (stop() || !own()) break;
        append('settled', node.id, { state: 'completed', artifact: result.artifact,
          artifactDigest: digest(canonical(result.artifact)), execution: prior.execution },
        result.verifier, result.conflicts ?? [], prior.execution, result.spend ?? { unknown: true }, true);
      } catch { reasons.add(`${node.id}:recovery-evidence-unavailable`); }
    }
    while (!stop() && own()) {
      // Resolved handler promises alone can starve signal/timer callbacks.
      // Yield a macrotask before another admission batch, then recheck authority.
      await new Promise<void>((resolve) => setImmediate(resolve));
      let dispatched = false;
      for (const node of definition.nodes) {
        if (stop() || !own()) break;
        if (active.size >= definition.maxConcurrent) break;
        if (state.states.get(node.id)?.state !== 'pending' || !node.requires.every((id) => state.states.get(id)?.state === 'completed')) continue;
        const handler = handlers.get(node.kind);
        // This effect class is reserved for the concrete adapter, even on node
        // kinds whose ordinary trusted callbacks do not require an effect gate.
        if (handler?.execution?.effectClass === 'engineering-portfolio-local-delivery' &&
          (node.kind !== 'deliver' || !handler.engineeringDelivery)) {
          reasons.add(`${node.id}:existing-effect-gate-required`); continue;
        }
        if (GUARDED.has(node.kind) && !(node.kind === 'deliver' && handler?.engineeringDelivery)) {
          reasons.add(`${node.id}:existing-effect-gate-required`); continue;
        }
        if (!handler) { reasons.add(`${node.id}:handler-unavailable`); continue; }
        const artifacts = node.requires.map((id) => state.states.get(id)!.artifact!);
        const execution = handler.execution;
        append('intent', node.id, { inputDigests: artifacts.map(({ nodeId, digest: hash }) => ({ nodeId, digest: hash })),
          ...(execution ? { execution } : {}) }, { id: 'pending', verdict: 'unavailable', independent: false }, [], execution);
        dispatched = true;
        const task = Promise.resolve().then(async () => {
          // Queued cancellation after intent cannot authorize a worker call.
          if (controller.signal.aborted || stop() || !own()) return;
          // A fan-in may contain many individually bounded artifacts.
          const output = await handler.run(context(node));
          const result = handlerResult(output, execution);
          const verifier = result.verifier ?? { id: 'not-evaluated', verdict: 'unavailable' as const, independent: false };
          const accepted = result.outcome !== 'rejected' && !(execution && (stop() || controller.signal.aborted)) &&
            (!['verify', 'critic', 'weigh'].includes(node.kind) && execution?.effectClass !== 'engineering-portfolio-local-delivery' ||
              verifier.verdict === 'pass' && verifier.independent);
          append('settled', node.id, { state: accepted ? 'completed' : 'rejected', artifact: result.artifact,
            artifactDigest: digest(canonical(result.artifact)), ...(execution ? { execution } : {}) },
          verifier, result.conflicts ?? [], execution, result.spend ?? { unknown: true });
        }).catch(() => { reasons.add(`${node.id}:dispatch-unresolved`); }).finally(() => active.delete(node.id));
        active.set(node.id, task);
      }
      if (active.size) await Promise.race(active.values());
      else if (!dispatched) break;
    }
    // Trusted adapters must honor cancellation and settle owned work. We do not
    // detach them or assert that timeout itself proves subprocess cleanup.
    if (controller.signal.aborted) await Promise.allSettled(active.values());
    const report = readControlGraph(root, traceKeys);
    return { ...report, ...(stopReason ? { status: 'stopped' as const } : {}), reasons: [...report.reasons, ...reasons, ...(stopReason ? [stopReason] : [])] };
  } catch {
    controller.abort(); await Promise.allSettled(active.values());
    return { ...readControlGraph(root, traceKeys), status: 'unavailable', reasons: ['graph-runtime-unavailable'] };
  } finally { clearInterval(timer); options.signal?.removeEventListener('abort', abort); releaseLocalStoreLock(ownership.lock); }
}
