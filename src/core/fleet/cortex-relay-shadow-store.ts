import { createHash } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  writeSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { assurePrivateStoragePath } from '../util/private-storage.js';
import {
  _validateCortexRelayShadowForTest,
  CORTEX_RELAY_SHADOW_TEST_CONTROL,
  validateCortexRelayShadow,
  type CortexRelayShadowDependencies,
  type CortexRelayShadowInput,
  type CortexRelayShadowMetadata,
  type CortexRelayShadowResult,
} from './cortex-relay-shadow.js';

export type CortexRelayShadowRecordState = 'recorded' | 'duplicate' | 'conflict' | 'unavailable';

export interface CortexRelayShadowRecordResult {
  state: CortexRelayShadowRecordState;
  metadata: CortexRelayShadowMetadata;
}

function anchorPath(override?: string): string {
  const root = override ?? process.env.ASHLR_HOME ?? join(homedir(), '.ashlr');
  if (!isAbsolute(root) || resolve(root) !== root) throw new Error('unsafe ASHLR_HOME');
  return root;
}

function recordKey(metadata: CortexRelayShadowMetadata): string {
  const identity = metadata.assignmentId ?? metadata.inputDigest;
  return createHash('sha256').update(`ashlr:cortex-relay-shadow:key:v1\0${identity}`, 'utf8').digest('hex');
}

function safeDirectory(path: string, exact = false): boolean {
  const stat = lstatSync(path);
  return stat.isDirectory() && !stat.isSymbolicLink() &&
    (process.platform === 'win32' ||
      ((typeof process.getuid !== 'function' || stat.uid === process.getuid()) &&
        (exact ? (stat.mode & 0o777) === 0o700 : (stat.mode & 0o022) === 0)));
}

function createOrPinPrivateChild(parent: string, name: string): string | null {
  const path = join(parent, name);
  let created = false;
  try {
    try {
      mkdirSync(path, { mode: 0o700 });
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return null;
    }
    if (!safeDirectory(parent) || !safeDirectory(path, true) ||
      realpathSync(path) !== join(realpathSync(parent), name) ||
      !assurePrivateStoragePath(path, 'directory', created ? 'secure-created' : 'inspect-existing', {
        anchorPath: parent,
      }).ok) return null;
    return path;
  } catch {
    return null;
  }
}

function safeFile(path: string): boolean {
  const stat = lstatSync(path);
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 &&
    (process.platform === 'win32' ||
      ((typeof process.getuid !== 'function' || stat.uid === process.getuid()) && (stat.mode & 0o077) === 0));
}

function sameFileIdentity(
  left: Stats,
  right: Stats,
): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.nlink === right.nlink;
}

function parseStoredMetadata(text: string, expectedKey: string): CortexRelayShadowMetadata | null {
  try {
    if (!text.endsWith('\n') || text.slice(0, -1).includes('\n')) return null;
    const value = JSON.parse(text) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const metadata = value as CortexRelayShadowMetadata;
    const { outcomeDigest, ...base } = metadata;
    const expectedDigest = `sha256:${createHash('sha256')
      .update(`ashlr:cortex-relay-shadow:outcome:v1\0${JSON.stringify(base)}`, 'utf8').digest('hex')}`;
    if (metadata.schemaVersion !== 1 ||
      metadata.protocol !== 'ashlr-cortex-relay-shadow-outcome/v1' ||
      metadata.mode !== 'shadow' || metadata.executionAuthority !== false ||
      metadata.proposalAuthority !== false || metadata.mergeAuthority !== false ||
      metadata.deployAuthority !== false || typeof metadata.accepted !== 'boolean' ||
      typeof metadata.reason !== 'string' || typeof metadata.observedAt !== 'string' ||
      !Number.isFinite(Date.parse(metadata.observedAt)) ||
      !/^sha256:[0-9a-f]{64}$/.test(metadata.inputDigest) ||
      outcomeDigest !== expectedDigest || recordKey(metadata) !== expectedKey ||
      JSON.stringify(metadata) !== text.slice(0, -1) ||
      metadata.effects?.agentsSpawned !== 0 || metadata.effects.proposalsCreated !== 0 ||
      metadata.effects.repositoriesMutated !== 0 || metadata.effects.merges !== 0 ||
      metadata.effects.deployments !== 0) return null;
    return metadata;
  } catch {
    return null;
  }
}

