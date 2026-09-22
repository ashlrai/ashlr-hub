/**
 * The ownership record: what we know about the llama-server we started.
 *
 * Written at spawn time, read on the next start, deleted on a clean stop. It
 * is the only thing that survives a crash, so it is deliberately minimal —
 * two numbers, a handful of paths and an argv. There is no field a credential
 * could hide in, and the round-trip test pins that.
 *
 * Reading never throws: a missing, truncated, foreign or hand-edited record is
 * simply "no record", which degrades the supervisor to the unmanaged path
 * rather than taking the CLI down.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { writePrivateFileAtomically } from '../../util/private-file-write.js';
import { localRuntimeDir, ownershipRecordPath } from './paths.js';
import type { LlamaOwnershipRecord, LlamaRuntimeOwner } from './types.js';

/** A record larger than this is not one of ours; refuse to parse it. */
const MAX_RECORD_BYTES = 64 * 1024;

const OWNERS: readonly LlamaRuntimeOwner[] = ['cli', 'launchd', 'adopted'];

/**
 * Validate an untrusted parsed value into a record.
 *
 * Exported because the shape check is the security boundary: a record that
 * fails here is discarded, and a discarded record can never become a kill
 * decision. Pure, so it is unit-testable without touching the filesystem.
 */
export function parseOwnershipRecord(value: unknown): LlamaOwnershipRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;

  if (raw['schemaVersion'] !== 1) return null;

  const pid = raw['pid'];
  const port = raw['port'];
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 1) return null;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) return null;

  const host = raw['host'];
  const binPath = raw['binPath'];
  const modelPath = raw['modelPath'];
  const startedAt = raw['startedAt'];
  if (typeof host !== 'string' || host.length === 0) return null;
  if (typeof binPath !== 'string' || binPath.length === 0) return null;
  if (typeof modelPath !== 'string' || modelPath.length === 0) return null;
  if (typeof startedAt !== 'string' || Number.isNaN(Date.parse(startedAt))) return null;

  const owner = raw['owner'];
  if (typeof owner !== 'string' || !OWNERS.includes(owner as LlamaRuntimeOwner)) return null;

  const args = raw['args'];
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) return null;

  const modelRefRaw = raw['modelRef'];
  const modelRef = typeof modelRefRaw === 'string' && modelRefRaw.length > 0 ? modelRefRaw : null;

  const requestedSlots = raw['requestedSlots'];
  const requestedContext = raw['requestedContext'];

  return {
    schemaVersion: 1,
    pid,
    port,
    host,
    binPath,
    modelPath,
    modelRef,
    args: args as string[],
    requestedSlots:
      typeof requestedSlots === 'number' && Number.isFinite(requestedSlots) ? requestedSlots : 0,
    requestedContext:
      typeof requestedContext === 'number' && Number.isFinite(requestedContext)
        ? requestedContext
        : 0,
    startedAt,
    owner: owner as LlamaRuntimeOwner,
  };
}

/** Read the ownership record, or null when there is not a valid one. Never throws. */
export function readOwnershipRecord(path = ownershipRecordPath()): LlamaOwnershipRecord | null {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) return null;
    return parseOwnershipRecord(JSON.parse(readFileSync(path, 'utf8')) as unknown);
  } catch {
    return null;
  }
}

/**
 * Persist the ownership record atomically, 0600, fsynced.
 *
 * Returns false rather than throwing: failing to record ownership is a
 * degradation (the next start cannot reclaim automatically), not a reason to
 * kill a server that is already serving correctly.
 */
export function writeOwnershipRecord(
  record: LlamaOwnershipRecord,
  path = ownershipRecordPath(),
): boolean {
  try {
    const dir = localRuntimeDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temporaryPath = join(dir, `.llama-server.${randomUUID()}.tmp`);
    writePrivateFileAtomically(temporaryPath, path, `${JSON.stringify(record, null, 2)}\n`, {
      anchorPath: dir,
      label: 'local-runtime ownership record',
    });
    return true;
  } catch {
    return false;
  }
}

/** Forget the recorded runtime. Idempotent; never throws. */
export function clearOwnershipRecord(path = ownershipRecordPath()): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // Nothing to forget, or the file is not ours to remove.
  }
}

/** Move a record aside without destroying it, for a corrupt-state postmortem. */
export function quarantineOwnershipRecord(path = ownershipRecordPath()): string | null {
  try {
    const target = `${path}.stale-${new Date().toISOString().replace(/[:.]/g, '')}`;
    renameSync(path, target);
    return target;
  } catch {
    return null;
  }
}
