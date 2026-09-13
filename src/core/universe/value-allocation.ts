/** Evidence-pinned portfolio caller. Records a shadow allocation, never consumes it. */
import { buildPortfolioShadowV1, digestResourceEnvelopeV1, verifyPortfolioShadowV1,
  type OutcomeEvidenceVerifierV1, type PortfolioShadowV1, type ResourceEnvelopeV1,
  type ValueHypothesisV1 } from '../vision/value-portfolio.js';
import { canonical, digest } from './artifacts.js';
import { signDecisionTraceV1, validateDecisionTraceV1, verifyDecisionTraceV1,
  type DecisionTraceKeyOptions, type DecisionTraceV1, type UnsignedDecisionTraceV1 } from './decision-trace.js';

const DOMAIN = 'ashlr:universe:value-allocation:v1\0';
const MAX_SOURCE_BYTES = 256 * 1024;
const HASH = /^[a-f0-9]{64}$/;
type PinnedSource = { content: string; expectedDigest: string };
export interface ValueAllocationInput {
  schemaVersion: 1;
  asOf: string;
  constitutionVersion: string;
  policyEpoch: number;
  visionSpec: PinnedSource;
  missionGraph: PinnedSource;
  resourceEnvelope: ResourceEnvelopeV1;
  expectedResourceEnvelopeDigest: string;
  hypotheses: ValueHypothesisV1[];
  /** SHA-256 of canonical(hypotheses), preserving the supplied array order. */
  expectedHypothesesDigest: string;
}
export interface ValueAllocationOptions extends DecisionTraceKeyOptions {
  /** Caller-owned authenticated outcome boundary, not an arbitrary receipt flag. */
  outcomeEvidenceVerifier?: OutcomeEvidenceVerifierV1;
}
export interface ValueAllocationReceiptV1 {
  schemaVersion: 1;
  kind: 'value-allocation';
  constitutionVersion: string;
  policyEpoch: number;
  basis: { asOf: string; visionSpecDigest: string; missionGraphDigest: string;
    resourceEnvelopeDigest: string; hypothesesDigest: string };
  sourceEvidence: { mode: 'caller-pinned'; externallyObserved: false; semanticsVerified: false };
  authority: { dispatch: false; leases: false; budgets: false; learning: false };
  portfolio: PortfolioShadowV1;
  receiptDigest: string;
}
export type ValueAllocationResult =
  | { ok: true; receipt: ValueAllocationReceiptV1; trace: DecisionTraceV1 }
  | { ok: false; receipt: null; trace: null; reason: 'invalid-input' | 'source-digest-mismatch' |
    'resource-envelope-digest-mismatch' | 'hypotheses-digest-mismatch' | 'portfolio-invalid' | 'provenance-unavailable' };

