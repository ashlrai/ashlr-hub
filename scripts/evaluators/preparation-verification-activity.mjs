/** Trusted built-in invocation custody. Never imported from a candidate tree. */
import * as fs from 'node:fs';
import { join, isAbsolute, resolve } from 'node:path';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { exact, readMessage, publishMessage } from './preparation-verification-protocol.mjs';

// Aggregate invocation custody, including candidate and detached tool groups.
// This is not an exhaustive native-process count or a renewed time budget.
export const MAX_BUILTIN_ACTIVITIES = 8192;
const HASH = /^[a-f0-9]{64}$/;
const fail = () => { throw new Error('BUILTIN_ACTIVITY_UNAVAILABLE'); };
function owner(value) {
  if (!exact(value, ['schemaVersion', 'invocationId', 'implementationDigest', 'deadlineAt']) || ![1, 2].includes(value.schemaVersion) ||
      typeof value.invocationId !== 'string' || !HASH.test(value.invocationId) ||
      typeof value.implementationDigest !== 'string' || !HASH.test(value.implementationDigest) ||
      typeof value.deadlineAt !== 'string' || !Number.isFinite(Date.parse(value.deadlineAt)) ||
      new Date(value.deadlineAt).toISOString() !== value.deadlineAt) fail();
  return { schemaVersion: value.schemaVersion, invocationId: value.invocationId, implementationDigest: value.implementationDigest, deadlineAt: value.deadlineAt };
}
function witnessKey(value, version) {
  if (version === 1) { if (value !== undefined) fail(); return undefined; }
  if (typeof value !== 'string' || !HASH.test(value)) fail();
  return Buffer.from(value, 'hex');
}
// Authenticates the complete invocation transcript, not just a caller's claim
// that a particular numeric PID exited. The secret stays outside the journal.
function witnessProof(key, messages) {
  const mac = createHmac('sha256', key).update('ashlr-builtin-settlement-v2\n');
  for (const name of [...messages.keys()].sort()) mac.update(JSON.stringify([name, messages.get(name)]) + '\n');
  return mac.digest('hex');
}
function ownerDigest(value) {
  return createHash('sha256').update(JSON.stringify(owner(value))).digest('hex');
}
function rootIdentity(root) {
  if (typeof root !== 'string' || !isAbsolute(root) || resolve(root) !== root || fs.realpathSync(root) !== root) fail();
  const stat = fs.lstatSync(root, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777n) !== 0o700n ||
      typeof process.getuid === 'function' && stat.uid !== BigInt(process.getuid())) fail();
  return stat;
}
function sameRoot(left, right) { return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.uid === right.uid; }
function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mode === right.mode &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs && left.nlink === right.nlink;
}
function names(root, sorted = true) {
  const result = fs.readdirSync(root); if (result.length > MAX_BUILTIN_ACTIVITIES * 3 + 2) fail(); return sorted ? result.sort() : result;
}
function hasExpectedNames(root, expected) {
  // Keep every action-time directory scan, but membership needs no ordering.
  // Duplicate detection also refuses inconsistent enumeration rather than
  // allowing a repeated known entry to hide a missing expected entry.
  const actual = names(root, false);
  if (actual.length !== expected.size) return false;
  const seen = new Set();
  for (const name of actual) {
    if (!expected.has(name) || seen.has(name)) return false;
    seen.add(name);
  }
  return true;
}

/** Read the per-invocation secret only from the evaluator's bounded stdin pipe.
 * Legacy owners never consume stdin. No secret is copied into argv or env. */
