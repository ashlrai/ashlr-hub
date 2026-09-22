#!/usr/bin/env node
/** One explicitly authorized legacy quarantine. Never discovers accounts or resumes execution.
 * Usage: node reconcile-legacy-collector.mjs --root ABS --evidence ABS
 *   --expected-marker-sha256 HEX --authorize-legacy-quarantine
 * Existing empty evidence directory must be private and on the same filesystem.
 * Partial evidence is retained, never retried, overwritten or automatically rolled back.
 * A moved marker removes its admission fence even on later failure: stop and inspect manually.
 * Path/inode guards are not an atomic defense against a hostile same-UID directory swap.
 */
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, readdirSync,
  realpathSync, renameSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { TextDecoder } from 'node:util';
import { Buffer } from 'node:buffer';
import { setImmediate as yieldToLoop } from 'node:timers/promises';

const { process, console } = globalThis;
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MARKER = '.resource-quota-refresh-pending.json', LOCK = '.resource-quota-refresh.lock';
const OUTPUTS = ['intent.json', 'marker.raw.json', 'inventory.json', 'quarantined-marker.json', 'receipt.json'];
const MAX_FILES = 8192, MAX_BYTES = 128 * 1024 * 1024, MAX_FILE_BYTES = 4 * 1024 * 1024;
const started = performance.now();
let stopped = false, stage = 'arguments', root, evidence, lock, lockApi, moved = false, complete = false, receiptDigest;
const stop = () => { stopped = true; };
const fail = () => { throw new Error('Legacy collector quarantine unavailable'); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b, keys = ['dev', 'ino', 'uid', 'mode', 'size', 'mtimeNs', 'ctimeNs', 'nlink']) => keys.every(key => a[key] === b[key]);
const exists = path => { try { lstatSync(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const absolute = path => typeof path === 'string' && isAbsolute(path) && resolve(path) === path && path !== parse(path).root &&
  path.length <= 4096 && ![...path].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
const contains = (a, b) => { const part = relative(a, b); return part === '' || part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part); };
function directory(path) {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path || stat.uid !== BigInt(process.getuid()) || (stat.mode & 0o777n) !== 0o700n) fail();
  return stat;
}
function read(path, limit, guard, exactMode = false) {
  guard(); const before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.uid !== BigInt(process.getuid()) ||
    (before.mode & 0o077n) !== 0n || exactMode && (before.mode & 0o777n) !== 0o600n || before.size > BigInt(limit) || realpathSync(path) !== path) fail();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!same(before, fstatSync(fd, { bigint: true }))) fail();
    const bytes = Buffer.alloc(Number(before.size) + 1); let count = 0;
    while (count < bytes.length) { guard(); const got = readSync(fd, bytes, count, Math.min(65536, bytes.length - count), count); if (!got) break; count += got; }
    if (count !== Number(before.size) || !same(before, fstatSync(fd, { bigint: true })) || !same(before, lstatSync(path, { bigint: true }))) fail();
    guard(); return { bytes: bytes.subarray(0, count), stat: before };
  } finally { closeSync(fd); }
}
function syncDirectory(path) {
  const before = directory(path), fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { if (!same(before, fstatSync(fd, { bigint: true }), ['dev', 'ino', 'uid', 'mode'])) fail(); fsyncSync(fd); }
  finally { closeSync(fd); }
}
try {
  if (process.platform !== 'darwin' || Number(process.versions.node.split('.')[0]) < 24 || typeof process.getuid !== 'function' ||
    process.argv.length !== 9 || process.argv[2] !== '--root' || process.argv[4] !== '--evidence' ||
    process.argv[6] !== '--expected-marker-sha256' || process.argv[8] !== '--authorize-legacy-quarantine') fail();
  root = process.argv[3]; evidence = process.argv[5]; const expected = process.argv[7];
  if (!absolute(root) || !absolute(evidence) || contains(root, evidence) || contains(evidence, root) || !/^[a-f0-9]{64}$/.test(expected)) fail();
  const rootPin = directory(root), evidencePin = directory(evidence);
  if (rootPin.dev !== evidencePin.dev || readdirSync(evidence).length !== 0) fail();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  lockApi = await import(pathToFileURL(join(repository, 'dist/core/fleet/local-store-lock.js')).href);
  const { readKillSwitch } = await import(pathToFileURL(join(repository, 'dist/core/sandbox/policy.js')).href);
  const guard = () => {
    if (stopped || performance.now() - started > 60_000) fail();
    const kill = readKillSwitch(); if (kill.sourceState !== 'healthy' || kill.state !== 'active') fail();
    if (!same(rootPin, directory(root), ['dev', 'ino', 'uid', 'mode']) || !same(evidencePin, directory(evidence), ['dev', 'ino', 'uid', 'mode']) ||
      exists(join(root, '.pool.lock')) || exists(join(root, '.resource-console.lock')) || lock && !lockApi.ownsLocalStoreLock(lock)) fail();
  };
  guard(); stage = 'marker-preflight';
  const pendingPath = join(root, MARKER), marker = read(pendingPath, 512, guard, true);
  if (!marker.bytes.length || sha(marker.bytes) !== expected) fail();
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(marker.bytes));
  if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'schemaVersion,scope,startedAt,state' || value.schemaVersion !== 1 ||
    !['codex-native-metadata', 'native-connection-metadata'].includes(value.scope) || value.state !== 'pending' || typeof value.startedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.startedAt)) || new Date(value.startedAt).toISOString() !== value.startedAt) fail();
  guard(); if (exists(join(root, LOCK))) fail(); stage = 'exclusive-ownership';
  const acquisition = lockApi.acquireLocalStoreLockWithOutcome(join(root, LOCK), 0, { anchorPath: root, exactPrivateStorage: true });
  if (acquisition.state !== 'acquired') fail(); lock = acquisition.lock; guard();
  const inventory = async () => {
    const entries = []; let total = 0, visited = 0;
    const walk = async (path, prefix = '', depth = 0) => {
      if (depth > 64) fail();
      await yieldToLoop(); guard();
      guard(); const before = directory(path), names = readdirSync(path).sort();
      if (names.length > MAX_FILES) fail();
      for (const name of names) {
        if (++visited > MAX_FILES || name === '.' || name === '..' || name.includes('/') || name.includes('\\') ||
          [...name].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) fail();
        if (!prefix && [MARKER, LOCK].includes(name)) continue;
        const child = join(path, name), key = prefix ? `${prefix}/${name}` : name, stat = lstatSync(child, { bigint: true });
        if (stat.isDirectory()) { entries.push({ path: key, kind: 'directory', dev: String(stat.dev), ino: String(stat.ino), mode: Number(stat.mode) }); await walk(child, key, depth + 1); }
        else {
          const file = read(child, Math.min(MAX_FILE_BYTES, MAX_BYTES - total), guard); total += file.bytes.length;
          entries.push({ path: key, kind: 'file', dev: String(file.stat.dev), ino: String(file.stat.ino), mode: Number(file.stat.mode), bytes: file.bytes.length, sha256: sha(file.bytes) });
        }
        await yieldToLoop(); guard();
      }
      if (!same(before, directory(path), ['dev', 'ino', 'uid', 'mode', 'mtimeNs', 'ctimeNs']) || JSON.stringify(names) !== JSON.stringify(readdirSync(path).sort())) fail();
    };
    await walk(root); return Buffer.from(JSON.stringify({ schemaVersion: 1, entries, totalBytes: total }) + '\n');
  };
  stage = 'inventory'; const beforeInventory = await inventory();
  const archived = new Map();
  const write = (name, bytes) => {
    guard(); if (!OUTPUTS.includes(name) || exists(join(evidence, name))) fail();
    const fd = openSync(join(evidence, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { let count = 0; while (count < bytes.length) { guard(); const written = writeSync(fd, bytes, count, bytes.length - count); if (written <= 0) fail(); count += written; } fsyncSync(fd); }
    finally { closeSync(fd); }
    syncDirectory(evidence); if (!read(join(evidence, name), Math.max(bytes.length, 512), guard, true).bytes.equals(bytes)) fail();
    archived.set(name, bytes);
  };
  const json = value => Buffer.from(JSON.stringify(value) + '\n');
  await yieldToLoop(); guard();
  stage = 'archive';
  const intent = { schemaVersion: 1, action: 'operator-authorized-legacy-quarantine', expectedMarkerSha256: expected,
    historicalOwner: 'unknown-not-proven-dead', markerIdentity: { dev: String(marker.stat.dev), ino: String(marker.stat.ino) },
    inventorySha256: sha(beforeInventory), authorizedAt: new Date().toISOString(), globalStopRequired: 'active', automaticRetry: false };
  write('intent.json', json(intent)); write('marker.raw.json', marker.bytes); write('inventory.json', beforeInventory);
  await yieldToLoop(); guard();
  stage = 'quarantine'; guard();
  if (!(await inventory()).equals(beforeInventory)) fail();
  await yieldToLoop(); guard();
  // No inventory traversal follows this exact marker read before rename.
  const finalMarker = read(pendingPath, 512, guard, true);
  if (!same(marker.stat, finalMarker.stat) || !finalMarker.bytes.equals(marker.bytes) ||
    readdirSync(evidence).sort().join(',') !== 'intent.json,inventory.json,marker.raw.json') fail();
  guard(); if (exists(join(evidence, 'quarantined-marker.json'))) fail();
  renameSync(pendingPath, join(evidence, 'quarantined-marker.json')); moved = true;
  archived.set('quarantined-marker.json', marker.bytes);
  syncDirectory(root); syncDirectory(evidence); guard();
  const quarantined = read(join(evidence, 'quarantined-marker.json'), 512, guard, true);
  if (!same(marker.stat, quarantined.stat, ['dev', 'ino', 'uid', 'mode', 'size', 'nlink']) || !quarantined.bytes.equals(marker.bytes) ||
    exists(pendingPath) || !(await inventory()).equals(beforeInventory)) fail();
  stage = 'receipt';
  const receipt = json({ schemaVersion: 1, action: intent.action, state: 'quarantined-before-lock-release',
    historicalOwner: intent.historicalOwner, markerSha256: expected, intentSha256: sha(json(intent)), inventorySha256: sha(beforeInventory),
    finishedAt: new Date().toISOString(), poolEvidenceUnchanged: true, quotaRefreshed: false, executionAuthorized: false,
    admissionBarrierPreserved: false, rollback: 'manual-review-only-no-automatic-overwrite' });
  write('receipt.json', receipt); receiptDigest = sha(receipt);
  if (!(await inventory()).equals(beforeInventory) || exists(pendingPath) || readdirSync(evidence).sort().join(',') !== [...OUTPUTS].sort().join(',')) fail();
  for (const [name, bytes] of archived) if (!read(join(evidence, name), Math.max(bytes.length, 512), guard, true).bytes.equals(bytes)) fail();
  guard(); complete = true;
} catch { complete = false; }
finally {
  process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  if (lock) { try { if (!lockApi.releaseLocalStoreLock(lock)) { complete = false; stage = 'lock-release'; } } catch { complete = false; stage = 'lock-release'; } }
}
process.exitCode = complete ? 0 : 1;
console.log(JSON.stringify({ schemaVersion: 1, state: complete ? 'quarantined' : 'incomplete', stage, markerMoved: moved,
  admissionBarrierPreserved: moved ? false : null, nextAction: complete ? 'separate-commissioning-review' : 'manual-inspection-no-commissioning-continuation',
  ...(evidence && absolute(evidence) ? { evidencePath: evidence } : {}), ...(receiptDigest ? { receiptSha256: receiptDigest } : {}),
  historicalOwner: 'unknown-not-proven-dead', quotaRefreshed: false, executionAuthorized: false, automaticRetry: false }));