function exact(value: unknown, required: string[], optional: string[] = []): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  return required.every((key) => Object.hasOwn(value, key)) && Reflect.ownKeys(value).every((key) =>
    typeof key === 'string' && [...required, ...optional].includes(key) &&
    Object.getOwnPropertyDescriptor(value, key)!.enumerable && 'value' in Object.getOwnPropertyDescriptor(value, key)!);
}
/** Snapshot bounded JSON without invoking accessors, toJSON methods or custom prototypes. */
function detached(value: unknown): unknown {
  let nodes = 0;
  const copy = (item: unknown, depth: number): unknown => {
    if (++nodes > 30_000 || depth > 32) throw new Error('Bounded JSON required');
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (typeof item === 'string' && Buffer.byteLength(item) <= MAX_SOURCE_BYTES) return item;
    if (!item || typeof item !== 'object') throw new Error('JSON required');
    if (Array.isArray(item)) {
      if (Object.getPrototypeOf(item) !== Array.prototype || item.length > 4_096 || Reflect.ownKeys(item).length !== item.length + 1) throw new Error('Dense array required');
      return Array.from({ length: item.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(item, index);
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new Error('Data required');
        return copy(descriptor.value, depth + 1);
      });
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw new Error('Plain JSON required');
    const output: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(item)) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      if (typeof key !== 'string' || key.length > 256 || !descriptor.enumerable || !('value' in descriptor)) throw new Error('Data required');
      output[key] = copy(descriptor.value, depth + 1);
    }
    return output;
  };
  const result = copy(value, 0);
  if (Buffer.byteLength(canonical(result)) > 1024 * 1024) throw new Error('Input exceeds bound');
  return result;
}
function hash(value: unknown): value is string { return typeof value === 'string' && HASH.test(value); }
function source(value: unknown): value is PinnedSource {
  return exact(value, ['content', 'expectedDigest']) && typeof value.content === 'string' && value.content.length > 0 &&
    Buffer.byteLength(value.content) <= MAX_SOURCE_BYTES && Buffer.from(value.content).toString('utf8') === value.content && hash(value.expectedDigest);
}
function context(value: Record<string, unknown>): boolean {
  return typeof value.constitutionVersion === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.constitutionVersion) &&
    Number.isSafeInteger(value.policyEpoch) && Number(value.policyEpoch) >= 0;
}
function optionsSnapshot(value: ValueAllocationOptions | undefined): { key: DecisionTraceKeyOptions; verifier: OutcomeEvidenceVerifierV1 | null } {
  if (value === undefined) return { key: {}, verifier: null };
  if (!exact(value, [], ['testKey', 'outcomeEvidenceVerifier']) || Object.hasOwn(value, 'testKey') &&
    (!Buffer.isBuffer(value.testKey) || value.testKey.length !== 32)) throw new Error('Invalid options');
  const supplied = value.outcomeEvidenceVerifier;
  if (Object.hasOwn(value, 'outcomeEvidenceVerifier') && (!exact(supplied, ['verifyOutcomeEvidence']) ||
    typeof supplied.verifyOutcomeEvidence !== 'function')) throw new Error('Invalid outcome verifier');
  return { key: value.testKey ? { testKey: Buffer.from(value.testKey as Buffer) } : {},
    verifier: (supplied as OutcomeEvidenceVerifierV1 | undefined) ?? null };
}
function unsignedTrace(receipt: ValueAllocationReceiptV1): UnsignedDecisionTraceV1 {
  return { id: `allocation:${receipt.receiptDigest}`, ts: receipt.basis.asOf,
    entities: [`vision:${receipt.basis.visionSpecDigest}`, `mission:${receipt.basis.missionGraphDigest}`],
    action: 'value-allocation-recorded', constitutionVersion: receipt.constitutionVersion, policyEpoch: receipt.policyEpoch,
    inputsDigest: digest(canonical(receipt.basis)), artifactDigest: receipt.receiptDigest,
    // Pass describes deterministic contract validation, not independent outcome observation.
    verifier: { id: 'portfolio-shadow-v1', verdict: 'pass', independent: false },
    authority: { effectClass: 'observe', denied: true }, spend: { unknown: true }, conflicts: [] };
}
function receiptHash(payload: Omit<ValueAllocationReceiptV1, 'receiptDigest'>): string { return digest(DOMAIN + canonical(payload)); }

/**
 * Pin exact source bytes and caller-supplied inventory, then reuse the pure scorer.
 * Signing uses an existing host key, never creates one. No source file is read,
 * persisted or dispatched. A signed receipt is not capacity or an execution permit.
 */
