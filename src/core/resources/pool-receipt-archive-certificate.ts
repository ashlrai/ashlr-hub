/** Explicitly enrolled local derivation evidence, not root selection or execution authority.
 * The host owns source CAS, retention of nonselected hot rows, and key confinement.
 * HMAC proves local derivation, not antirollback or protection from the key-owning UID. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { lstatSync, realpathSync, type BigIntStats } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { types } from 'node:util';
import { assurePrivateStoragePath } from '../util/private-storage.js';
import { readStableRegularFile } from '../util/stable-file-read.js';
import { createResourcePoolReceiptArchive, emptyResourcePoolReceiptArchiveRoot, type ResourcePoolReceiptArchiveRoot } from './pool-receipt-archive.js';
import { checkedResourceTaskReceipt, type ResourceTaskReceipt } from './pool-receipt-codec.js';
import { validateResourcePoolConfigHistory } from './pool-evolution-policy.js';
import type { ResourcePoolConfigSnapshot } from './pool-evolution-types.js';
import { captureResourcePoolStateJson } from './pool-state-capture.js';

const DOMAIN = 'ashlr.resource-pool-receipt-archive-certificate.v1\n';
const HASH = /^[a-f0-9]{64}$/;
const validDigest = (value: unknown): value is string => typeof value === 'string' && value.length === 64 && HASH.test(value);
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const TERMINAL = new Set(['completed', 'failed', 'timed-out', 'cancelled']);
export interface ResourcePoolReceiptArchiveCertificate {
  schemaVersion: 1;
  kind: 'resource-pool-receipt-archive-certificate';
  scopeDigest: string;
  keyId: string;
  poolId: string;
  configurationCount: number;
  configurationHistoryDigest: string;
  sequence: number;
  priorCertificateDigest: string | null;
  sourceStateDigest: string;
  receiptDigests: Array<{ id: string; payloadDigest: string }>;
  archiveRoot: ResourcePoolReceiptArchiveRoot;
  provenanceSig: string;
}
export interface ResourcePoolReceiptArchiveCertifier {
  /** Fresh existing key and visited archive evidence; never repairs or provisions. */
  verify(certificate: ResourcePoolReceiptArchiveCertificate): ResourcePoolReceiptArchiveCertificate;
  /** Null previous means empty genesis. No arbitrary-root signing operation exists. */
  derive(input: { previous: ResourcePoolReceiptArchiveCertificate | null; sourceStateDigest: string; receipts: readonly ResourceTaskReceipt[] },
    options: { guard(): void }): ResourcePoolReceiptArchiveCertificate;
}
const fail = (): never => { throw new Error('Resource receipt archive certificate unavailable'); };
function capture<T>(value: unknown): T {
  try { return JSON.parse(captureResourcePoolStateJson(value)) as T; } catch { return fail(); }
}
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
const encoded = (value: unknown): string => captureResourcePoolStateJson(value);
const digest = (value: unknown): string => hash(encoded(value));
const same = (left: BigIntStats, right: BigIntStats): boolean => left.dev === right.dev && left.ino === right.ino;
function directory(path: string): BigIntStats {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path ||
    process.platform !== 'win32' && (stat.mode & 0o777n) !== 0o700n ||
    typeof process.getuid === 'function' && stat.uid !== BigInt(process.getuid()) ||
    !assurePrivateStoragePath(path, 'directory', 'inspect-existing', { anchorPath: dirname(path) }).ok) fail();
  return stat;
}
function path(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 4096 && isAbsolute(value) && resolve(value) === value &&
    ![...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}
function payloadDigest(receipt: ResourceTaskReceipt): string {
  return hash(`resource-terminal-receipt-v1\n${encoded(receipt)}\n`);
}

/** keyFile must already exist directly inside the private ledger anchor, beside
 * the archive root. Its format is 64 lowercase hex characters plus one newline.
 * This module never creates, repairs, rotates, or discovers signing authority. */
export function createResourcePoolReceiptArchiveCertifier(input: {
  root: string; anchorPath: string; poolId: string; configurationHistory: ResourcePoolConfigSnapshot[]; keyFile: string;
}): ResourcePoolReceiptArchiveCertifier {
  try {
    const config = capture<typeof input>(input);
    if (!exact(config, ['root', 'anchorPath', 'poolId', 'configurationHistory', 'keyFile']) ||
      !path(config.root) || !path(config.anchorPath) || !path(config.keyFile) || dirname(config.root) !== config.anchorPath ||
      dirname(config.keyFile) !== config.anchorPath || typeof config.poolId !== 'string' || !ID.test(config.poolId)) return fail();
    const history = validateResourcePoolConfigHistory(config.configurationHistory);
    if (history.some(epoch => epoch.pool.id !== config.poolId)) return fail();
    const archive = createResourcePoolReceiptArchive({ root: config.root, anchorPath: config.anchorPath, configurationHistory: history });
    const anchorIdentity = directory(config.anchorPath); const rootIdentity = directory(config.root);
    const keyIdentity = lstatSync(config.keyFile, { bigint: true });
    function readKey(): Buffer {
      try {
        if (!same(directory(config.anchorPath), anchorIdentity) || !same(directory(config.root), rootIdentity)) return fail();
        const before = lstatSync(config.keyFile, { bigint: true });
        if (!same(before, keyIdentity) || !before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size !== 65n ||
          realpathSync(config.keyFile) !== config.keyFile || (before.mode & 0o777n) !== 0o600n ||
          typeof process.getuid === 'function' && before.uid !== BigInt(process.getuid()) ||
          !assurePrivateStoragePath(config.keyFile, 'file', 'inspect-existing', { anchorPath: config.anchorPath }).ok) return fail();
        const read = readStableRegularFile(config.keyFile, { anchorPath: config.anchorPath, maxFileBytes: 65, remainingBytes: 65 });
        if (!read.ok || !/^[a-f0-9]{64}\n$/.test(read.text) || read.bytesRead !== 65) return fail();
        const after = lstatSync(config.keyFile, { bigint: true });
        if (!same(after, before) || after.mode !== before.mode || after.nlink !== before.nlink ||
          after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs ||
          !same(directory(config.anchorPath), anchorIdentity) || !same(directory(config.root), rootIdentity)) return fail();
        return Buffer.from(read.text.slice(0, 64), 'hex');
      } catch { return fail(); }
    }
    const key = readKey(); const keyId = createHash('sha256').update(DOMAIN + 'key\n').update(key).digest('hex');
    const scopeDigest = digest({ domain: DOMAIN, root: config.root, anchorPath: config.anchorPath, poolId: config.poolId,
      keyId, originPoolDigest: history[0]!.poolDigest });
    const current = () => { const next = readKey(); if (!timingSafeEqual(key, next)) fail(); };
    const sign = (payload: Omit<ResourcePoolReceiptArchiveCertificate, 'provenanceSig'>): string =>
      createHmac('sha256', key).update(DOMAIN).update(encoded(payload)).digest('hex');
    function verify(value: ResourcePoolReceiptArchiveCertificate): ResourcePoolReceiptArchiveCertificate {
      try {
        const certificate = capture<ResourcePoolReceiptArchiveCertificate>(value); current();
        if (!exact(certificate, ['schemaVersion', 'kind', 'scopeDigest', 'keyId', 'poolId', 'configurationCount', 'configurationHistoryDigest',
          'sequence', 'priorCertificateDigest', 'sourceStateDigest', 'receiptDigests', 'archiveRoot', 'provenanceSig']) ||
          certificate.schemaVersion !== 1 || certificate.kind !== 'resource-pool-receipt-archive-certificate' ||
          certificate.scopeDigest !== scopeDigest || certificate.keyId !== keyId || certificate.poolId !== config.poolId ||
          !Number.isSafeInteger(certificate.configurationCount) || certificate.configurationCount < 1 || certificate.configurationCount > history.length ||
          certificate.configurationHistoryDigest !== digest(history.slice(0, certificate.configurationCount)) ||
          !Number.isSafeInteger(certificate.sequence) || certificate.sequence < 0 ||
          (certificate.sequence === 0 ? certificate.priorCertificateDigest !== null :
            !validDigest(certificate.priorCertificateDigest)) ||
          !validDigest(certificate.sourceStateDigest) || !validDigest(certificate.provenanceSig) ||
          !Array.isArray(certificate.receiptDigests) || certificate.receiptDigests.length > 8 ||
          certificate.sequence > 0 && certificate.receiptDigests.length === 0) return fail();
        const ids = new Set<string>();
        for (const row of certificate.receiptDigests) {
          if (!exact(row, ['id', 'payloadDigest']) || typeof row.id !== 'string' || !ID.test(row.id) || ids.has(row.id) ||
            !validDigest(row.payloadDigest)) return fail();
          ids.add(row.id);
        }
        const { provenanceSig, ...payload } = certificate;
        if (!timingSafeEqual(Buffer.from(provenanceSig, 'hex'), Buffer.from(sign(payload), 'hex'))) return fail();
        const rows = archive.getMany(certificate.archiveRoot, [...ids]);
        if (certificate.sequence === 0 && certificate.archiveRoot.byId.count !== ids.size) return fail();
        for (let index = 0; index < rows.length; index++) {
          const row = rows[index]!;
          if (row.status !== 'found' || payloadDigest(row.receipt) !== certificate.receiptDigests[index]!.payloadDigest) return fail();
        }
        current(); return certificate;
      } catch { return fail(); }
    }
    return {
      verify,
      derive(value, options) {
        try {
          const request = capture<typeof value>(value);
          if (!exact(request, ['previous', 'sourceStateDigest', 'receipts']) || !validDigest(request.sourceStateDigest) ||
            !Array.isArray(request.receipts) || request.receipts.length > 8 ||
            request.previous !== null && request.receipts.length === 0 || new Set(request.receipts.map(row => row?.id)).size !== request.receipts.length) return fail();
          const previous = request.previous === null ? null : verify(request.previous);
          if (previous && previous.sequence >= Number.MAX_SAFE_INTEGER) return fail();
          for (const row of request.receipts) {
            const epoch = history.find(epoch => epoch.poolDigest === row?.poolDigest);
            if (!epoch || !checkedResourceTaskReceipt(row, epoch.poolDigest, epoch.bindings, epoch.pool) || !TERMINAL.has(row.status)) return fail();
          }
          if (!options || typeof options !== 'object' || types.isProxy(options) || ![Object.prototype, null].includes(Object.getPrototypeOf(options)) ||
            Reflect.ownKeys(options).length !== 1) return fail();
          const descriptor = Object.getOwnPropertyDescriptor(options, 'guard');
          if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') return fail();
          const hostGuard = descriptor.value as () => unknown;
          const guard = () => {
            current(); const result: unknown = hostGuard();
            if (types.isPromise(result)) void Promise.prototype.then.call(result, undefined, () => {});
            if (result !== undefined) fail(); current();
          };
          guard(); let archiveRoot = previous?.archiveRoot ?? emptyResourcePoolReceiptArchiveRoot();
          let expectedCount = archiveRoot.byId.count;
          for (const row of request.receipts) {
            const next = archive.stage(archiveRoot, row, { guard });
            if (!next.replayed) expectedCount++;
            archiveRoot = next.root;
          }
          // Last host callback precedes all final selected-record/root checks.
          guard();
          const saved = archive.getMany(archiveRoot, request.receipts.map(row => row.id));
          if (archiveRoot.byId.count !== expectedCount) return fail();
          for (let index = 0; index < saved.length; index++) {
            const row = saved[index]!;
            if (row.status !== 'found' || encoded(row.receipt) !== encoded(request.receipts[index])) return fail();
          }
          current();
          const payload: Omit<ResourcePoolReceiptArchiveCertificate, 'provenanceSig'> = {
            schemaVersion: 1, kind: 'resource-pool-receipt-archive-certificate', scopeDigest, keyId, poolId: config.poolId,
            configurationCount: history.length, configurationHistoryDigest: digest(history), sequence: previous ? previous.sequence + 1 : 0,
            priorCertificateDigest: previous ? digest(previous) : null, sourceStateDigest: request.sourceStateDigest,
            receiptDigests: request.receipts.map(row => ({ id: row.id, payloadDigest: payloadDigest(row) })), archiveRoot,
          };
          const certificate = { ...payload, provenanceSig: sign(payload) }; current();
          return certificate;
        } catch { return fail(); }
      },
    };
  } catch { return fail(); }
}
