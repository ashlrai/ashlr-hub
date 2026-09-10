import { createHmac, timingSafeEqual } from 'node:crypto';
import { loadExistingProvenanceKeyReadOnly } from '../foundry/provenance.js';
import { canonical } from './artifacts.js';

const DOMAIN = 'ashlr:universe:decision-trace:v1\n';
const MAX_ENTITIES = 64;
const MAX_CONFLICTS = 128;
const MAX_QUERY_INPUT = 4_096;
const MAX_QUERY_RESULTS = 256;

export interface DecisionTraceV1 {
  id: string;
  ts: string;
  entities: string[];
  action: string;
  constitutionVersion: string;
  policyEpoch: number;
  inputsDigest: string;
  artifactDigest?: string;
  /** Signed attestation metadata; independence is not established by this flag. */
  verifier: { id: string; verdict: 'pass' | 'fail' | 'unavailable'; independent: boolean };
  /** Records an authority claim/denial; a trace is never an executable permit. */
  authority: { effectClass: string; permitId?: string; denied?: boolean };
  /** Missing measurements remain absent; unknown never becomes a measured zero. */
  spend: { tokens?: number; usd?: number; unknown: boolean };
  supersedes?: string;
  conflicts: Array<{ otherId: string; reason: 'value' | 'date' | 'scope' }>;
  provenanceSig: string;
}
export type UnsignedDecisionTraceV1 = Omit<DecisionTraceV1, 'provenanceSig'>;
export interface DecisionTraceKeyOptions {
  /** Inert tests only. Supplying this key proves nothing about the host's provenance key. */
  testKey?: Buffer;
}
export interface DecisionTraceQueryV1 {
  entity?: string;
  action?: string;
  since?: string;
  until?: string;
  limit?: number;
}

function invalid(): never { throw new Error('Invalid DecisionTraceV1 evidence'); }
function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const allowed = [...required, ...optional];
  if (Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !allowed.includes(key) ||
      !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value')) ||
      required.some((key) => !Object.hasOwn(value, key))) invalid();
  return value as Record<string, unknown>;
}
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max ||
      Reflect.ownKeys(value).length !== value.length + 1 ||
      Array.from({ length: value.length }, (_, index) => Object.getOwnPropertyDescriptor(value, String(index)))
        .some((entry) => !entry || !Object.hasOwn(entry, 'value'))) invalid();
  return value;
}
function token(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) invalid();
  return value;
}
function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) invalid();
  return value;
}
function time(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== (value.length === 20 ? value.replace('Z', '.000Z') : value)) invalid();
  return value;
}
function bool(value: unknown): boolean { if (typeof value !== 'boolean') invalid(); return value; }
function integer(value: unknown): number { if (!Number.isSafeInteger(value) || Number(value) < 0) invalid(); return value as number; }

function snapshot(value: unknown, signed: boolean): DecisionTraceV1 | UnsignedDecisionTraceV1 {
  const row = record(value, ['id', 'ts', 'entities', 'action', 'constitutionVersion', 'policyEpoch', 'inputsDigest',
    'verifier', 'authority', 'spend', 'conflicts', ...(signed ? ['provenanceSig'] : [])], ['artifactDigest', 'supersedes']);
  const verifier = record(row.verifier, ['id', 'verdict', 'independent']);
  if (!['pass', 'fail', 'unavailable'].includes(verifier.verdict as string)) invalid();
  const authority = record(row.authority, ['effectClass'], ['permitId', 'denied']);
  const spend = record(row.spend, ['unknown'], ['tokens', 'usd']);
  const unknown = bool(spend.unknown);
  if (Object.hasOwn(spend, 'usd') && (typeof spend.usd !== 'number' || !Number.isFinite(spend.usd) || spend.usd < 0 || spend.usd > Number.MAX_SAFE_INTEGER)) invalid();
  // A partial observation may retain its known measurement, but cannot claim
  // completely known spend when either dimension is absent.
  if (!unknown && (!Object.hasOwn(spend, 'tokens') || !Object.hasOwn(spend, 'usd'))) invalid();
  const entities = array(row.entities, MAX_ENTITIES).map(token);
  if (new Set(entities).size !== entities.length) invalid();
  const id = token(row.id);
  const conflicts = array(row.conflicts, MAX_CONFLICTS).map((entry) => {
    const link = record(entry, ['otherId', 'reason']);
    if (!['value', 'date', 'scope'].includes(link.reason as string)) invalid();
    const otherId = token(link.otherId); if (otherId === id) invalid();
    return { otherId, reason: link.reason as 'value' | 'date' | 'scope' };
  });
  const supersedes = Object.hasOwn(row, 'supersedes') ? token(row.supersedes) : undefined;
  if (supersedes === id) invalid();
  return { id, ts: time(row.ts), entities, action: token(row.action), constitutionVersion: token(row.constitutionVersion),
    policyEpoch: integer(row.policyEpoch), inputsDigest: hash(row.inputsDigest),
    ...(Object.hasOwn(row, 'artifactDigest') ? { artifactDigest: hash(row.artifactDigest) } : {}),
    verifier: { id: token(verifier.id), verdict: verifier.verdict as 'pass' | 'fail' | 'unavailable', independent: bool(verifier.independent) },
    authority: { effectClass: token(authority.effectClass),
      ...(Object.hasOwn(authority, 'permitId') ? { permitId: token(authority.permitId) } : {}),
      ...(Object.hasOwn(authority, 'denied') ? { denied: bool(authority.denied) } : {}) },
    spend: { ...(Object.hasOwn(spend, 'tokens') ? { tokens: integer(spend.tokens) } : {}),
      ...(Object.hasOwn(spend, 'usd') ? { usd: spend.usd as number } : {}), unknown },
    ...(supersedes === undefined ? {} : { supersedes }), conflicts,
    ...(signed ? { provenanceSig: hash(row.provenanceSig) } : {}) };
}

