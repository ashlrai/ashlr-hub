import type { ResourceEngineeringAutomaticAdmissionStatus as Status } from '../../core/resources/engineering-automatic-admission.js';
import type { ResourceConsoleEngineeringSupervisionSnapshot as Snapshot } from '../../core/resources/console-engineering-supervisor-types.js';
import { apiGet } from './client.js';
import { decodeEngineeringSupervision } from './engineering-supervision.js';

const invalid = () => new Error('Automatic admission status could not be verified. Refresh supervision.');
const id = (value: unknown): value is string => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value);
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const timestamp = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).length !== keys.length) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (keys.some(key => !descriptors[key]?.enumerable || !Object.hasOwn(descriptors[key]!, 'value'))) throw invalid();
  return Object.fromEntries(keys.map(key => [key, descriptors[key]!.value]));
}
function scope(supervision: Snapshot): Snapshot {
  const result = structuredClone(decodeEngineeringSupervision(supervision));
  if (result.admission?.autoAdmitPrepared !== true) throw invalid();
  return result;
}

/** Historical recovery metadata only; neither freshness nor execution authority. */
export function decodeEngineeringAutomaticAdmission(value: unknown, supervision: Snapshot): Status {
  try {
    const expected = scope(supervision);
    const row = record(value, ['schemaVersion', 'supervisionId', 'configDigest', 'deadlineAt', 'sampledAt', 'state', 'reason', 'pending']);
    if (row.schemaVersion !== 1 || !id(row.supervisionId) || !hash(row.configDigest) || !timestamp(row.deadlineAt) ||
        row.supervisionId !== expected.configId || row.configDigest !== expected.configDigest || row.deadlineAt !== expected.deadlineAt ||
        row.sampledAt !== null && !timestamp(row.sampledAt) ||
        typeof row.state !== 'string' || !['idle', 'reconciling', 'ready', 'held', 'closed'].includes(row.state) ||
        row.reason !== null && (typeof row.reason !== 'string' || !['capacity', 'admission-unavailable'].includes(row.reason)) ||
        !Array.isArray(row.pending) || row.pending.length > 32 || Reflect.ownKeys(row.pending).length !== row.pending.length + 1) throw invalid();
    const seen = new Set<string>();
    const pending = Array.from({ length: row.pending.length }, (_, index) => {
      const property = Object.getOwnPropertyDescriptor(row.pending, String(index));
      if (!property?.enumerable || !Object.hasOwn(property, 'value')) throw invalid();
      const item = record(property.value, ['enrollmentId', 'enrollmentDigest', 'reason']);
      if (!id(item.enrollmentId) || seen.has(item.enrollmentId) || !hash(item.enrollmentDigest) || typeof item.reason !== 'string' ||
          !['binding-changed', 'evidence-unavailable', 'verification-pending', 'capacity', 'admission-unavailable'].includes(item.reason)) throw invalid();
      seen.add(item.enrollmentId);
      return item as unknown as Status['pending'][number];
    });
    return { ...row, pending } as unknown as Status;
  } catch { throw invalid(); }
}

export async function readEngineeringAutomaticAdmission(supervision: Snapshot, signal?: AbortSignal): Promise<Status> {
  try {
    // Capture the displayed queue before yielding; a caller mutation cannot
    // rebind an in-flight response to another queue or renewed deadline.
    const expected = scope(supervision);
    if (signal?.aborted) throw invalid();
    const local = new AbortController();
    const forwardAbort = () => local.abort();
    let rejectAbort!: (reason: Error) => void;
    const cancelled = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    const onAbort = () => rejectAbort(invalid());
    local.signal.addEventListener('abort', onAbort, { once: true });
    signal?.addEventListener('abort', forwardAbort, { once: true });
    const timer = setTimeout(forwardAbort, 5000);
    try {
      const value = await Promise.race([apiGet<unknown>('/api/resources/engineering/automatic-admission', local.signal), cancelled]);
      if (signal?.aborted || local.signal.aborted) throw invalid();
      return decodeEngineeringAutomaticAdmission(value, expected);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', forwardAbort);
      local.signal.removeEventListener('abort', onAbort);
    }
  } catch { throw invalid(); }
}
