/** Offline proposal publication only; never changes a ledger or launches a client. */
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { canonicalEvidencePackJsonV3 } from '../foundry/provenance.js';
import { canonical, digest, inspectPrivateDirectory } from '../universe/artifacts.js';
import { fsyncDirectory } from '../util/durability.js';
import { assurePrivateStoragePath } from '../util/private-storage.js';
import { readStableRegularFile } from '../util/stable-file-read.js';
import { readResourceJson } from './pool-runtime.js';
import { prepareResourceSparkEnrollment } from './spark-enrollment.js';

export interface SparkEnrollmentFileOptions {
  poolPath: string; bindingsPath: string; quotaConfigPath: string;
  generalWorkerId: string; sparkWorkerId: string; output: string;
}

export function prepareResourceSparkEnrollmentFiles(input: SparkEnrollmentFileOptions) {
  const json = canonicalEvidencePackJsonV3(input);
  if (json === null || Buffer.byteLength(json) > 20 * 1024) throw new Error('Invalid Spark proposal options');
  const options = JSON.parse(json) as SparkEnrollmentFileOptions;
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
    Object.keys(options).sort().join(',') !== 'bindingsPath,generalWorkerId,output,poolPath,quotaConfigPath,sparkWorkerId') {
    throw new Error('Invalid Spark proposal options');
  }
  for (const path of [options.poolPath, options.bindingsPath, options.quotaConfigPath, options.output]) {
    if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path || dirname(path) === path) {
      throw new Error('Spark proposal requires canonical absolute paths');
    }
  }
  const capture = () => ({ pool: readResourceJson(options.poolPath, 256 * 1024),
    bindings: readResourceJson(options.bindingsPath, 1024 * 1024), quotaConfig: readResourceJson(options.quotaConfigPath, 256 * 1024) });
  const inputs = capture(); const inputDigest = digest(canonical(inputs));
  const proposal = prepareResourceSparkEnrollment({ ...inputs, generalWorkerId: options.generalWorkerId, sparkWorkerId: options.sparkWorkerId });
  const files: Record<string, unknown> = { 'pool.json': proposal.pool, 'bindings.json': proposal.bindings,
    'quota-config.json': proposal.quotaConfig, 'general-reservation.json': proposal.generalExclusion };
  const encoded = Object.fromEntries(Object.entries(files).map(([name, value]) => [name, canonical(value) + '\n']));
  if (Object.values(encoded).some(bytes => Buffer.byteLength(bytes) > 1024 * 1024)) throw new Error('Spark proposal exceeds bound');
  const parent = inspectPrivateDirectory(dirname(options.output)); const parentIdentity = lstatSync(parent);
  // An exclusive new directory is the reservation. Partial output is retained,
  // never silently resumed or overwritten, even if a previous attempt matched.
  mkdirSync(options.output, { mode: 0o700 });
  const identity = lstatSync(options.output);
  const assurance = assurePrivateStoragePath(options.output, 'directory', 'secure-created', { anchorPath: parent });
  if (!assurance.ok) throw new Error('Spark proposal directory unavailable');
  const guard = () => {
    inspectPrivateDirectory(parent); inspectPrivateDirectory(options.output);
    const p = lstatSync(parent); const d = lstatSync(options.output);
    if (p.dev !== parentIdentity.dev || p.ino !== parentIdentity.ino || d.dev !== identity.dev || d.ino !== identity.ino) {
      throw new Error('Spark proposal directory changed');
    }
  };
  const write = (name: string, bytes: string) => {
    guard(); const path = join(options.output, name);
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || before.nlink !== 1 || before.size !== 0) throw new Error('Spark proposal file unavailable');
      if (!assurePrivateStoragePath(path, 'file', 'secure-created', { anchorPath: options.output }).ok) {
        throw new Error('Spark proposal file permissions unavailable');
      }
      writeFileSync(fd, bytes); fsyncSync(fd);
      const after = fstatSync(fd); const named = lstatSync(path);
      if (after.dev !== before.dev || after.ino !== before.ino || named.dev !== before.dev || named.ino !== before.ino ||
        !named.isFile() || named.isSymbolicLink() || after.nlink !== 1 || after.size !== Buffer.byteLength(bytes) ||
        (after.mode & 0o777) !== 0o600) throw new Error('Spark proposal file changed');
    } finally { closeSync(fd); }
    fsyncDirectory(options.output); guard();
  };
  const intentBytes = canonical({ schemaVersion: 1, inputDigest }) + '\n';
  guard(); write('intent.json', intentBytes);
  for (const [name, bytes] of Object.entries(encoded)) write(name, bytes);
  const paths = Object.fromEntries(Object.keys(files).map(name => [name, join(options.output, name)]));
  const hashes = Object.fromEntries(Object.entries(encoded).map(([name, bytes]) => [name, digest(bytes)]));
  const manifest = { schemaVersion: 1, status: 'prepared' as const, inputDigest,
    fromPoolDigest: proposal.fromPoolDigest, toPoolDigest: proposal.toPoolDigest,
    generalWorkerId: options.generalWorkerId, sparkWorkerId: options.sparkWorkerId, files: hashes,
    ledgerChanged: false, quotaRefreshed: false, accountUnpaused: false, generalReservationApplied: false };
  const verifyBytes = (name: string, expected: string) => {
    const path = join(options.output, name);
    // Parsed equality cannot attest the raw SHA256 in the manifest. Retain the
    // strict private-file check, then compare a bounded stable raw read exactly.
    readResourceJson(path, 1024 * 1024);
    const read = readStableRegularFile(path, { anchorPath: options.output, maxFileBytes: 1024 * 1024, remainingBytes: 1024 * 1024 });
    if (!read.ok || read.text !== expected || (lstatSync(path).mode & 0o777) !== 0o600) throw new Error('Spark proposal output changed');
  };
  const verifyFiles = () => {
    guard();
    if (digest(canonical(capture())) !== inputDigest) throw new Error('Spark proposal inputs changed');
    for (const [name, bytes] of Object.entries(encoded)) verifyBytes(name, bytes);
    verifyBytes('intent.json', intentBytes);
  };
  verifyFiles();
  if (readdirSync(options.output).sort().join(',') !== ['intent.json', ...Object.keys(files)].sort().join(',')) {
    throw new Error('Spark proposal directory contains unexpected files');
  }
  const manifestBytes = canonical(manifest) + '\n';
  write('manifest.json', manifestBytes);
  verifyFiles();
  verifyBytes('manifest.json', manifestBytes);
  if (readdirSync(options.output).sort().join(',') !== ['intent.json', 'manifest.json', ...Object.keys(files)].sort().join(',')) {
    throw new Error('Spark proposal publication changed');
  }
  fsyncDirectory(parent); guard();
  return { ...manifest, paths, manifestPath: join(options.output, 'manifest.json') };
}