/** Strict schema validation only: returns detached data, not authenticated evidence. */
export function validateDecisionTraceV1(value: unknown): DecisionTraceV1 {
  return snapshot(value, true) as DecisionTraceV1;
}
function existingKey(options?: DecisionTraceKeyOptions): Buffer | null {
  if (options !== undefined) {
    const row = record(options, [], ['testKey']);
    if (Object.hasOwn(row, 'testKey')) {
      if (!Buffer.isBuffer(row.testKey) || row.testKey.length !== 32) invalid();
      return Buffer.from(row.testKey);
    }
  }
  return loadExistingProvenanceKeyReadOnly();
}
function signature(value: UnsignedDecisionTraceV1, key: Buffer): string {
  return createHmac('sha256', key).update(DOMAIN, 'utf8').update(canonical(value), 'utf8').digest('hex');
}

/** Existing host key only; never creates/repairs a key or performs an effect. */
export function signDecisionTraceV1(value: unknown, options?: DecisionTraceKeyOptions): DecisionTraceV1 | null {
  try {
    const unsigned = snapshot(value, false) as UnsignedDecisionTraceV1;
    const key = existingKey(options);
    return key?.length === 32 ? { ...unsigned, provenanceSig: signature(unsigned, key) } : null;
  } catch { return null; }
}

/** HMAC integrity only, not permit validity, verifier independence, liveness or rollback protection. */
export function verifyDecisionTraceV1(value: unknown, options?: DecisionTraceKeyOptions): boolean {
  try {
    const { provenanceSig, ...unsigned } = validateDecisionTraceV1(value);
    const key = existingKey(options);
    return key?.length === 32 ? timingSafeEqual(Buffer.from(provenanceSig, 'hex'), Buffer.from(signature(unsigned, key), 'hex')) : false;
  } catch { return false; }
}

/** Pure structural query. Verify signatures separately before relying on returned evidence. */
export function queryDecisionTracesV1(values: unknown, query: DecisionTraceQueryV1 = {}): {
  traces: DecisionTraceV1[]; total: number; truncated: boolean; signatureVerification: 'not-performed';
} {
  const requested = record(query, [], ['entity', 'action', 'since', 'until', 'limit']);
  const entity = Object.hasOwn(requested, 'entity') ? token(requested.entity) : undefined;
  const action = Object.hasOwn(requested, 'action') ? token(requested.action) : undefined;
  const since = Object.hasOwn(requested, 'since') ? Date.parse(time(requested.since)) : -Infinity;
  const until = Object.hasOwn(requested, 'until') ? Date.parse(time(requested.until)) : Infinity;
  const limit = Object.hasOwn(requested, 'limit') ? integer(requested.limit) : 100;
  if (since > until || limit < 1 || limit > MAX_QUERY_RESULTS) invalid();
  const matching = array(values, MAX_QUERY_INPUT).map(validateDecisionTraceV1).filter((trace) =>
    (entity === undefined || trace.entities.includes(entity)) && (action === undefined || trace.action === action) &&
    Date.parse(trace.ts) >= since && Date.parse(trace.ts) <= until);
  // Preserve supplied order and every conflict link, including links outside
  // this page/filter. Supersession is lineage, never permission to hide history.
  return { traces: matching.slice(0, limit), total: matching.length, truncated: matching.length > limit,
    signatureVerification: 'not-performed' };
}
