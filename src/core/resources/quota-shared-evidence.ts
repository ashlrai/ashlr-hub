/** Short-lived metadata witness; reading never acquires ownership or starts native work. */
import { randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { isAbsolute, join, parse, resolve } from 'node:path';
import { canonical, digest, inspectPrivateDirectory } from '../universe/artifacts.js';
import { writePrivateFileAtomically } from '../util/private-file-write.js';
import { readResourceJson } from './pool-runtime.js';
import { validateResourceObservations, validateResourcePool, type ResourceObservation, type ResourcePool } from './pool-policy.js';
import { validateResourceBindings, type ResourceBinding } from './worker.js';
import { RESOURCE_QUOTA_REFRESH_TTL_MS, validateResourceQuotaRefreshConfig, type ResourceQuotaRefreshConfig } from './quota-refresh.js';
import { inspectResourceQuotaRefreshOwner, type ResourceQuotaRefreshLease } from './quota-refresh-lease.js';

export const RESOURCE_SHARED_QUOTA_EVIDENCE_TTL_MS = 5_000;
export const RESOURCE_SHARED_QUOTA_EVIDENCE_FILENAME = '.resource-quota-shared-evidence.json';
const MAX_BYTES = 128 * 1024;
const UNAVAILABLE = 'Shared resource quota evidence unavailable';
interface SharedQuotaScope { root: string; pool: ResourcePool; bindings: ResourceBinding[]; config: ResourceQuotaRefreshConfig }
export interface SharedQuotaEvidence { observations: ResourceObservation[]; unavailableWorkerIds: string[] }

function scope(options: SharedQuotaScope) {
  if (typeof options.root !== 'string' || !isAbsolute(options.root) || resolve(options.root) !== options.root ||
    options.root === parse(options.root).root) throw new Error();
  inspectPrivateDirectory(options.root);
  const pool = validateResourcePool(options.pool);
  const bindings = validateResourceBindings(options.bindings, pool);
  const config = validateResourceQuotaRefreshConfig(options.config, pool, bindings);
  return { root: options.root, pool, bindings, config };
}
function iso(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function checkedEvidence(value: unknown, checked: ReturnType<typeof scope>, now: number): SharedQuotaEvidence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
  const input = value as SharedQuotaEvidence;
  const ids = new Set(checked.config.workers.map((worker) => worker.workerId));
  const observations = validateResourceObservations(input.observations, checked.pool);
  if (observations.some((row) => !ids.has(row.workerId)) || !Array.isArray(input.unavailableWorkerIds) ||
    input.unavailableWorkerIds.length > ids.size || input.unavailableWorkerIds.some((id) => !ids.has(id)) ||
    new Set(input.unavailableWorkerIds).size !== input.unavailableWorkerIds.length) throw new Error();
  const unavailable = new Set(input.unavailableWorkerIds);
  for (const id of ids) {
    const row = observations.find((item) => item.workerId === id);
    // Publication does not renew a native reading. A heartbeat cannot turn an
    // expired or unknown capture into readiness, even if the owner is alive.
    if (!row || row.health !== 'ready' || Date.parse(row.observedAt) > now ||
      row.updatedAt !== undefined && row.updatedAt !== row.observedAt ||
      Date.parse(row.expiresAt) <= now || Date.parse(row.expiresAt) - Date.parse(row.observedAt) > RESOURCE_QUOTA_REFRESH_TTL_MS ||
      row.retryAfter !== null && Date.parse(row.retryAfter) > now || !row.windows.length ||
      row.windows.some((window) => window.usedPercent === null || window.usedPercent >= 100 ||
        window.resetsAt === null || Date.parse(window.resetsAt) <= now)) unavailable.add(id);
  }
  const deniedCapacities = new Set(checked.bindings.filter((row) => unavailable.has(row.workerId)).map((row) => row.capacityKey));
  for (const binding of checked.bindings) if (ids.has(binding.workerId) && deniedCapacities.has(binding.capacityKey)) unavailable.add(binding.workerId);
  return { observations, unavailableWorkerIds: [...unavailable].sort() };
}

export function publishSharedQuotaEvidence(options: SharedQuotaScope & {
  lease: ResourceQuotaRefreshLease; evidence: SharedQuotaEvidence; state: 'running' | 'closed';
}): void {
  try {
    const checked = scope(options);
    if (!['running', 'closed'].includes(options.state)) throw new Error();
    const owner = options.lease.identity();
    const now = Date.now();
    const evidence = checkedEvidence(options.evidence, checked, now);
    const record = { schemaVersion: 1, scope: 'codex-native-metadata', poolDigest: checked.config.poolDigest,
      configDigest: digest(canonical(checked.config)), owner, state: options.state,
      publishedAt: new Date(now).toISOString(), expiresAt: new Date(now + RESOURCE_SHARED_QUOTA_EVIDENCE_TTL_MS).toISOString(),
      ...evidence };
    const bytes = canonical(record) + '\n';
    if (Buffer.byteLength(bytes) > MAX_BYTES) throw new Error();
    const file = join(checked.root, RESOURCE_SHARED_QUOTA_EVIDENCE_FILENAME);
    // Never replace an unexpected symlink, hard link, nonprivate or oversized
    // target. A prior owner's safe stale witness may be replaced by this owner.
    try { lstatSync(file); readResourceJson(file, MAX_BYTES); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (canonical(options.lease.identity()) !== canonical(owner)) throw new Error();
    writePrivateFileAtomically(`${file}.${randomUUID()}.tmp`, file, bytes, { anchorPath: checked.root, label: 'Shared quota evidence' });
    if (canonical(options.lease.identity()) !== canonical(owner)) throw new Error();
  } catch { throw new Error(UNAVAILABLE); }
}

export function readSharedQuotaEvidence(options: SharedQuotaScope & { expectedOwner?: string }): SharedQuotaEvidence & { owner: string } {
  try {
    const checked = scope(options);
    if (options.expectedOwner !== undefined && !/^[a-f0-9]{64}$/.test(options.expectedOwner)) throw new Error();
    const before = inspectResourceQuotaRefreshOwner(checked.root);
    const owner = digest(canonical(before));
    if (options.expectedOwner !== undefined && options.expectedOwner !== owner) throw new Error();
    const value = readResourceJson(join(checked.root, RESOURCE_SHARED_QUOTA_EVIDENCE_FILENAME), MAX_BYTES);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    const row = value as Record<string, unknown>;
    const keys = ['schemaVersion', 'scope', 'poolDigest', 'configDigest', 'owner', 'state', 'publishedAt', 'expiresAt', 'observations', 'unavailableWorkerIds'];
    const now = Date.now();
    if (Object.keys(row).length !== keys.length || !keys.every((key) => Object.hasOwn(row, key)) || row.schemaVersion !== 1 ||
      row.scope !== 'codex-native-metadata' || row.poolDigest !== checked.config.poolDigest || row.configDigest !== digest(canonical(checked.config)) ||
      canonical(row.owner) !== canonical(before) || row.state !== 'running' || !iso(row.publishedAt) || !iso(row.expiresAt) ||
      Date.parse(row.publishedAt) > now || Date.parse(row.expiresAt) <= now ||
      Date.parse(row.expiresAt) - Date.parse(row.publishedAt) !== RESOURCE_SHARED_QUOTA_EVIDENCE_TTL_MS) throw new Error();
    const evidence = checkedEvidence(row, checked, now);
    const after = inspectResourceQuotaRefreshOwner(checked.root);
    if (canonical(before) !== canonical(after) || Date.parse(row.expiresAt) <= Date.now()) throw new Error();
    return { ...evidence, owner };
  } catch { throw new Error(UNAVAILABLE); }
}
