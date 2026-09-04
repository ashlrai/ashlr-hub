#!/usr/bin/env node

/**
 * One-shot POSIX custody boundary for scorecard history.
 *
 * The parent starts this process with cwd set to the already-inspected private
 * state root. The helper validates that root, enters `scorecard-history` by a
 * single relative component, and validates the acquired cwd before file I/O.
 * POSIX keeps cwd as a reference to that directory object, so every subsequent
 * descendant operation is also a single-component relative lookup. Never add
 * an absolute history path or a path containing a separator to an operation.
 */

import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readFileSync,
  readSync,
  renameSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';

const PARTITION_FILE_RE = /^(\d{4}-\d{2})\.jsonl$/;
const MAX_DIRECTORY_ENTRIES = 2_048;
const MAX_REQUEST_BYTES = 512 * 1024;
const TEST_DISPLACED_SUFFIX_RE = /^\.displaced-scorecard-[a-z0-9]{8,64}$/;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function parseRequest() {
  const bytes = readFileSync(0);
  if (bytes.length === 0 || bytes.length > MAX_REQUEST_BYTES) fail('invalid scorecard worker request size');
  try {
    const parsed = JSON.parse(bytes.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape');
    return parsed;
  } catch {
    fail('invalid scorecard worker request');
  }
}

function ownedByCurrentUser(stat) {
  return typeof process.getuid !== 'function' || stat.uid === BigInt(process.getuid());
}

function safeDirectory(stat) {
  return stat.isDirectory() && !stat.isSymbolicLink() && ownedByCurrentUser(stat) &&
    (stat.mode & 0o077n) === 0n;
}

function safeFile(stat) {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n &&
    ownedByCurrentUser(stat) && (stat.mode & 0o077n) === 0n;
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function safeComponent(value, pattern = PARTITION_FILE_RE) {
  return typeof value === 'string' && value.length <= 128 && !value.includes(sep) &&
    value !== '.' && value !== '..' && pattern.test(value);
}

function validatePinnedRoot(request) {
  if (process.platform === 'win32') fail('scorecard worker requires POSIX cwd custody');
  if (typeof constants.O_NOFOLLOW !== 'number' || typeof constants.O_DIRECTORY !== 'number') {
    fail('scorecard worker requires O_NOFOLLOW and O_DIRECTORY');
  }
  if (typeof request.expectedRootDev !== 'string' || typeof request.expectedRootIno !== 'string') {
    fail('invalid expected root identity');
  }
  const pinned = lstatSync('.', { bigint: true });
  if (!safeDirectory(pinned) || pinned.dev !== BigInt(request.expectedRootDev) ||
    pinned.ino !== BigInt(request.expectedRootIno)) {
    fail('scorecard worker root cwd identity mismatch');
  }
  return pinned;
}

function enterHistoryDirectory(request) {
  if (request.directoryName !== 'scorecard-history') fail('invalid scorecard history directory name');
  let firstObserverOfMissingDirectory = false;
  let expected;
  try {
    expected = lstatSync(request.directoryName, { bigint: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    if (request.operation === 'read') return undefined;
    firstObserverOfMissingDirectory = true;
    try {
      mkdirSync(request.directoryName, { mode: 0o700 });
    } catch (mkdirError) {
      // Another helper may win the same first-append race. EEXIST is not
      // success by itself: the relative entry is inspected below and must be
      // the same private directory that this process then acquires as cwd.
      if (mkdirError?.code !== 'EEXIST') throw mkdirError;
    }
    expected = lstatSync(request.directoryName, { bigint: true });
  }
  if (!safeDirectory(expected)) fail('unsafe scorecard history directory');
  // Every helper that observed ENOENT syncs the pinned parent, including a
  // helper that lost the mkdir race. This does not depend on the winner
  // surviving long enough to provide the directory-entry durability barrier.
  if (firstObserverOfMissingDirectory) syncPinnedDirectory();
  process.chdir(request.directoryName);
  const pinned = lstatSync('.', { bigint: true });
  if (!safeDirectory(pinned) || !sameIdentity(expected, pinned)) {
    fail('scorecard history directory changed while acquiring cwd');
  }
  return { dev: String(pinned.dev), ino: String(pinned.ino) };
}

function writeJson(value) {
  process.stdout.write(JSON.stringify(value));
}

function writeAll(fd, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const written = writeSync(fd, buffer, offset, buffer.length - offset);
    if (written <= 0) throw new Error('scorecard history append made no progress');
    offset += written;
  }
}

function syncPinnedDirectory(request) {
  const fd = openSync('.', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!safeDirectory(opened)) throw new Error('unsafe scorecard history cwd');
    if (request?.testAttack?.directorySyncFailure !== undefined) {
      if (!testAttackAllowed() || request.testAttack.directorySyncFailure !== true) {
        fail('invalid scorecard directory-sync test attack');
      }
      throw new Error('injected scorecard directory sync failure');
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function openAppendFile(fileName) {
  return openSync(
    fileName,
    constants.O_APPEND | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_CREAT,
    0o600,
  );
}

function testAttackAllowed() {
  return process.env.NODE_ENV === 'test' && process.env.VITEST === 'true';
}

function applyParentSwapForTest(request) {
  const attack = request.testAttack?.parentSwap;
  if (attack === undefined) return;
  if (!testAttackAllowed()) fail('scorecard worker test attack refused');
  if (typeof attack.directoryPath !== 'string' || typeof attack.displacedPath !== 'string') {
    fail('invalid scorecard parent-swap test attack');
  }
  const named = lstatSync(attack.directoryPath, { bigint: true });
  const pinned = lstatSync('.', { bigint: true });
  const directoryName = basename(attack.directoryPath);
  const displacedName = basename(attack.displacedPath);
  if (!sameIdentity(named, pinned) || dirname(attack.directoryPath) !== dirname(attack.displacedPath) ||
    !displacedName.startsWith(directoryName) ||
    !TEST_DISPLACED_SUFFIX_RE.test(displacedName.slice(directoryName.length))) {
    fail('unsafe scorecard parent-swap test attack');
  }
  renameSync(attack.directoryPath, attack.displacedPath);
  mkdirSync(attack.directoryPath, { mode: 0o700 });
  const replacementFiles = attack.replacementFiles ?? {};
  if (replacementFiles === null || typeof replacementFiles !== 'object' || Array.isArray(replacementFiles)) {
    fail('invalid scorecard replacement files');
  }
  for (const [name, contents] of Object.entries(replacementFiles)) {
    if (!safeComponent(name) || typeof contents !== 'string' || Buffer.byteLength(contents) > 128 * 1024) {
      fail('unsafe scorecard replacement file');
    }
    writeFileSync(join(attack.directoryPath, name), contents, { mode: 0o600, flag: 'wx' });
  }
}

function applyBeforeAppendOpenAttackForTest(request) {
  const target = request.testAttack?.beforeAppendSymlinkTarget;
  if (target === undefined) return;
  if (!testAttackAllowed() || typeof target !== 'string' || target.length === 0) {
    fail('invalid scorecard symlink test attack');
  }
  symlinkSync(target, request.fileName);
}

function applyFileSwapForTest(request, fileName, field = 'fileSwap') {
  const attack = request.testAttack?.[field];
  if (attack === undefined) return;
  if (!testAttackAllowed() || attack.fileName !== fileName ||
    !safeComponent(attack.fileName) ||
    !safeComponent(attack.displacedName, /^[A-Za-z0-9._-]{1,128}$/) ||
    typeof attack.replacementContents !== 'string' ||
    Buffer.byteLength(attack.replacementContents) > 128 * 1024) {
    fail('invalid scorecard file-swap test attack');
  }
  renameSync(fileName, attack.displacedName);
  writeFileSync(fileName, attack.replacementContents, { mode: 0o600, flag: 'wx' });
}

function applyWorkerFailureForTest(request) {
  const failure = request.testAttack?.workerFailure;
  if (failure === undefined) return false;
  if (!testAttackAllowed()) fail('scorecard worker failure test refused');
  if (failure === 'nonzero') fail('injected scorecard worker failure');
  if (failure === 'malformed-output') {
    process.stdout.write('{');
    return true;
  }
  if (failure === 'oversized-output') {
    process.stdout.write('x'.repeat(2 * 1024 * 1024));
    return true;
  }
  if (failure === 'timeout') {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5_000);
    return true;
  }
  fail('invalid scorecard worker failure test');
}

function runAppend(request, directoryIdentity) {
  if (!safeComponent(request.fileName) || typeof request.line !== 'string' ||
    Buffer.byteLength(request.line) > 128 * 1024 || !request.line.endsWith('\n')) {
    fail('invalid scorecard append request');
  }
  applyParentSwapForTest(request);
  applyBeforeAppendOpenAttackForTest(request);
  let fd;
  try {
    fd = openAppendFile(request.fileName);
    const opened = fstatSync(fd, { bigint: true });
    applyFileSwapForTest(request, request.fileName);
    const named = lstatSync(request.fileName, { bigint: true });
    if (!safeFile(opened) || !safeFile(named) || !sameIdentity(opened, named)) {
      throw new Error('scorecard history is not a safe regular file');
    }
    // Establish the directory-entry durability barrier before mutating file
    // contents. If this fails, the caller can retry without duplicating an
    // append that was already made durable but reported as failed.
    syncPinnedDirectory(request);
    applyFileSwapForTest(request, request.fileName, 'afterDirectorySyncFileSwap');
    const rebound = lstatSync(request.fileName, { bigint: true });
    if (!safeFile(rebound) || !sameIdentity(opened, rebound)) {
      throw new Error('scorecard history changed after directory sync');
    }
    if (opened.size > 0n) {
      const tail = Buffer.alloc(1);
      const read = readSync(fd, tail, 0, 1, Number(opened.size - 1n));
      if (read !== 1) throw new Error('scorecard history tail is unreadable');
      if (tail[0] !== 0x0a) writeAll(fd, Buffer.from('\n', 'utf8'));
    }
    writeAll(fd, Buffer.from(request.line, 'utf8'));
    fsyncSync(fd);
    const after = fstatSync(fd, { bigint: true });
    const namedAfter = lstatSync(request.fileName, { bigint: true });
    if (!safeFile(after) || !safeFile(namedAfter) || !sameIdentity(opened, after) ||
      !sameIdentity(after, namedAfter)) {
      throw new Error('scorecard history file identity changed');
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  writeJson({ ok: true, directoryIdentity });
}

function boundedPositiveInteger(value, hardMax) {
  return Number.isInteger(value) && value > 0 && value <= hardMax ? value : undefined;
}

function emptyRead(sourceState, overrides = {}) {
  return {
    records: [],
    sourceState,
    sourcePresent: sourceState !== 'missing',
    complete: sourceState !== 'degraded',
    stopReasons: [],
    filesRead: 0,
    bytesRead: 0,
    rowsScanned: 0,
    invalidRows: 0,
    unreadableFiles: 0,
    ...overrides,
  };
}

function pushStop(result, reason) {
  if (!result.stopReasons.includes(reason)) result.stopReasons.push(reason);
}

function readRelativeFile(fileName, maxBytes, request) {
  let fd;
  try {
    fd = openSync(fileName, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd, { bigint: true });
    if (!safeFile(opened)) return { ok: false, reason: 'io-error' };
    if (opened.size > BigInt(maxBytes)) return { ok: false, reason: 'byte-limit' };
    applyFileSwapForTest(request, fileName);
    const named = lstatSync(fileName, { bigint: true });
    if (!safeFile(named) || !sameIdentity(opened, named)) {
      return { ok: false, reason: 'io-error' };
    }
    const size = Number(opened.size);
    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const read = readSync(fd, buffer, offset, size - offset, offset);
      if (read <= 0) return { ok: false, reason: 'io-error' };
      offset += read;
    }
    const after = fstatSync(fd, { bigint: true });
    const namedAfter = lstatSync(fileName, { bigint: true });
    if (!safeFile(after) || !safeFile(namedAfter) || !sameIdentity(opened, after) ||
      !sameIdentity(after, namedAfter) || opened.size !== after.size ||
      opened.size !== namedAfter.size) return { ok: false, reason: 'io-error' };
    return { ok: true, text: buffer.toString('utf8'), bytesRead: size };
  } catch {
    return { ok: false, reason: 'io-error' };
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best-effort read close */ }
    }
  }
}

function runRead(request, directoryIdentity) {
  const maxFiles = boundedPositiveInteger(request.maxFiles, 1_024);
  const maxBytes = boundedPositiveInteger(request.maxBytes, 128 * 1024 * 1024);
  const maxRows = boundedPositiveInteger(request.maxRows, 200_000);
  const limit = request.limit === undefined ? undefined : boundedPositiveInteger(request.limit, 200_000);
  const sinceMs = request.sinceMs === undefined ||
    (typeof request.sinceMs === 'number' && Number.isFinite(request.sinceMs))
    ? request.sinceMs
    : Number.NaN;
  if (maxFiles === undefined || maxBytes === undefined || maxRows === undefined ||
    Number.isNaN(sinceMs) || (request.limit !== undefined && limit === undefined)) {
    fail('invalid scorecard read request');
  }
  applyParentSwapForTest(request);

  const selected = [];
  let seen = 0;
  const handle = opendirSync('.');
  try {
    let entry = handle.readSync();
    while (entry !== null) {
      seen++;
      if (seen > MAX_DIRECTORY_ENTRIES) {
        writeJson({ directoryIdentity, result: emptyRead('degraded', {
          sourcePresent: true,
          complete: false,
          stopReasons: ['file-limit'],
        }) });
        return;
      }
      if (entry.name.endsWith('.jsonl') && PARTITION_FILE_RE.test(entry.name)) selected.push(entry.name);
      entry = handle.readSync();
    }
  } finally {
    handle.closeSync();
  }
  const files = selected.sort().reverse();
  if (files.length === 0) {
    writeJson({ directoryIdentity, result: emptyRead('healthy') });
    return;
  }

  const result = emptyRead('healthy');
  result.sourcePresent = true;
  for (const fileName of files) {
    if (result.filesRead >= maxFiles) {
      pushStop(result, 'file-limit');
      result.complete = false;
      break;
    }
    const remaining = maxBytes - result.bytesRead;
    if (remaining <= 0) {
      pushStop(result, 'byte-limit');
      result.complete = false;
      break;
    }
    const loaded = readRelativeFile(fileName, remaining, request);
    result.filesRead++;
    if (!loaded.ok) {
      if (loaded.reason === 'io-error') result.unreadableFiles++;
      pushStop(result, loaded.reason);
      result.complete = false;
      break;
    }
    result.bytesRead += loaded.bytesRead;
    const lines = loaded.text.split('\n').reverse();
    for (const line of lines) {
      if (!line.trim()) continue;
      if (result.rowsScanned >= maxRows) {
        pushStop(result, 'row-limit');
        result.complete = false;
        break;
      }
      result.rowsScanned++;
      if (Buffer.byteLength(line, 'utf8') > 128 * 1024) {
        result.invalidRows++;
        continue;
      }
      try {
        const parsed = JSON.parse(line);
        const entryMs = typeof parsed?.ts === 'string' ? Date.parse(parsed.ts) : Number.NaN;
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) ||
          !Number.isFinite(entryMs) || (parsed.window !== '7d' && parsed.window !== '30d') ||
          parsed.scorecard === null || typeof parsed.scorecard !== 'object' || Array.isArray(parsed.scorecard)) {
          result.invalidRows++;
          continue;
        }
        if (sinceMs !== undefined && entryMs < sinceMs) continue;
        result.records.push(parsed);
      } catch {
        result.invalidRows++;
      }
    }
    if (!result.complete) break;
  }
  result.records.sort((left, right) => Date.parse(right.ts) - Date.parse(left.ts));
  if (limit !== undefined) result.records = result.records.slice(0, limit);
  if (result.invalidRows > 0 || result.unreadableFiles > 0 || !result.complete) {
    result.complete = false;
    result.sourceState = 'degraded';
  }
  writeJson({ directoryIdentity, result });
}

const request = parseRequest();
validatePinnedRoot(request);
try {
  const directoryIdentity = enterHistoryDirectory(request);
  if (directoryIdentity === undefined) {
    writeJson({ missing: true });
  } else if (applyWorkerFailureForTest(request)) {
    // Test-only malformed/oversized/timeout behavior has already executed.
  } else if (request.operation === 'append') runAppend(request, directoryIdentity);
  else if (request.operation === 'read') runRead(request, directoryIdentity);
  else fail('unsupported scorecard worker operation');
} catch (error) {
  fail(error instanceof Error ? error.message : 'scorecard worker failed');
}
