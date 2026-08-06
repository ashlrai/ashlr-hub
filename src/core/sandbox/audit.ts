/**
 * M21: Append-only audit trail for autonomous/sandbox actions.
 *
 * Writes to ~/.ashlr/audit/<YYYY-MM-DD>.jsonl — one JSON object per line.
 * Rules:
 *   - Append-only: never truncate, never rewrite, never delete a prior line.
 *   - Never write secrets: summary is metadata only; secret-shaped tokens are
 *     stripped defensively before persisting.
 *   - audit() never throws; readAudit() skips malformed lines, never throws.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  readFileSync,
  writeSync,
} from 'node:fs';
import type { AuditEntry } from '../types.js';
import { scrubSecrets } from '../util/scrub.js';
import { fsyncDirectory } from '../util/durability.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';

const O_NOFOLLOW = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
const MAX_AUDIT_TAIL_BYTES = 64 * 1024;

// ---------------------------------------------------------------------------
// Public: auditDir()
// ---------------------------------------------------------------------------

/**
 * Returns the absolute path to the audit directory: ~/.ashlr/audit.
 * Created lazily by audit() — this function itself does NOT create it.
 */
export function auditDir(): string {
  return join(homedir(), '.ashlr', 'audit');
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Current date as YYYY-MM-DD (UTC) for the daily file name. */
function todayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Defensively strip secret-shaped tokens from a summary string before
 * persisting. Targets common patterns: long hex strings, bearer tokens,
 * base64-looking blobs, and key=value pairs that look like credentials.
 *
 * This is a best-effort guardrail — the contract says "summary is metadata
 * only, never secrets"; callers are the primary enforcement point.
 */
function stripSecrets(summary: string): string {
  return scrubSecrets(summary);
}

function metadata(value: string): string {
  return stripSecrets(value).slice(0, 256);
}

function digestMetadata(value: string): string {
  return /^[a-f0-9]{64}$/.test(value) ? value : '[INVALID-DIGEST]';
}

function owned(uid: number | bigint): boolean {
  return typeof process.getuid !== 'function' || BigInt(uid) === BigInt(process.getuid());
}

function exactDirectory(path: string): { dev: bigint; ino: bigint } | null {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || !owned(stat.uid) ||
    (process.platform !== 'win32' && (stat.mode & 0o777n) !== 0o700n)) return null;
  return { dev: stat.dev, ino: stat.ino };
}

function assureExactDirectory(path: string): { dev: bigint; ino: bigint } | null {
  try {
    if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
    const before = lstatSync(path, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink() || !owned(before.uid)) return null;
    if (process.platform !== 'win32') chmodSync(path, 0o700);
    const after = exactDirectory(path);
    return after && after.dev === before.dev && after.ino === before.ino ? after : null;
  } catch {
    return null;
  }
}

function parseAuditLine(line: string): AuditEntry | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    return typeof obj['ts'] === 'string' &&
      typeof obj['action'] === 'string' &&
      typeof obj['summary'] === 'string' &&
      (obj['result'] === 'ok' || obj['result'] === 'refused' || obj['result'] === 'error')
      ? obj as unknown as AuditEntry
      : null;
  } catch {
    return null;
  }
}

