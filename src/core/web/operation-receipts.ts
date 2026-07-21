/**
 * Durable, metadata-only idempotency receipts for local web mutations.
 *
 * Receipts intentionally never retain a request body, token, goal, environment,
 * filesystem path, or route response. A per-operation exclusive create is the
 * concurrency fence: a retry can replay a completed receipt but can never run
 * a second mutation while the original request is in progress.
 */

import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fsyncDirectory } from '../util/durability.js';

const MAX_OPERATION_ID_LENGTH = 64;
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROCESS_OWNER_ID = randomUUID();

export interface OperationReceipt {
  schemaVersion: 1;
  operationId: string;
  route: string;
  requestDigest: string;
  createdAt: string;
  state: 'pending' | 'completed';
  /** Identifies the server process that owns an active pending receipt. */
  ownerId?: string;
  statusCode?: number;
}

export type BeginOperationResult =
  | { kind: 'started'; receipt: OperationReceipt }
  | { kind: 'replay'; receipt: OperationReceipt }
  | { kind: 'conflict' }
  | { kind: 'in-progress' }
  | { kind: 'unknown-outcome'; receipt: OperationReceipt }
  | { kind: 'unavailable' };

type ReceiptReadResult =
  | { kind: 'missing' }
  | { kind: 'invalid' }
  | { kind: 'receipt'; receipt: OperationReceipt };

export interface OperationReceiptDurability {
  fsyncFile(fd: number): void;
  fsyncDirectory(path: string): void;
}

const DEFAULT_DURABILITY: OperationReceiptDurability = {
  fsyncFile: fs.fsyncSync,
  fsyncDirectory,
};
let durability: OperationReceiptDurability = DEFAULT_DURABILITY;

/** Test-only fault-injection seam for the crash-durability boundary. */
export function setOperationReceiptDurabilityForTest(
  overrides: Partial<OperationReceiptDurability>,
): () => void {
  const previous = durability;
  durability = { ...DEFAULT_DURABILITY, ...overrides };
  return () => { durability = previous; };
}

export function parseOperationId(value: string): string | null {
  const id = value.trim();
  return id.length <= MAX_OPERATION_ID_LENGTH && OPERATION_ID.test(id) ? id.toLowerCase() : null;
}

export function operationRequestDigest(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

function receiptDir(): string {
  return join(homedir(), '.ashlr', 'web-operation-receipts');
}

function receiptPath(operationId: string): string {
  return join(receiptDir(), `${operationId}.json`);
}

function loadReceipt(operationId: string): ReceiptReadResult {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(receiptPath(operationId), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return { kind: 'invalid' };
    const row = parsed as Partial<OperationReceipt>;
    if (row.schemaVersion !== 1 || row.operationId !== operationId || typeof row.route !== 'string' ||
      !/^[0-9a-f]{64}$/.test(row.requestDigest ?? '') || typeof row.createdAt !== 'string' ||
      (row.state !== 'pending' && row.state !== 'completed')) return { kind: 'invalid' };
    if (row.ownerId !== undefined && (typeof row.ownerId !== 'string' || row.ownerId.length > 128)) return { kind: 'invalid' };
    if (row.state === 'completed' && (!Number.isInteger(row.statusCode) || row.statusCode! < 100 || row.statusCode! > 599)) return { kind: 'invalid' };
    return { kind: 'receipt', receipt: row as OperationReceipt };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'missing' } : { kind: 'invalid' };
  }
}

function writeReceipt(receipt: OperationReceipt): boolean {
  const dest = receiptPath(receipt.operationId);
  const tmp = `${dest}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(receipt)}\n`, 'utf8');
    durability.fsyncFile(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, dest);
    durability.fsyncDirectory(dirname(dest));
    return true;
  } catch {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* best effort */ }
    return false;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* preserve the primary write failure */ }
    }
  }
}

function startResult(existing: OperationReceipt, route: string, requestDigest: string): BeginOperationResult {
  if (existing.route !== route || existing.requestDigest !== requestDigest) return { kind: 'conflict' };
  if (existing.state === 'completed') return { kind: 'replay', receipt: existing };
  // A pending receipt from another process (or a legacy receipt without an
  // owner) may have executed its side effect before the process stopped.
  // Never infer that it is safe to retry without route-specific reconciliation.
  if (existing.ownerId !== PROCESS_OWNER_ID) return { kind: 'unknown-outcome', receipt: existing };
  return { kind: 'in-progress' };
}

function ensureReceiptDirectory(): boolean {
  try {
    const dir = receiptDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // The parent sync durably records directory creation where the platform
    // supports it; the receipt directory sync validates the target itself.
    durability.fsyncDirectory(dirname(dir));
    durability.fsyncDirectory(dir);
    return true;
  } catch {
    return false;
  }
}

export function beginOperationReceipt(operationId: string, route: string, requestDigest: string): BeginOperationResult {
  const existing = loadReceipt(operationId);
  if (existing.kind === 'invalid') return { kind: 'unavailable' };
  if (existing.kind === 'receipt') return startResult(existing.receipt, route, requestDigest);
  if (!ensureReceiptDirectory()) return { kind: 'unavailable' };
  try {
    const receipt: OperationReceipt = {
      schemaVersion: 1, operationId, route, requestDigest, createdAt: new Date().toISOString(),
      state: 'pending', ownerId: PROCESS_OWNER_ID,
    };
    const fd = fs.openSync(receiptPath(operationId), 'wx', 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(receipt)}\n`, 'utf8');
      durability.fsyncFile(fd);
    } finally {
      fs.closeSync(fd);
    }
    durability.fsyncDirectory(receiptDir());
    return { kind: 'started', receipt };
  } catch (error) {
    // Only an exclusive-create race may safely consult the installed receipt.
    // A write, file-sync, or directory-sync failure leaves durability uncertain
    // and must fail this request closed rather than looking like an active run.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return { kind: 'unavailable' };
    const raced = loadReceipt(operationId);
    if (raced.kind === 'receipt') return startResult(raced.receipt, route, requestDigest);
    return { kind: 'unavailable' };
  }
}

export function completeOperationReceipt(receipt: OperationReceipt, statusCode: number): boolean {
  if (receipt.state !== 'pending' || !Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) return false;
  return writeReceipt({ ...receipt, state: 'completed', statusCode });
}
