import { canonical, digest } from './artifacts.js';
import type { ControlGraphHandlerRegistration, ControlHandlerResult } from './control-graph.js';
import type { DecisionTraceKeyOptions, DecisionTraceV1 } from './decision-trace.js';
import { executeFirmResourceTask, type FirmResourceExecutionHost, type FirmResourceExecutionRequest } from './firm-resource-execution.js';

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const HASH = /^[a-f0-9]{64}$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_RESULT_BYTES = 48 * 1024;

export interface FirmResourceControlBinding {
  handler: Readonly<Extract<ControlGraphHandlerRegistration, { effectClass: 'resource-completion' }>>;
  /** Include the exact input for each corresponding explore node. These hashes are not permits. */
  nodeInputs: Record<string, { bindingDigest: string; requestDigest: string }>;
}

/** Detach host enrollment without invoking getters, including array accessors. */
function snapshot<T>(value: unknown): T {
  let nodes = 0; let bytes = 0;
  const copy = (item: unknown, depth: number): unknown => {
    if (++nodes > 30_000 || depth > 32) throw new Error('Invalid resource control enrollment');
    if (item === null || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return item;
    if (typeof item === 'string') {
      bytes += Buffer.byteLength(item);
      if (bytes > 1024 * 1024) throw new Error('Invalid resource control enrollment');
      return item;
    }
    if (!item || typeof item !== 'object') throw new Error('Invalid resource control enrollment');
    if (Array.isArray(item)) {
      if (Object.getPrototypeOf(item) !== Array.prototype || item.length > 4096 || Reflect.ownKeys(item).length !== item.length + 1) throw new Error('Invalid resource control enrollment');
      return Array.from({ length: item.length }, (_, index) => {
        const entry = Object.getOwnPropertyDescriptor(item, index);
        if (!entry || !entry.enumerable || !('value' in entry)) throw new Error('Invalid resource control enrollment');
        return copy(entry.value, depth + 1);
      });
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw new Error('Invalid resource control enrollment');
    const result: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(item)) {
      const entry = Object.getOwnPropertyDescriptor(item, key)!;
      if (typeof key !== 'string' || key.length > 256 || !entry.enumerable || !('value' in entry)) throw new Error('Invalid resource control enrollment');
      result[key] = copy(entry.value, depth + 1);
    }
    return result;
  };
  return copy(value, 0) as T;
}

function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/**
 * Host-only enrollment of one bounded completion per selected receipt/hypothesis.
 * Graph input selects no commands, providers, runtime files or candidate paths.
 * Completed means response generation only; verification and effects stay separate.
 */
export function createFirmResourceControlHandler(hostInput: FirmResourceExecutionHost,
  requestsByNodeId: Record<string, FirmResourceExecutionRequest>, options?: DecisionTraceKeyOptions): FirmResourceControlBinding {
  const host = snapshot<FirmResourceExecutionHost>(hostInput);
  const requests = snapshot<Record<string, FirmResourceExecutionRequest>>(requestsByNodeId);
  if (!exact(host, ['allocationRoot', 'candidatePath', 'constitutionVersion', 'policyEpoch', 'enrollments']) ||
    typeof host.constitutionVersion !== 'string' || !TOKEN.test(host.constitutionVersion) ||
    !Number.isSafeInteger(host.policyEpoch) || host.policyEpoch < 0 ||
    !requests || typeof requests !== 'object' || Array.isArray(requests) ||
    Object.keys(requests).length < 1 || Object.keys(requests).length > 128 || Object.keys(requests).some((id) => !ID.test(id))) {
    throw new Error('Invalid resource control enrollment');
  }
  for (const request of Object.values(requests)) {
    if (!exact(request, ['allocationId', 'expectedReceiptDigest', 'hypothesisId', 'hypotheses', 'expectedHypothesesDigest',
      'prompt', 'timeoutMs', 'maxOutputTokens']) ||
      ![request.expectedReceiptDigest, request.hypothesisId, request.expectedHypothesesDigest].every((value) => typeof value === 'string' && HASH.test(value))) {
      throw new Error('Invalid resource control request');
    }
  }
  let keys: DecisionTraceKeyOptions | undefined;
  if (options !== undefined) {
    if (!options || ![Object.prototype, null].includes(Object.getPrototypeOf(options)) ||
      Reflect.ownKeys(options).some((key) => key !== 'testKey')) throw new Error('Invalid resource control key');
    const key = Object.getOwnPropertyDescriptor(options, 'testKey');
    if (key) {
      if (!('value' in key) || !Buffer.isBuffer(key.value) || key.value.length !== 32) throw new Error('Invalid resource control key');
      keys = { testKey: Buffer.from(key.value) };
    }
  }
  const bindingDigest = digest(canonical({ schemaVersion: 1, domain: 'firm-resource-control-v1', host, requests }));
  const expectedInputs = Object.fromEntries(Object.entries(requests).map(([id, request]) =>
    [id, { bindingDigest, requestDigest: digest(canonical(request)) }]));
  const verifier = { id: 'resource-generation-only', verdict: 'unavailable' as const, independent: false };
  const reject = (reason: string): ControlHandlerResult => ({ outcome: 'rejected', verifier: { ...verifier },
    spend: { unknown: true }, artifact: { schemaVersion: 1, operation: 'resource-completion', bindingDigest, reason, verifiedAccepted: false } });

  return {
    nodeInputs: snapshot(expectedInputs),
    // Keep signed graph metadata inseparable from the host captured by run.
    handler: Object.freeze<FirmResourceControlBinding['handler']>({
      effectClass: 'resource-completion', constitutionVersion: host.constitutionVersion, policyEpoch: host.policyEpoch, bindingDigest,
      run: async ({ node, signal }) => {
        if (node.kind !== 'explore' || !Object.hasOwn(requests, node.id)) return reject('node-not-enrolled');
        let input: unknown;
        try { input = snapshot(node.input); } catch { return reject('binding-mismatch'); }
        if (!exact(input, ['bindingDigest', 'requestDigest']) || canonical(input) !== canonical(expectedInputs[node.id])) return reject('binding-mismatch');
        const request = requests[node.id]!;
        const result = await executeFirmResourceTask(request, host, { ...keys, signal });
        const completion = result.completion;
        const usage = completion?.usage;
        const spend: DecisionTraceV1['spend'] = { unknown: true };
        if (usage?.state === 'reported' && Number.isSafeInteger(usage.inputTokens) && Number(usage.inputTokens) >= 0 &&
          Number.isSafeInteger(usage.outputTokens) && Number(usage.outputTokens) >= 0 && usage.inputTokens !== null && usage.outputTokens !== null &&
          Number.isSafeInteger(usage.inputTokens + usage.outputTokens)) spend.tokens = usage.inputTokens + usage.outputTokens;
        const succeeded = result.disposition === 'attempted' && completion?.status === 'succeeded' &&
          completion.resource.dispatch === 'settled' && completion.resource.taskStatus === 'completed' && typeof completion.content === 'string';
        const artifact = {
          schemaVersion: 1, operation: 'resource-completion', bindingDigest, requestDigest: expectedInputs[node.id]!.requestDigest,
          allocationReceiptDigest: request.expectedReceiptDigest, hypothesisId: request.hypothesisId,
          disposition: result.disposition, reason: result.disposition === 'held' ? result.reason : succeeded ? 'generation-completed' : 'generation-unavailable',
          taskId: result.taskId, verifiedAccepted: false,
          completion: completion ? { status: completion.status, resource: completion.resource, usage: completion.usage,
            content: succeeded ? completion.content : null,
            contentDigest: typeof completion.content === 'string' ? digest(completion.content) : null } : null,
        };
        const output: ControlHandlerResult = { outcome: succeeded ? 'completed' : 'rejected', verifier: { ...verifier }, spend, artifact };
        // The graph envelope is tighter than the transport limit. Reject the
        // artifact while retaining receipt/digest/usage; never truncate success.
        if (Buffer.byteLength(canonical(output)) > MAX_RESULT_BYTES) {
          if (artifact.completion) artifact.completion.content = null;
          artifact.reason = 'output-too-large'; output.outcome = 'rejected';
        }
        return output;
      },
    }),
  };
}
