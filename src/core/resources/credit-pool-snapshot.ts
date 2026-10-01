/** Strict internal metadata only. No filesystem or provider operations are invoked. */
import type { ResourceAccountIdentitySnapshot } from './account-identity-witness.js';

function originalNativeWitness(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = ['provider', 'accountId', 'accountDigest', 'profileDigest', 'generation', 'observedAt', 'expiresAt', 'source'];
  const ds = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(ds).length !== keys.length || !keys.every(k => ds[k] && 'value' in ds[k]!)) return false;
  const w = value as Record<string, unknown>;
  const iso = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) &&
    Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
  return typeof w.provider === 'string' && ['codex', 'claude', 'grok'].includes(w.provider) && typeof w.accountId === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(w.accountId) &&
    typeof w.accountDigest === 'string' && /^[a-f0-9]{64}$/.test(w.accountDigest) && typeof w.profileDigest === 'string' && /^[a-f0-9]{64}$/.test(w.profileDigest) &&
    Number.isSafeInteger(w.generation) && Number(w.generation) > 0 && iso(w.observedAt) && iso(w.expiresAt) &&
    Date.parse(w.expiresAt) > Date.parse(w.observedAt) && Date.parse(w.expiresAt) - Date.parse(w.observedAt) <= 60_000 && w.source === 'native-account-checked';
}

/** A byte-bounded dense internal message; never caller-selected paths or code. */
export function normalizeCreditIdentitySnapshots(value: unknown): ResourceAccountIdentitySnapshot[] {
  try {
    if (!Array.isArray(value)) throw new Error();
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1 || !keys.every(k => k === 'length' || typeof k === 'string' && /^(?:0|[1-9][0-9]*)$/.test(k) &&
      Number(k) < value.length && 'value' in Object.getOwnPropertyDescriptor(value, k)!)) throw new Error();
    const ids = new Set<string>();
    const snapshots = value.map((snapshot: unknown) => {
      if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error();
      const ds = Object.getOwnPropertyDescriptors(snapshot);
      if (Reflect.ownKeys(ds).length !== 2 || !ds.witness || !('value' in ds.witness) || !ds.localEpoch || !('value' in ds.localEpoch)) throw new Error();
      const w = ds.witness.value;
      // Validate the original shape even if expiry passed while a read was queued.
      if (!originalNativeWitness(w) || ids.has(w.accountId)) throw new Error();
      ids.add(w.accountId);
      const e = ds.localEpoch.value;
      if (e !== null) {
        if (!e || typeof e !== 'object' || Array.isArray(e)) throw new Error();
        const ed = Object.getOwnPropertyDescriptors(e); const ek = Reflect.ownKeys(ed);
        if (ek.length < 2 || ek.length > 3 || !ek.every(k => typeof k === 'string' && ['profileDigest', 'epochDigest', 'accountDigest'].includes(k) &&
          'value' in ed[k]! && typeof ed[k]!.value === 'string' && /^[a-f0-9]{64}$/.test(ed[k]!.value)) || !ed.profileDigest || !ed.epochDigest) throw new Error();
      }
      return structuredClone({ witness: w, localEpoch: e }) as ResourceAccountIdentitySnapshot;
    });
    if (Buffer.byteLength(JSON.stringify(snapshots)) > 2 * 1024 * 1024) throw new Error();
    return snapshots;
  } catch { throw new Error('Invalid credit identity snapshot'); }
}


export function normalizeInvalidatedAccountIds(value: unknown): string[] {
  try {
    if (!Array.isArray(value)) throw new Error();
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1 || !keys.every(k => k === 'length' || typeof k === 'string' && /^(?:0|[1-9][0-9]*)$/.test(k) &&
      Number(k) < value.length && 'value' in Object.getOwnPropertyDescriptor(value, k)!)) throw new Error();
    const ids = new Set<string>();
    for (const id of value) { if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id) || ids.has(id)) throw new Error(); ids.add(id); }
    if (Buffer.byteLength(JSON.stringify(value)) > 2 * 1024 * 1024) throw new Error();
    return [...ids];
  } catch { throw new Error('Invalid credit identity tombstones'); }
}