function readExistingMetadata(
  path: string,
  expectedKey: string,
  anchor: string,
): { state: 'missing' | 'invalid' | 'ok'; metadata?: CortexRelayShadowMetadata } {
  let fd: number | undefined;
  try {
    const before = lstatSync(path);
    if (!safeFile(path) || before.size < 2 || before.size > 64 * 1024 ||
      !assurePrivateStoragePath(path, 'file', 'inspect-existing', { anchorPath: anchor }).ok) {
      return { state: 'invalid' };
    }
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || !sameFileIdentity(before, opened)) {
      return { state: 'invalid' };
    }
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (read <= 0) return { state: 'invalid' };
      offset += read;
    }
    const after = fstatSync(fd);
    const namedAfter = lstatSync(path);
    if (!sameFileIdentity(opened, after) || !sameFileIdentity(opened, namedAfter) ||
      !assurePrivateStoragePath(path, 'file', 'inspect-existing', { anchorPath: anchor }).ok) {
      return { state: 'invalid' };
    }
    const text = bytes.toString('utf8');
    if (!bytes.equals(Buffer.from(text, 'utf8'))) return { state: 'invalid' };
    const metadata = parseStoredMetadata(text, expectedKey);
    return metadata ? { state: 'ok', metadata } : { state: 'invalid' };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { state: 'missing' }
      : { state: 'invalid' };
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new Error('shadow outcome write made no progress');
    offset += written;
  }
}

export function recordCortexRelayShadowOutcome(
  metadata: CortexRelayShadowMetadata,
  options: { root?: string } = {},
): CortexRelayShadowRecordResult {
  try {
    const anchor = anchorPath(options.root);
    if (!safeDirectory(anchor)) return { state: 'unavailable', metadata };
    const fleet = createOrPinPrivateChild(anchor, 'fleet');
    const dir = fleet ? createOrPinPrivateChild(fleet, 'cortex-relay-shadow') : null;
    if (!dir) return { state: 'unavailable', metadata };
    const key = recordKey(metadata);
    const path = join(dir, `${key}.json`);
    const existingRecord = readExistingMetadata(path, key, anchor);
    if (existingRecord.state === 'invalid') return { state: 'unavailable', metadata };
    if (existingRecord.state === 'ok') {
      const existing = existingRecord.metadata!;
      const sameAssignment = existing.assignmentDigest === metadata.assignmentDigest &&
        existing.inputDigest === metadata.inputDigest;
      return { state: sameAssignment ? 'duplicate' : 'conflict', metadata: existing };
    }

    let fd: number | undefined;
    try {
      fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT |
        fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
      fchmodSync(fd, 0o600);
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.nlink !== 1) throw new Error('unsafe shadow outcome file');
      writeAll(fd, Buffer.from(`${JSON.stringify(metadata)}\n`, 'utf8'));
      fsyncSync(fd);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    if (!safeFile(path) ||
      !assurePrivateStoragePath(path, 'file', 'secure-created', { anchorPath: anchor }).ok) {
      return { state: 'unavailable', metadata };
    }
    return { state: 'recorded', metadata };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return recordCortexRelayShadowOutcome(metadata, options);
    }
    return { state: 'unavailable', metadata };
  }
}

export interface ConsumeCortexRelayShadowResult {
  validation: CortexRelayShadowResult;
  receipt: CortexRelayShadowRecordResult;
}

/** The only integrated consumer in v1: validate, then persist metadata. It never executes work. */
export function consumeCortexRelayShadow(
  input: CortexRelayShadowInput,
  options: { root?: string } = {},
): ConsumeCortexRelayShadowResult {
  const validation = validateCortexRelayShadow(input);
  return {
    validation,
    receipt: recordCortexRelayShadowOutcome(validation.metadata, { root: options.root }),
  };
}

/** Vitest-only integrated seam for fixed-effect validation and receipt tests. */
export function _consumeCortexRelayShadowForTest(
  sentinel: symbol,
  input: CortexRelayShadowInput,
  options: {
    validation?: Partial<CortexRelayShadowDependencies>;
    root?: string;
  } = {},
): ConsumeCortexRelayShadowResult {
  if (sentinel !== CORTEX_RELAY_SHADOW_TEST_CONTROL || process.env.VITEST !== 'true') {
    throw new Error('invalid Cortex relay shadow test control');
  }
  const validation = _validateCortexRelayShadowForTest(
    sentinel,
    input,
    options.validation ?? {},
  );
  return {
    validation,
    receipt: recordCortexRelayShadowOutcome(validation.metadata, { root: options.root }),
  };
}
