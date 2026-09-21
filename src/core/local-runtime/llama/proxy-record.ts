/**
 * The Anthropic proxy's ownership record — record.ts, for the second process.
 *
 * Written when the detached proxy host is spawned, read on the next start,
 * deleted on a clean stop. Everything record.ts says applies here verbatim: it
 * is the only thing that survives a crash, it is deliberately minimal, there is
 * no field a credential could hide in, and reading NEVER throws — a missing,
 * truncated, foreign or hand-edited record is simply "no record", which
 * degrades the supervisor to the unmanaged path rather than taking the CLI
 * down.
 *
 * It is a sibling of record.ts rather than an extension of it because the two
 * describe processes with independent lifetimes. Folding the proxy into
 * llama-server's record would make every field optional, and an optional field
 * in a shape check that gates a kill decision is exactly the wrong place for
 * ambiguity.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { writePrivateFileAtomically } from '../../util/private-file-write.js';
import { anthropicProxyRecordPath, localRuntimeDir } from './paths.js';
import type { AnthropicProxyOwnershipRecord, LlamaRuntimeOwner } from './types.js';

/** A record larger than this is not one of ours; refuse to parse it. */
const MAX_RECORD_BYTES = 64 * 1024;

const OWNERS: readonly LlamaRuntimeOwner[] = ['cli', 'launchd', 'adopted'];

/**
 * Validate an untrusted parsed value into a proxy record.
 *
 * Exported because the shape check is the security boundary: a record that
 * fails here is discarded, and a discarded record can never become a kill
 * decision. Pure, so it is unit-testable without touching the filesystem.
 */
export function parseAnthropicProxyRecord(value: unknown): AnthropicProxyOwnershipRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;

  if (raw['schemaVersion'] !== 1) return null;

  const pid = raw['pid'];
  const port = raw['port'];
  const upstreamPort = raw['upstreamPort'];
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 1) return null;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
  if (
    typeof upstreamPort !== 'number' ||
    !Number.isInteger(upstreamPort) ||
    upstreamPort < 1 ||
    upstreamPort > 65_535
  ) {
    return null;
  }

  const host = raw['host'];
  const execPath = raw['execPath'];
  const upstreamOrigin = raw['upstreamOrigin'];
  const startedAt = raw['startedAt'];
  if (typeof host !== 'string' || host.length === 0) return null;
  if (typeof execPath !== 'string' || execPath.length === 0) return null;
  if (typeof upstreamOrigin !== 'string' || upstreamOrigin.length === 0) return null;
  if (typeof startedAt !== 'string' || Number.isNaN(Date.parse(startedAt))) return null;

  const owner = raw['owner'];
  if (typeof owner !== 'string' || !OWNERS.includes(owner as LlamaRuntimeOwner)) return null;

  return {
    schemaVersion: 1,
    pid,
    port,
    host,
    execPath,
    upstreamPort,
    upstreamOrigin,
    startedAt,
    owner: owner as LlamaRuntimeOwner,
  };
}

/** Read the proxy record, or null when there is not a valid one. Never throws. */
export function readAnthropicProxyRecord(
  path = anthropicProxyRecordPath(),
): AnthropicProxyOwnershipRecord | null {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) return null;
    return parseAnthropicProxyRecord(JSON.parse(readFileSync(path, 'utf8')) as unknown);
  } catch {
    return null;
  }
}

/**
 * Persist the proxy record atomically, 0600, fsynced.
 *
 * Returns false rather than throwing: failing to record ownership is a
 * degradation (the next start cannot reclaim automatically), not a reason to
 * kill a proxy that is already forwarding correctly.
 */
export function writeAnthropicProxyRecord(
  record: AnthropicProxyOwnershipRecord,
  path = anthropicProxyRecordPath(),
): boolean {
  try {
    const dir = localRuntimeDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temporaryPath = join(dir, `.anthropic-proxy.${randomUUID()}.tmp`);
    writePrivateFileAtomically(temporaryPath, path, `${JSON.stringify(record, null, 2)}\n`, {
      anchorPath: dir,
      label: 'local-runtime anthropic proxy ownership record',
    });
    return true;
  } catch {
    return false;
  }
}

/** Forget the recorded proxy. Idempotent; never throws. */
export function clearAnthropicProxyRecord(path = anthropicProxyRecordPath()): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // Nothing to forget, or the file is not ours to remove.
  }
}

/** Move a record aside without destroying it, for a corrupt-state postmortem. */
export function quarantineAnthropicProxyRecord(path = anthropicProxyRecordPath()): string | null {
  try {
    const target = `${path}.stale-${new Date().toISOString().replace(/[:.]/g, '')}`;
    renameSync(path, target);
    return target;
  } catch {
    return null;
  }
}
