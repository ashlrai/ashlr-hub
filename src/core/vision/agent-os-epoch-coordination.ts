/**
 * Process-resident coordination lease for Agent OS epoch transitions.
 *
 * This is one half of M546 coordination. Callers must also hold the existing
 * cross-process observation transaction lock. The lease is not durable,
 * externally authenticated, or authority to mutate an epoch by itself.
 */
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path';

const REGISTRY_SYMBOL = Symbol.for('ashlr.agent-os.epoch-coordination.v1');
const SHA256_RE = /^sha256:[a-f0-9]{64}$/;
const MAX_PATH_BYTES = 4_096;

interface CoordinationRegistryV1 {
  readonly leases: Map<string, object>;
}

interface CoordinationGlobalV1 {
  [REGISTRY_SYMBOL]?: CoordinationRegistryV1;
}

export interface AgentOsEpochCoordinationLeaseV1 {
  readonly protocol: 'ashlr-agent-os-epoch-coordination-lease-v1';
  readonly rootPath: string;
  readonly writerProtocolDigest: string;
  readonly durable: false;
  readonly externallyAuthenticated: false;
  readonly rollbackProtected: false;
  readonly effectAuthority: false;
}

export type AgentOsEpochCoordinationLeaseResultV1 =
  | { readonly state: 'acquired'; readonly lease: AgentOsEpochCoordinationLeaseV1 }
  | { readonly state: 'contended' | 'invalid' | 'unavailable'; readonly lease: null };

const ownedLeases = new WeakSet<object>();

function registry(): CoordinationRegistryV1 {
  const scope = globalThis as CoordinationGlobalV1;
  const existing = scope[REGISTRY_SYMBOL];
  if (existing && existing.leases instanceof Map) return existing;
  const created = Object.freeze({ leases: new Map<string, object>() });
  Object.defineProperty(scope, REGISTRY_SYMBOL, {
    value: created,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return created;
}

function plainInput(value: unknown): value is {
  rootPath: string;
  writerProtocolDigest: string;
} {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value);
    return keys.length === 2 && keys.every((key) => typeof key === 'string' &&
      (key === 'rootPath' || key === 'writerProtocolDigest') &&
      descriptors[key]?.enumerable === true && Object.hasOwn(descriptors[key]!, 'value')) &&
      typeof descriptors['rootPath']?.value === 'string' &&
      typeof descriptors['writerProtocolDigest']?.value === 'string';
  } catch {
    return false;
  }
}

function canonicalRootPath(value: string): string | null {
  if (!isAbsolute(value) || value.includes('\0') || Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES) return null;
  try {
    const absolute = resolve(value);
    if (absolute === parse(absolute).root) return null;
    if (existsSync(absolute)) {
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
      return realpathSync.native(absolute);
    }

    const suffix: string[] = [];
    let cursor = absolute;
    while (!existsSync(cursor)) {
      const name = basename(cursor);
      const parent = dirname(cursor);
      if (parent === cursor || name === '' || name === '.' || name === '..') return null;
      suffix.unshift(name);
      cursor = parent;
    }
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
    return suffix.reduce((current, component) => join(current, component), realpathSync.native(cursor));
  } catch {
    return null;
  }
}

function ownsInternal(lease: AgentOsEpochCoordinationLeaseV1): boolean {
  return ownedLeases.has(lease) && registry().leases.get(lease.rootPath) === lease;
}

export function acquireAgentOsEpochCoordinationLeaseV1(
  input: { rootPath: string; writerProtocolDigest: string },
): AgentOsEpochCoordinationLeaseResultV1 {
  if (!plainInput(input)) return Object.freeze({ state: 'invalid', lease: null });
  const rootPath = canonicalRootPath(input.rootPath);
  if (!rootPath || !SHA256_RE.test(input.writerProtocolDigest)) {
    return Object.freeze({ state: 'invalid', lease: null });
  }
  try {
    const active = registry();
    if (active.leases.has(rootPath)) return Object.freeze({ state: 'contended', lease: null });
    const lease: AgentOsEpochCoordinationLeaseV1 = Object.freeze({
      protocol: 'ashlr-agent-os-epoch-coordination-lease-v1',
      rootPath,
      writerProtocolDigest: input.writerProtocolDigest,
      durable: false,
      externallyAuthenticated: false,
      rollbackProtected: false,
      effectAuthority: false,
    });
    active.leases.set(rootPath, lease);
    ownedLeases.add(lease);
    return Object.freeze({ state: 'acquired', lease });
  } catch {
    return Object.freeze({ state: 'unavailable', lease: null });
  }
}

export function ownsAgentOsEpochCoordinationLeaseV1(
  lease: AgentOsEpochCoordinationLeaseV1 | null | undefined,
  expected: { rootPath: string; writerProtocolDigest: string },
): boolean {
  if (!lease || !plainInput(expected)) return false;
  const rootPath = canonicalRootPath(expected.rootPath);
  return rootPath !== null && SHA256_RE.test(expected.writerProtocolDigest) &&
    lease.rootPath === rootPath && lease.writerProtocolDigest === expected.writerProtocolDigest &&
    ownsInternal(lease);
}

export function releaseAgentOsEpochCoordinationLeaseV1(
  lease: AgentOsEpochCoordinationLeaseV1 | null | undefined,
): boolean {
  if (!lease || !ownsInternal(lease)) return false;
  const active = registry();
  if (active.leases.get(lease.rootPath) !== lease) return false;
  const removed = active.leases.delete(lease.rootPath);
  if (removed) ownedLeases.delete(lease);
  return removed;
}