export async function openBuiltinActivityTracker(root, signal, input = process.stdin) {
  rootIdentity(root);
  const captured = owner(readMessage(join(root, 'owner.json')));
  if (captured.schemaVersion === 1) return createBuiltinActivityTracker(root);
  const remaining = Math.min(5000, Date.parse(captured.deadlineAt) - Date.now());
  if (signal?.aborted || remaining <= 0) fail();
  const key = await new Promise((resolveKey, reject) => {
    const bytes = Buffer.alloc(64); let length = 0, done = false;
    const finish = error => {
      if (done) return; done = true;
      globalThis.clearTimeout(timer); signal?.removeEventListener('abort', abort);
      input.removeListener('data', data); input.removeListener('end', end);
      input.removeListener('error', failed); input.removeListener('close', failed); input.pause();
      const text = bytes.toString('ascii'); bytes.fill(0);
      if (error || length !== 64 || !HASH.test(text)) reject(new Error('BUILTIN_ACTIVITY_INPUT_UNAVAILABLE'));
      else resolveKey(text);
    };
    const abort = () => finish(true), failed = () => finish(true), end = () => finish(false);
    const data = chunk => {
      if (done) return;
      if (typeof chunk === 'string') chunk = Buffer.from(chunk, 'utf8');
      if (!Buffer.isBuffer(chunk) || chunk.length > 64 - length) { finish(true); return; }
      // Validate raw bytes: ASCII decoding alone would mask high-bit input.
      if ([...chunk].some(byte => !(byte >= 48 && byte <= 57 || byte >= 97 && byte <= 102))) { finish(true); return; }
      chunk.copy(bytes, length); length += chunk.length;
    };
    const timer = globalThis.setTimeout(abort, remaining);
    input.on('data', data); input.once('end', end); input.once('error', failed); input.once('close', failed);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted || input.destroyed) abort();
    else if (input.readableEnded) end();
    else input.resume();
  });
  if (signal?.aborted || Date.now() >= Date.parse(captured.deadlineAt)) fail();
  const tracker = createBuiltinActivityTracker(root, key);
  if (ownerDigest(tracker.owner) !== ownerDigest(captured)) fail();
  return tracker;
}

export function initializeBuiltinActivity(root, value) {
  const identity = rootIdentity(root), captured = owner(value);
  if (names(root).length !== 0) fail();
  publishMessage(join(root, 'owner.json'), captured);
  if (!sameRoot(identity, rootIdentity(root)) || JSON.stringify(names(root)) !== JSON.stringify(['owner.json']) ||
      ownerDigest(readMessage(join(root, 'owner.json'))) !== ownerDigest(captured)) fail();
}

export function createBuiltinActivityTracker(root, settlementKey) {
  const identity = rootIdentity(root);
  const ownerStat = fs.lstatSync(join(root, 'owner.json'), { bigint: true });
  const capturedOwner = owner(readMessage(join(root, 'owner.json')));
  const key = witnessKey(settlementKey, capturedOwner.schemaVersion);
  const capturedDigest = ownerDigest(capturedOwner);
  if (!sameFile(ownerStat, fs.lstatSync(join(root, 'owner.json'), { bigint: true })) ||
      JSON.stringify(names(root)) !== JSON.stringify(['owner.json'])) fail();
  let poisoned = false, completed = false;
  const activities = new Map();
  const registeredPgids = new Map();
  const messages = new Map([['owner.json', capturedOwner]]);
  const expectedNames = new Set(['owner.json']);
  function invalid() { poisoned = true; key?.fill(0); fail(); }
  function guard() {
    try {
      if (poisoned || completed || !sameRoot(identity, rootIdentity(root)) ||
          !sameFile(ownerStat, fs.lstatSync(join(root, 'owner.json'), { bigint: true })) ||
          ownerDigest(readMessage(join(root, 'owner.json'))) !== capturedDigest ||
          !hasExpectedNames(root, expectedNames)) invalid();
    } catch { invalid(); }
  }
  function write(name, value) {
    try { guard(); publishMessage(join(root, name), value); expectedNames.add(name); guard(); messages.set(name, value); }
    catch { invalid(); }
  }
  return {
    owner: Object.freeze({ ...capturedOwner }),
    lifecycle(kind) {
      if (kind !== 'candidate' && kind !== 'tool') invalid();
      return { prepare() {
        guard(); if (Date.now() >= Date.parse(capturedOwner.deadlineAt) || activities.size >= MAX_BUILTIN_ACTIVITIES) invalid();
        const id = activities.size + 1;
        const base = { schemaVersion: 1, ownerDigest: capturedDigest, id, kind };
        write(`prepared-${id}.json`, { ...base, phase: 'prepared' });
        activities.set(id, 'prepared');
        return {
          spawned(pgid) {
            if (activities.get(id) !== 'prepared' || !Number.isSafeInteger(pgid) || pgid < 1 || pgid > 2 ** 31 - 1) invalid();
            write(`spawned-${id}.json`, { ...base, phase: 'spawned', pgid }); activities.set(id, 'spawned'); registeredPgids.set(id, pgid);
          },
          settled(settlement) {
            if (!(settlement === 'not-started' && activities.get(id) === 'prepared' ||
                settlement === 'group-exit-confirmed' && activities.get(id) === 'spawned')) invalid();
            if (key && settlement === 'group-exit-confirmed') {
              // Independently witness absence now, while this invocation owns
              // the lifecycle callback. A later reused number is not this group.
              let absent = false;
              try { process.kill(-registeredPgids.get(id), 0); }
              catch (error) { absent = error?.code === 'ESRCH'; }
              if (!absent) invalid();
            }
            write(`settled-${id}.json`, { ...base, phase: 'settled', settlement }); activities.set(id, 'settled');
          },
        };
      } };
    },
    complete() {
      guard(); if ([...activities.values()].some(state => state !== 'settled')) invalid();
      write('complete.json', { schemaVersion: capturedOwner.schemaVersion, ownerDigest: capturedDigest, count: activities.size,
        ...(key ? { settlementProof: witnessProof(key, messages) } : {}) }); completed = true; key?.fill(0);
    },
  };
}