export function createValueAllocationReceipt(value: unknown, options?: ValueAllocationOptions): ValueAllocationResult {
  const refuse = (reason: Extract<ValueAllocationResult, { ok: false }>['reason']): ValueAllocationResult => ({ ok: false, receipt: null, trace: null, reason });
  try {
    const input = detached(value);
    if (!exact(input, ['schemaVersion', 'asOf', 'constitutionVersion', 'policyEpoch', 'visionSpec', 'missionGraph',
      'resourceEnvelope', 'expectedResourceEnvelopeDigest', 'hypotheses', 'expectedHypothesesDigest']) || input.schemaVersion !== 1 ||
      !context(input) || !source(input.visionSpec) || !source(input.missionGraph) || !hash(input.expectedResourceEnvelopeDigest) ||
      !hash(input.expectedHypothesesDigest) || !Array.isArray(input.hypotheses)) return refuse('invalid-input');
    if (digest(input.visionSpec.content) !== input.visionSpec.expectedDigest || digest(input.missionGraph.content) !== input.missionGraph.expectedDigest) return refuse('source-digest-mismatch');
    if (digestResourceEnvelopeV1(input.resourceEnvelope) !== input.expectedResourceEnvelopeDigest) return refuse('resource-envelope-digest-mismatch');
    if (digest(canonical(input.hypotheses)) !== input.expectedHypothesesDigest) return refuse('hypotheses-digest-mismatch');
    const selected = optionsSnapshot(options);
    const result = buildPortfolioShadowV1({ schemaVersion: 1, asOf: input.asOf, specDigest: input.visionSpec.expectedDigest,
      missionDigest: input.missionGraph.expectedDigest, resourceEnvelope: input.resourceEnvelope, hypotheses: input.hypotheses }, selected.verifier);
    if (!result.ok) return refuse('portfolio-invalid');
    const payload: Omit<ValueAllocationReceiptV1, 'receiptDigest'> = { schemaVersion: 1, kind: 'value-allocation',
      constitutionVersion: input.constitutionVersion as string, policyEpoch: input.policyEpoch as number,
      basis: { asOf: result.portfolio.basis.asOf, visionSpecDigest: input.visionSpec.expectedDigest,
        missionGraphDigest: input.missionGraph.expectedDigest, resourceEnvelopeDigest: input.expectedResourceEnvelopeDigest,
        hypothesesDigest: input.expectedHypothesesDigest },
      sourceEvidence: { mode: 'caller-pinned', externallyObserved: false, semanticsVerified: false },
      authority: { dispatch: false, leases: false, budgets: false, learning: false }, portfolio: result.portfolio };
    const receipt = { ...payload, receiptDigest: receiptHash(payload) };
    const trace = signDecisionTraceV1(unsignedTrace(receipt), selected.key);
    return trace ? { ok: true, receipt, trace } : refuse('provenance-unavailable');
  } catch { return refuse('invalid-input'); }
}

/** Local HMAC/integrity check only; does not observe capacity, authenticate input sources or reserve inventory. */
export function verifyValueAllocationReceipt(value: unknown, traceValue: unknown, options?: DecisionTraceKeyOptions): boolean {
  try {
    const row = detached(value);
    if (!exact(row, ['schemaVersion', 'kind', 'constitutionVersion', 'policyEpoch', 'basis', 'sourceEvidence', 'authority', 'portfolio', 'receiptDigest']) ||
      row.schemaVersion !== 1 || row.kind !== 'value-allocation' || !context(row) || !hash(row.receiptDigest) ||
      !exact(row.basis, ['asOf', 'visionSpecDigest', 'missionGraphDigest', 'resourceEnvelopeDigest', 'hypothesesDigest']) ||
      !['visionSpecDigest', 'missionGraphDigest', 'resourceEnvelopeDigest', 'hypothesesDigest'].every((key) => hash((row.basis as Record<string, unknown>)[key])) ||
      canonical(row.sourceEvidence) !== canonical({ mode: 'caller-pinned', externallyObserved: false, semanticsVerified: false }) ||
      canonical(row.authority) !== canonical({ dispatch: false, leases: false, budgets: false, learning: false })) return false;
    const portfolio = verifyPortfolioShadowV1(row.portfolio);
    if (!portfolio || portfolio.basis.asOf !== row.basis.asOf || portfolio.basis.specDigest !== row.basis.visionSpecDigest ||
      portfolio.basis.missionDigest !== row.basis.missionGraphDigest || portfolio.basis.resourceEnvelopeDigest !== row.basis.resourceEnvelopeDigest) return false;
    const receipt = row as unknown as ValueAllocationReceiptV1;
    const { receiptDigest, ...payload } = receipt;
    if (receiptHash(payload) !== receiptDigest) return false;
    const trace = validateDecisionTraceV1(traceValue); const { provenanceSig: _signature, ...unsigned } = trace;
    return canonical(unsigned) === canonical(unsignedTrace(receipt)) && verifyDecisionTraceV1(trace, options);
  } catch { return false; }
}