function readAuditTail(fd: number, size: bigint): AuditEntry | null {
  if (size <= 0n || size > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const bytesToRead = Math.min(Number(size), MAX_AUDIT_TAIL_BYTES);
  const buffer = Buffer.allocUnsafe(bytesToRead);
  let offset = 0;
  while (offset < bytesToRead) {
    const read = readSync(fd, buffer, offset, bytesToRead - offset, Number(size) - bytesToRead + offset);
    if (read <= 0) return null;
    offset += read;
  }
  if (buffer[buffer.length - 1] !== 0x0a) return null;
  const content = buffer.subarray(0, -1);
  const previousNewline = content.lastIndexOf(0x0a);
  if (previousNewline < 0 && Number(size) > bytesToRead) return null;
  const line = content.subarray(previousNewline + 1).toString('utf8');
  return line.trim() ? parseAuditLine(line) : null;
}

function appendDurably(filePath: string, record: AuditEntry, directoryPath: string): boolean {
  let fd: number | null = null;
  try {
    const directoryIdentity = exactDirectory(directoryPath);
    if (!directoryIdentity) return false;
    fd = openSync(
      filePath,
      fsConstants.O_RDWR | fsConstants.O_APPEND | fsConstants.O_CREAT | O_NOFOLLOW,
      0o600,
    );
    if (process.platform !== 'win32') fchmodSync(fd, 0o600);
    const opened = fstatSync(fd, { bigint: true });
    const named = lstatSync(filePath, { bigint: true });
    if (!opened.isFile() || opened.isSymbolicLink() || !named.isFile() || named.isSymbolicLink() ||
      !owned(opened.uid) || !owned(named.uid) || opened.nlink !== 1n || named.nlink !== 1n ||
      opened.dev !== named.dev || opened.ino !== named.ino ||
      (process.platform !== 'win32' &&
        ((opened.mode & 0o777n) !== 0o600n || (named.mode & 0o777n) !== 0o600n))) return false;
    if (opened.size > 0n && readAuditTail(fd, opened.size) === null) return false;
    const directoryBeforeWrite = exactDirectory(directoryPath);
    if (!directoryBeforeWrite || directoryBeforeWrite.dev !== directoryIdentity.dev ||
      directoryBeforeWrite.ino !== directoryIdentity.ino) return false;

    const bytes = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset, null);
      if (written <= 0) return false;
      offset += written;
    }
    fsyncSync(fd);

    const openedAfter = fstatSync(fd, { bigint: true });
    const namedAfter = lstatSync(filePath, { bigint: true });
    const directoryAfter = exactDirectory(directoryPath);
    if (!directoryAfter || directoryAfter.dev !== directoryIdentity.dev ||
      directoryAfter.ino !== directoryIdentity.ino ||
      openedAfter.dev !== opened.dev || openedAfter.ino !== opened.ino ||
      namedAfter.dev !== opened.dev || namedAfter.ino !== opened.ino || namedAfter.isSymbolicLink()) return false;
    const persisted = readAuditTail(fd, openedAfter.size);
    if (!persisted || persisted.eventId !== record.eventId) return false;
    closeSync(fd);
    fd = null;
    fsyncDirectory(directoryPath, { expectedIdentity: directoryIdentity });
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Public: audit()
// ---------------------------------------------------------------------------

/**
 * Append one audit entry to today's JSONL file under ~/.ashlr/audit/.
 * Sets `ts` to the current ISO timestamp; the caller supplies everything else.
 *
 * Append-only: never truncates, never rewrites existing lines.
 * Never throws. Returns the persisted record, or null when append failed.
 */
export function audit(
  entry: Omit<AuditEntry, 'ts' | 'schemaVersion' | 'eventId'>,
): AuditEntry | null {
  try {
    const dir = auditDir();
    const root = join(homedir(), '.ashlr');

    if (!assureExactDirectory(root) || !assureExactDirectory(dir)) return null;

    const record: AuditEntry = {
      schemaVersion: 2,
      eventId: randomUUID(),
      ts: new Date().toISOString(),
      action: entry.action,
      repo: entry.repo,
      sandboxId: entry.sandboxId,
      // Strip secret-shaped tokens defensively; summary is metadata only.
      summary: stripSecrets(entry.summary),
      result: entry.result,
      ...(entry.actor
        ? {
            actor: {
              id: metadata(entry.actor.id),
              type: entry.actor.type,
              role: metadata(entry.actor.role),
            },
          }
        : {}),
      ...(entry.authority
        ? {
            authority: {
              method: metadata(entry.authority.method),
              capability: metadata(entry.authority.capability),
              policyVersion: metadata(entry.authority.policyVersion),
              decision: entry.authority.decision,
              reasonCode: metadata(entry.authority.reasonCode),
            },
          }
        : {}),
      ...(entry.mutation
        ? {
            mutation: {
              reservationId: digestMetadata(entry.mutation.reservationId),
              idempotencyKeyHash: digestMetadata(entry.mutation.idempotencyKeyHash),
              requestDigest: digestMetadata(entry.mutation.requestDigest),
              method: metadata(entry.mutation.method),
              pathHash: digestMetadata(entry.mutation.pathHash),
              phase: entry.mutation.phase,
              ...(entry.mutation.outcome ? { outcome: entry.mutation.outcome } : {}),
              ...(entry.mutation.status !== undefined ? { status: entry.mutation.status } : {}),
            },
          }
        : {}),
    };

    const filePath = join(dir, `${todayDateString()}.jsonl`);

    const lock = acquireLocalStoreLock(join(dir, '.append.lock'), 2_000, {
      anchorPath: dir,
      exactPrivateStorage: true,
    });
    if (!lock) return null;
    try {
      return appendDurably(filePath, record, dir) ? record : null;
    } finally {
      releaseLocalStoreLock(lock);
    }
  } catch {
    // Intentionally swallowed: audit must never disrupt the caller's flow.
    return null;
  }
}

// ---------------------------------------------------------------------------
// M52: auditConfinement() — typed confinement audit event
// ---------------------------------------------------------------------------

/**
 * Append a `confinement` audit event for a contained engine run.
 *
 * Fields:
 *   engine       — the EngineId being contained.
 *   mode         — 'off' | 'os' (the resolved profile mode).
 *   networkEgress — whether outbound network was permitted.
 *   readAllowed  — extra read-allowed paths (if any).
 *   platform     — process.platform at the time of the run.
 *   launched     — true when an OS jail launcher was actually built (false = env-only fallback).
 *   fallback     — true when launched:false but mode was 'os' (i.e. unsupported platform, fallback).
 *
 * Delegates to audit() — append-only, never throws.
 */
export function auditConfinement(event: {
  engine: string;
  mode: string;
  networkEgress: boolean;
  readAllowed?: string[];
  platform: string;
  launched: boolean;
  fallback?: boolean;
  /** Worktree path (used as `repo`). */
  worktree: string;
  /** Sandbox id (or null). */
  sandboxId: string | null;
}): void {
  audit({
    action: 'confinement.run',
    repo: event.worktree,
    sandboxId: event.sandboxId,
    summary: [
      `engine=${event.engine}`,
      `mode=${event.mode}`,
      `platform=${event.platform}`,
      `launched=${event.launched}`,
      `networkEgress=${event.networkEgress}`,
      event.fallback ? 'fallback=true' : '',
      event.readAllowed?.length ? `readAllowed=${event.readAllowed.length}` : '',
    ].filter(Boolean).join(' '),
    result: 'ok',
  });
}

// ---------------------------------------------------------------------------
// Public: readAudit()
// ---------------------------------------------------------------------------

/**
 * Read audit entries across all date files, newest-first.
 * `limit` caps the number returned (undefined or 0 => return all).
 *
 * Malformed JSONL lines are silently skipped; never throws.
 */
export function readAudit(limit?: number): AuditEntry[] {
  try {
    const dir = auditDir();

    if (!existsSync(dir)) {
      return [];
    }

    // List all .jsonl files, sort descending (newest date first).
    let files: string[];
    try {
      files = readdirSync(dir)
        .filter((f) => f.endsWith('.jsonl'))
        .sort()
        .reverse();
    } catch {
      return [];
    }

    const entries: AuditEntry[] = [];
    const cap = limit !== undefined && limit > 0 ? limit : Infinity;

    for (const file of files) {
      if (entries.length >= cap) break;

      const filePath = join(dir, file);
      let raw: string;
      try {
        raw = readFileSync(filePath, 'utf8');
      } catch {
        continue; // unreadable file — skip
      }

      // Collect lines in reverse order so newest entries within the file come first.
      const lines = raw.split('\n').filter((l) => l.trim() !== '').reverse();

      for (const line of lines) {
        if (entries.length >= cap) break;

        const parsed = parseAuditLine(line);
        if (parsed) entries.push(parsed);
      }
    }

    return entries;
  } catch {
    // Top-level guard: readAudit must never throw.
    return [];
  }
}