/** Read-only proof. V1 probes current absence; V2 verifies authenticated
 * settlement-time observations. Neither mode kills, repairs or adopts work. */
export function inspectBuiltinActivity(root, expectedOwner, settlementKey) {
  try {
    const identity = rootIdentity(root), expectedDigest = ownerDigest(expectedOwner);
    const key = witnessKey(settlementKey, expectedOwner.schemaVersion);
    const captured = new Map();
    const messages = new Map();
    function read(name) {
      const path = join(root, name), before = fs.lstatSync(path, { bigint: true }), value = readMessage(path);
      if (value === null || !sameFile(before, fs.lstatSync(path, { bigint: true }))) fail();
      captured.set(path, before); if (name !== 'complete.json') messages.set(name, value); return value;
    }
    if (ownerDigest(read('owner.json')) !== expectedDigest) fail();
    const complete = read('complete.json');
    if (!exact(complete, ['schemaVersion', 'ownerDigest', 'count', ...(key ? ['settlementProof'] : [])]) ||
        complete.schemaVersion !== expectedOwner.schemaVersion || complete.ownerDigest !== expectedDigest ||
        !Number.isSafeInteger(complete.count) || complete.count < 0 || complete.count > MAX_BUILTIN_ACTIVITIES) fail();
    const expectedNames = ['owner.json', 'complete.json']; const pgids = new Set();
    for (let id = 1; id <= complete.count; id++) {
      const preparedName = `prepared-${id}.json`, settledName = `settled-${id}.json`;
      const prepared = read(preparedName), settled = read(settledName);
      const base = value => value.schemaVersion === 1 && value.ownerDigest === expectedDigest && value.id === id && value.kind === prepared.kind;
      if (!exact(prepared, ['schemaVersion', 'ownerDigest', 'id', 'kind', 'phase']) || !base(prepared) || prepared.phase !== 'prepared' ||
          !['candidate', 'tool'].includes(prepared.kind) || !exact(settled, ['schemaVersion', 'ownerDigest', 'id', 'kind', 'phase', 'settlement']) ||
          !base(settled) || settled.phase !== 'settled') fail();
      expectedNames.push(preparedName, settledName);
      if (settled.settlement === 'group-exit-confirmed') {
        const name = `spawned-${id}.json`, spawned = read(name);
        if (!exact(spawned, ['schemaVersion', 'ownerDigest', 'id', 'kind', 'phase', 'pgid']) || !base(spawned) || spawned.phase !== 'spawned' ||
            !Number.isSafeInteger(spawned.pgid) || spawned.pgid < 1 || spawned.pgid > 2 ** 31 - 1) fail();
        expectedNames.push(name); pgids.add(spawned.pgid);
      } else if (settled.settlement !== 'not-started') fail();
    }
    if (JSON.stringify(names(root)) !== JSON.stringify(expectedNames.sort())) fail();
    if (key) {
      if (typeof complete.settlementProof !== 'string' || !HASH.test(complete.settlementProof) ||
        !timingSafeEqual(Buffer.from(complete.settlementProof, 'hex'), Buffer.from(witnessProof(key, messages), 'hex'))) fail();
    } else for (const pgid of pgids) {
      try { process.kill(-pgid, 0); return false; }
      catch (error) { if (error?.code !== 'ESRCH') return false; }
    }
    for (const [path, stat] of captured) if (!sameFile(stat, fs.lstatSync(path, { bigint: true }))) fail();
    if (!sameRoot(identity, rootIdentity(root)) || JSON.stringify(names(root)) !== JSON.stringify(expectedNames.sort())) fail();
    return true;
  } catch { return false; }
}
